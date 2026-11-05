/**
 * POST /api/training-test-run
 * 训练配置测试跑脚本 - 模拟学生自动完成整条训练对话（SSE）
 *
 * 走平台 HTTP 接口：
 *   POST /ai-tools/trainRun/runCard  { taskId, stepId, sessionId? }
 *   POST /ai-tools/trainRun/chat     { taskId, stepId, text, sessionId }
 * 与 Hike Teaching Center 插件的基础版/口语训练测试逻辑一致。
 */

import { NextRequest } from "next/server";
import { MODEL_NAME_MAPPING } from "@/lib/config";
import { callLLM } from "@/lib/llm/utils";
import {
    getScriptNodes,
    queryScriptSteps,
    queryTrainingTaskConfiguration,
    resolveCloudapiRoot,
} from "@/lib/training-injector/api";
import type { PolymasCredentials, PolymasScriptStep } from "@/lib/training-injector/types";

export const maxDuration = 300;
export const runtime = "nodejs";

const TESTABLE_TYPES = new Set(["ability", "oral"]);
const DEFAULT_MAX_ROUNDS_PER_STAGE = 10;
const PLATFORM_TIMEOUT_MS = 120_000;
const MAX_REPLY_LENGTH = 200;

interface StudentProfile {
    label: string;
    description: string;
    style: string;
    fallbackHint: string;
}

const STUDENT_PROFILES: Record<string, StudentProfile> = {
    good: {
        label: "优秀学生",
        description: "理解透彻、表达清晰，回答结构化、条理分明，并主动总结要点。",
        style: "语气自信、语言规范，必要时引用题目或材料中的关键信息。",
        fallbackHint: "没有合适示例时，自己组织最佳答案，保持高水平。",
    },
    guided: {
        label: "需要引导的学生",
        description: "基本理解问题但不够全面，回答中会暴露疑惑或请求提示。",
        style: "语气略显犹豫，能覆盖核心内容，但会提出 1-2 个不确定点或寻求老师建议。",
        fallbackHint: "示例缺失时，先回答主要内容再说明不确定之处。",
    },
    offtopic: {
        label: "答非所问的学生",
        description: "理解偏差，常常跑题或只复述与问题弱相关的信息。",
        style: "语气随意，容易偏离重点或答非所问。",
        fallbackHint: "即使需要自己生成，也要保持轻微跑题或误解的特征。",
    },
};

const BASE_STUDENT_PROMPT = [
    "你是一名能力训练助手，需要严格按照给定的学生档位扮演角色。",
    "",
    "## 问题类型识别（优先级最高）",
    "如果当前问题属于封闭式问题（确认式、选择式、角色确认），直接简短回答，不需要体现性格特点。",
    "",
    "## 输出要求",
    "1. 封闭式问题直接简短回答。",
    "2. 只输出学生回答内容，不要添加角色标签、解释或旁白。",
    "3. 回复语言与训练师提问保持一致；口语训练用自然口语短句，避免书面长句。",
    `4. 单次回答控制在 ${MAX_REPLY_LENGTH} 字以内。`,
].join("\n");

interface RunCardResult {
    sessionId?: string;
    text?: string;
    nextStepId?: string | null;
    needSkipStep?: boolean;
}

interface ChatResult {
    sessionId?: string;
    text?: string;
    nextStepId?: string | null;
}

interface TranscriptMessage {
    role: "assistant" | "user";
    content: string;
    stepId: string;
    stepName: string;
    round: number;
    source: "runCard" | "chat";
}

const STAGE_TRANSITION_PATTERN =
    /^(好的[，,]?\s*)?(那(么)?[，,]?\s*)?(接下来|下面)(我们)?(将)?\s*(进入|开始)(下一|下一个|下个)阶段[。.!！]?$/;

function stripStageTransition(text: string): string {
    const lines = String(text || "")
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(
            (line) =>
                line &&
                !STAGE_TRANSITION_PATTERN.test(line) &&
                !STAGE_TRANSITION_PATTERN.test(line.replace(/^.*?[。.!！]\s*/, ""))
        );
    return lines.join("\n").trim();
}

function sanitizeStudentReply(raw: string): string {
    let text = String(raw || "").trim();
    text = text.replace(/^(学生|用户|user)\s*[:：]\s*/i, "");
    text = text.replace(/^["“]([\s\S]*)["”]$/, "$1").trim();
    if (STAGE_TRANSITION_PATTERN.test(text)) return "";
    if (text.length > MAX_REPLY_LENGTH) text = text.slice(0, MAX_REPLY_LENGTH).trim();
    return text;
}

function buildStageContext(
    taskName: string,
    taskDescription: string,
    step: PolymasScriptStep
): string {
    const detail = step.stepDetailDTO || ({} as PolymasScriptStep["stepDetailDTO"]);
    const lines: string[] = [];
    if (taskName || taskDescription) {
        lines.push("## 实训任务", taskDescription ? `${taskName}：${taskDescription}` : taskName, "");
    }
    if (detail.stepName || detail.description) {
        lines.push("## 当前阶段", `${detail.stepName}：${detail.description || ""}`, "");
    }
    if (detail.llmPrompt) {
        lines.push("## 场景背景（仅供理解，不得改变你的学生身份或立场）", detail.llmPrompt, "");
    }
    return lines.join("\n");
}

function buildStudentSystemPrompt(
    profile: StudentProfile,
    context: string,
    reference = ""
): string {
    const lines = [
        BASE_STUDENT_PROMPT,
        "",
        "## 当前扮演设定",
        `学生档位: ${profile.label}`,
        `角色特征: ${profile.description}`,
        `表达风格: ${profile.style}`,
        `兜底要求: ${profile.fallbackHint}`,
        "",
    ];
    if (context) lines.push(context);
    if (reference) {
        lines.push(
            "## 参考对话（根据本阶段剧本预生成，仅供表达参考）",
            reference,
            "",
            "作答时可以借鉴上述对话的用词、句式和推进节奏，但必须以训练师当前提问为准，",
            "不要照抄整段，不要输出 Step/AI/用户 标签，也不要改变自己的学生档位。",
            ""
        );
    }
    lines.push("## 回复规则", "你将收到训练师的提问，请直接以学生身份回复。", "仅输出学生回答内容。");
    return lines.join("\n");
}

function stripCodeFence(text: string): string {
    return String(text || "")
        .trim()
        .replace(/^```[a-zA-Z]*\s*/, "")
        .replace(/```$/, "")
        .trim();
}

function buildReferencePrompt(
    profile: StudentProfile,
    taskName: string,
    taskDescription: string,
    step: PolymasScriptStep,
    index: number,
    total: number
): { systemPrompt: string; userPrompt: string } {
    const detail = step.stepDetailDTO || ({} as PolymasScriptStep["stepDetailDTO"]);
    const stepName = String(detail.stepName || step.stepId);
    const rounds = Math.max(1, Math.min(Number(detail.interactiveRounds) || 2, 4));
    const systemPrompt = [
        "你是训练剧本模拟对话生成器。",
        "根据给定的阶段配置生成“历史对话日志风格”的纯净文本。",
        "只输出日志内容，不要输出解释、标题、代码块、分析或额外说明。",
        "每条对话块必须严格使用以下格式：",
        `Step: <stepName> | step_id: <stepId> | 第 <n> 轮 | 来源: chat`,
        "AI: <智能体话术>",
        "用户: <学生回答>",
        "----------------------------------------",
        `生成 1 到 ${rounds} 轮，不能超过 ${rounds} 轮。`,
        `学生档位：${profile.label}（${profile.description}；${profile.style}）`,
    ].join("\n");
    const userPrompt = [
        `当前只生成第 ${index + 1}/${total} 阶段，禁止输出其他阶段。`,
        "",
        "阶段配置：",
        `stepId: ${step.stepId}`,
        `stepName: ${stepName}`,
        `trainerName: ${detail.trainerName || "未提供"}`,
        `interactiveRounds: ${detail.interactiveRounds ?? "未提供"}`,
        `prologue: ${detail.prologue || "(无)"}`,
        `description: ${detail.description || "(无)"}`,
        `llmPrompt: ${detail.llmPrompt || "(无)"}`,
        "",
        taskName || taskDescription
            ? `实训任务：${taskDescription ? `${taskName}：${taskDescription}` : taskName}`
            : "",
        "",
        "要求：AI 话术贴合阶段设定与开场白；用户回答符合学生档位并围绕阶段目标推进。",
        "Step 行中的 stepName 与 step_id 必须使用上方真实值。",
    ]
        .filter(Boolean)
        .join("\n");
    return { systemPrompt, userPrompt };
}

async function generateReferenceDialogue(
    profile: StudentProfile,
    taskName: string,
    taskDescription: string,
    step: PolymasScriptStep,
    index: number,
    total: number,
    llm: { apiKey: string; baseUrl: string; model: string }
): Promise<string> {
    const { systemPrompt, userPrompt } = buildReferencePrompt(
        profile,
        taskName,
        taskDescription,
        step,
        index,
        total
    );
    try {
        const raw = await callLLM(userPrompt, llm, 0.3, systemPrompt);
        return stripCodeFence(raw).slice(0, 4000);
    } catch {
        return "";
    }
}

function buildStudentUserPrompt(aiQuestion: string, history: TranscriptMessage[]): string {
    const lines: string[] = [];
    const pairs = history.slice(-8);
    if (pairs.length > 0) {
        lines.push("## 本阶段历史对话");
        for (const item of pairs) {
            lines.push(`${item.role === "assistant" ? "训练师" : "学生"}: ${item.content}`);
        }
        lines.push("");
    }
    lines.push("## 训练师当前提问", stripStageTransition(aiQuestion) || "（无提问，请主动推进本阶段任务）");
    return lines.join("\n");
}

function sortScriptNodes(nodes: PolymasScriptStep[]): PolymasScriptStep[] {
    return [...nodes].sort((a, b) => {
        const ax = Number(a.positionDTO?.x);
        const bx = Number(b.positionDTO?.x);
        const aValue = Number.isFinite(ax) ? ax : 0;
        const bValue = Number.isFinite(bx) ? bx : 0;
        return aValue - bValue;
    });
}

async function platformPost<T>(
    baseUrl: string,
    apiPath: string,
    payload: Record<string, unknown>,
    credentials: PolymasCredentials,
    origin: string
): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PLATFORM_TIMEOUT_MS);
    try {
        const headers: Record<string, string> = {
            "Content-Type": "application/json; charset=utf-8",
            Cookie: credentials.cookie,
            Origin: origin,
            "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        };
        if (credentials.authorization) headers.Authorization = credentials.authorization;
        const response = await fetch(`${baseUrl}${apiPath}`, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        const text = await response.text();
        let json: unknown = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            throw new Error(`平台返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
        }
        if (!response.ok) {
            throw new Error(`平台接口失败 HTTP ${response.status}：${text.slice(0, 200)}`);
        }
        const result = json as { success?: boolean; code?: number; msg?: string; data?: T };
        if (result?.success === false || (typeof result?.code === "number" && result.code !== 200)) {
            throw new Error(result.msg || `平台接口返回失败：${text.slice(0, 200)}`);
        }
        return (result?.data ?? null) as T;
    } finally {
        clearTimeout(timer);
    }
}

export async function POST(request: NextRequest) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            const send = (event: Record<string, unknown>) => {
                try {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                } catch {
                    // 忽略已关闭的 stream
                }
            };

            try {
                const body = await request.json();
                const taskId = String(body.taskId || "").trim();
                const type = String(body.type || "oral").trim() as "ability" | "oral" | "pro";
                const credentials = (body.credentials || {}) as PolymasCredentials;
                const studentKey = String(body.studentProfile || "good").trim();
                const profile = STUDENT_PROFILES[studentKey] || STUDENT_PROFILES.good;
                const useReferenceDialogue = body.useReferenceDialogue !== false;
                const maxRoundsPerStage = Math.max(
                    1,
                    Math.min(30, Number(body.maxRoundsPerStage) || DEFAULT_MAX_ROUNDS_PER_STAGE)
                );

                if (!taskId) throw new Error("缺少 taskId");
                if (!credentials.cookie) throw new Error("缺少平台 Cookie");
                if (type === "pro") {
                    throw new Error("Pro 训练暂不支持 HTTP 自动测试（走页面内 WebSocket），当前仅支持基础版/口语训练");
                }
                if (!TESTABLE_TYPES.has(type)) throw new Error(`不支持的训练类型：${type}`);

                const apiBase = resolveCloudapiRoot({ apiOrigin: credentials.apiOrigin });
                const origin = String(body.uiBaseUrl || "https://hike-teaching-center.polymas.com").replace(/\/+$/, "");

                send({ type: "status", message: "读取训练阶段..." });
                const [steps, configuration] = await Promise.all([
                    queryScriptSteps(taskId, { ...credentials, trainSubType: type }),
                    queryTrainingTaskConfiguration({ trainTaskId: taskId }, {
                        ...credentials,
                        trainSubType: type,
                    }).catch(() => null),
                ]);
                const scriptNodes = sortScriptNodes(getScriptNodes(steps));
                if (scriptNodes.length === 0) throw new Error("未读取到可测试的训练阶段（可能仅有 START/END）");

                const taskName = String(configuration?.trainTaskName || "").trim();
                const taskDescription = String(configuration?.description || "").trim();

                const apiKey = String(body.apiKey || process.env.LLM_API_KEY || "").trim();
                const baseUrl = String(body.apiUrl || process.env.LLM_BASE_URL || "").trim();
                const rawModel = String(body.model || process.env.LLM_MODEL || "gpt-5.6-sol").trim();
                const model = MODEL_NAME_MAPPING[rawModel] || rawModel;
                if (!baseUrl) throw new Error("未配置模拟学生所用的 LLM 地址（LLM_BASE_URL）");

                const transcript: TranscriptMessage[] = [];
                let sessionId = "";
                let stepIndex = 0;
                let totalRounds = 0;
                let completed = false;
                const maxTotalRounds = maxRoundsPerStage * scriptNodes.length;

                while (stepIndex < scriptNodes.length) {
                    const step = scriptNodes[stepIndex];
                    const detail = step.stepDetailDTO;
                    const stepName = String(detail?.stepName || step.stepId);
                    let round = 0;

                    send({
                        type: "stage_start",
                        stepId: step.stepId,
                        stepName,
                        index: stepIndex + 1,
                        total: scriptNodes.length,
                    });

                    let reference = "";
                    if (useReferenceDialogue) {
                        send({ type: "status", message: `生成「${stepName}」参考对话...` });
                        reference = await generateReferenceDialogue(
                            profile,
                            taskName,
                            taskDescription,
                            step,
                            stepIndex,
                            scriptNodes.length,
                            { apiKey, baseUrl, model }
                        );
                        if (reference) {
                            send({ type: "reference", stepId: step.stepId, stepName, content: reference });
                        }
                    }

                    const card = await platformPost<RunCardResult>(
                        apiBase,
                        "/ai-tools/trainRun/runCard",
                        { taskId, stepId: step.stepId, sessionId: sessionId || undefined },
                        credentials,
                        origin
                    );
                    if (!card?.sessionId) throw new Error(`阶段「${stepName}」启动失败：未返回 sessionId`);
                    sessionId = card.sessionId;

                    let aiText = String(card.text || "").trim();
                    if (aiText) {
                        transcript.push({
                            role: "assistant",
                            content: aiText,
                            stepId: step.stepId,
                            stepName,
                            round: 0,
                            source: "runCard",
                        });
                        send({
                            type: "message",
                            role: "assistant",
                            text: aiText,
                            stepId: step.stepId,
                            stepName,
                            round: 0,
                            source: "runCard",
                        });
                    }

                    let nextStepId = card.nextStepId || null;
                    let skipped = Boolean(card.needSkipStep && nextStepId);

                    let stageHistory = transcript.filter((item) => item.stepId === step.stepId);

                    while (!skipped && round < maxRoundsPerStage && totalRounds < maxTotalRounds) {
                        if (!aiText) break;

                        const systemPrompt = buildStudentSystemPrompt(
                            profile,
                            buildStageContext(taskName, taskDescription, step),
                            reference
                        );
                        const userPrompt = buildStudentUserPrompt(aiText, stageHistory);
                        const rawReply = await callLLM(userPrompt, { apiKey, baseUrl, model }, 0.7, systemPrompt);
                        const userText = sanitizeStudentReply(rawReply);
                        if (!userText) break;

                        const chat = await platformPost<ChatResult>(
                            apiBase,
                            "/ai-tools/trainRun/chat",
                            { taskId, stepId: step.stepId, text: userText, sessionId },
                            credentials,
                            origin
                        );
                        round += 1;
                        totalRounds += 1;
                        if (chat?.sessionId) sessionId = chat.sessionId;

                        const userMessage: TranscriptMessage = {
                            role: "user",
                            content: userText,
                            stepId: step.stepId,
                            stepName,
                            round,
                            source: "chat",
                        };
                        transcript.push(userMessage);
                        stageHistory.push(userMessage);
                        send({
                            type: "message",
                            role: "user",
                            text: userText,
                            stepId: step.stepId,
                            stepName,
                            round,
                            source: "chat",
                        });

                        aiText = String(chat?.text || "").trim();
                        if (aiText) {
                            const assistantMessage: TranscriptMessage = {
                                role: "assistant",
                                content: aiText,
                                stepId: step.stepId,
                                stepName,
                                round,
                                source: "chat",
                            };
                            transcript.push(assistantMessage);
                            stageHistory.push(assistantMessage);
                            send({
                                type: "message",
                                role: "assistant",
                                text: aiText,
                                stepId: step.stepId,
                                stepName,
                                round,
                                source: "chat",
                            });
                        }

                        nextStepId = chat?.nextStepId || null;
                        if (nextStepId) break;
                        if (!aiText) break;
                    }

                    send({
                        type: "stage_end",
                        stepId: step.stepId,
                        stepName,
                        rounds: round,
                        nextStepId,
                    });

                    if (!nextStepId) {
                        stepIndex += 1;
                        if (stepIndex < scriptNodes.length) {
                            send({
                                type: "status",
                                message: `阶段「${stepName}」达到轮次上限或提前结束，继续下一阶段`,
                            });
                            continue;
                        }
                        completed = true;
                        break;
                    }

                    const nextIndex = scriptNodes.findIndex((item) => item.stepId === nextStepId);
                    if (nextIndex === -1) {
                        completed = true;
                        break;
                    }
                    stepIndex = nextIndex;
                }

                send({
                    type: "done",
                    taskId,
                    taskName,
                    studentProfile: studentKey,
                    studentProfileLabel: profile.label,
                    model,
                    sessionId,
                    completed,
                    totalRounds,
                    stepCount: scriptNodes.length,
                    steps: scriptNodes.map((item, index) => ({
                        index: index + 1,
                        stepId: item.stepId,
                        stepName: item.stepDetailDTO?.stepName || item.stepId,
                    })),
                    messages: transcript,
                });
            } catch (error) {
                send({
                    type: "error",
                    message: error instanceof Error ? error.message : "测试运行失败",
                });
            } finally {
                try {
                    controller.close();
                } catch {
                    // 忽略
                }
            }
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        },
    });
}
