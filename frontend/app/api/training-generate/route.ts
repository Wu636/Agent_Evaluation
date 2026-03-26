/**
 * POST /api/training-generate
 * 训练配置和评分标准 - 流式生成 API
 */

import { NextRequest } from "next/server";
import { MODEL_NAME_MAPPING } from "@/lib/config";
import { ApiConfig } from "@/lib/llm/types";
import {
    buildTeacherDocWithPlan,
    classifyTrainingScriptMode,
    continueTrainingRubricStream,
    continueTrainingScriptStream,
    generateTrainingScriptStream,
    generateTrainingRubricStream,
    getScriptModeLabel,
    validateTrainingScriptPlan,
} from "@/lib/training-generator/generator";
import { parseRubricMarkdown, parseTaskConfig, parseTrainingScript } from "@/lib/training-injector/parser";
import { convertDocxToText } from "@/lib/converters/docx-converter";
import { ScriptMode, TrainingScriptPlan } from "@/lib/training-generator/types";
import WordExtractor from 'word-extractor';

// Vercel 函数配置
export const maxDuration = 300;
export const runtime = 'nodejs';

function formatStreamErrorMessage(err: unknown): string {
    const anyErr = err as { message?: string; cause?: { message?: string; code?: string } };
    const rawMsg = String(anyErr?.message || err || '');
    const rawCause = String(anyErr?.cause?.message || '');
    const combined = `${rawMsg} ${rawCause}`.toLowerCase();

    if (
        combined.includes('当前 llm api 地址不可达') ||
        combined.includes('und_err_connect_timeout') ||
        combined.includes('connect timeout') ||
        combined.includes('fetch failed')
    ) {
        return rawMsg;
    }

    if (/terminated|econnreset/i.test(rawMsg)) {
        return 'LLM 流式连接中断（网络波动或网关超时）。系统已自动重试一次但仍失败，请稍后重试。';
    }

    return rawMsg || '生成失败';
}

export async function POST(request: NextRequest) {
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            try {
                let teacherDocContent: string;
                let teacherDocName: string;
                let generateScript: boolean;
                let generateRubric: boolean;
                let apiKey: string;
                let apiUrl: string;
                let model: string;
                let scriptPromptTemplate: string | undefined;
                let rubricPromptTemplate: string | undefined;
                let scriptMode: ScriptMode;
                let modulePlan: TrainingScriptPlan | undefined;

                const contentType = request.headers.get("content-type") || "";

                if (contentType.includes("multipart/form-data")) {
                    // 文件上传模式：服务端解析文件内容
                    const formData = await request.formData();
                    const file = formData.get("file") as File | null;
                    teacherDocName = formData.get("teacherDocName") as string || "文档";
                    generateScript = formData.get("generateScript") === "true";
                    generateRubric = formData.get("generateRubric") === "true";
                    scriptMode = (formData.get("scriptMode") as ScriptMode) || "general";
                    apiKey = formData.get("apiKey") as string || "";
                    apiUrl = formData.get("apiUrl") as string || "";
                    model = formData.get("model") as string || "";
                    scriptPromptTemplate = formData.get("scriptPromptTemplate") as string || undefined;
                    rubricPromptTemplate = formData.get("rubricPromptTemplate") as string || undefined;
                    modulePlan = (() => {
                        const raw = formData.get("modulePlan") as string || "";
                        return raw ? JSON.parse(raw) : undefined;
                    })();

                    if (!file) {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message: '未收到文件' })}\n\n`));
                        controller.close();
                        return;
                    }

                    const arrayBuffer = await file.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    const fileName = file.name.toLowerCase();

                    if (fileName.endsWith(".docx")) {
                        // 使用 mammoth 解析 docx
                        teacherDocContent = await convertDocxToText(buffer);
                    } else if (fileName.endsWith(".doc")) {
                        // 使用 word-extractor 解析旧版 .doc 格式
                        const extractor = new WordExtractor();
                        const extracted = await extractor.extract(buffer);
                        teacherDocContent = extracted.getBody();
                    } else {
                        // txt / md 直接解码
                        teacherDocContent = buffer.toString("utf-8");
                    }
                } else {
                    // JSON 模式（文本粘贴）
                    const payload = await request.json();
                    ({ teacherDocContent, teacherDocName, generateScript, generateRubric, apiKey, apiUrl, model, scriptPromptTemplate, rubricPromptTemplate, scriptMode = "general", modulePlan } = payload);
                }

                if (!teacherDocContent || !teacherDocContent.trim()) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message: '文档内容为空，请检查文件格式' })}\n\n`));
                    controller.close();
                    return;
                }

                if (modulePlan) {
                    const validation = validateTrainingScriptPlan(modulePlan);
                    if (validation.some((item) => item.level === "error")) {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message: '模块规划存在错误，请先修正后再生成。' })}\n\n`));
                        controller.close();
                        return;
                    }
                }

                // 构建配置
                const apiConfig: ApiConfig & { model: string } = {
                    apiKey: apiKey || process.env.LLM_API_KEY || "",
                    baseUrl: apiUrl || process.env.LLM_BASE_URL || "",
                    model: MODEL_NAME_MAPPING[model || ""] || model || process.env.LLM_MODEL || "gpt-4o",
                };

                if (!apiConfig.apiKey || !apiConfig.baseUrl) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message: '未配置 LLM API' })}\n\n`));
                    controller.close();
                    return;
                }

                const send = (event: unknown) => {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                };
                const continueDeadline = Date.now() + 600_000;
                const maxContinuationAttempts = 12;

                const validateScriptStructure = (content: string): { ok: boolean; reason?: string } => {
                    const parsedTask = parseTaskConfig(content);
                    const parsedSteps = parseTrainingScript(content);

                    if (!parsedTask?.trainTaskName) {
                        return { ok: false, reason: "缺少任务名称" };
                    }

                    if (parsedSteps.length === 0) {
                        return { ok: false, reason: "未解析到任何阶段" };
                    }

                    if (modulePlan?.modules?.length && parsedSteps.length < modulePlan.modules.length) {
                        return {
                            ok: false,
                            reason: `阶段数量不足（期望≥${modulePlan.modules.length}，实际=${parsedSteps.length})`,
                        };
                    }

                    const missingPromptIndex = parsedSteps.findIndex((step) => !String(step.llmPrompt || "").trim());
                    if (missingPromptIndex >= 0) {
                        return { ok: false, reason: `阶段${missingPromptIndex + 1}缺少提示词` };
                    }

                    const missingFlowIndex = parsedSteps.findIndex((step) => !String(step.flowCondition || "").trim());
                    if (missingFlowIndex >= 0) {
                        return { ok: false, reason: `阶段${missingFlowIndex + 1}缺少flowCondition` };
                    }

                    if (content.trim().length < 1200) {
                        return { ok: false, reason: "整体内容长度异常偏短，疑似截断" };
                    }

                    return { ok: true };
                };

                const isRubricStructurallyValid = (content: string): boolean => {
                    const parsedRubric = parseRubricMarkdown(content);
                    return parsedRubric.length > 0;
                };

                const cleanupMarkdownFence = (content: string): string => {
                    let clean = content.trim();
                    if (clean.startsWith('\`\`\`markdown')) {
                        clean = clean.substring(13);
                    } else if (clean.startsWith('\`\`\`')) {
                        clean = clean.substring(3);
                    }
                    if (clean.endsWith('\`\`\`')) {
                        clean = clean.substring(0, clean.length - 3);
                    }
                    return clean.trim();
                };

                const isRetryableStreamError = (err: unknown): boolean => {
                    const anyErr = err as any;
                    const msg = String(anyErr?.message || err || '').toLowerCase();
                    const causeMsg = String(anyErr?.cause?.message || '').toLowerCase();
                    const causeCode = String(anyErr?.cause?.code || '').toLowerCase();
                    return msg.includes('terminated') ||
                        msg.includes('econnreset') ||
                        msg.includes('fetch failed') ||
                        causeMsg.includes('econnreset') ||
                        causeCode.includes('econnreset');
                };

                const generatePhaseWithRetry = async (
                    phase: 'script' | 'rubric',
                    startMessage: string,
                    streamFactory: () => AsyncGenerator<string, void, unknown>
                ): Promise<string> => {
                    const maxAttempts = 2; // 首次 + 1次重试
                    let lastError: unknown;

                    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                        let fullContent = '';
                        try {
                            if (attempt === 1) {
                                send({ type: 'start', phase, message: startMessage });
                            } else {
                                send({ type: 'start', phase, message: `网络波动，正在自动重试（${attempt}/${maxAttempts}）...` });
                            }

                            const phaseStream = streamFactory();
                            for await (const chunk of phaseStream) {
                                fullContent += chunk;
                                send({ type: 'chunk', phase, content: chunk });
                            }

                            return cleanupMarkdownFence(fullContent);
                        } catch (err) {
                            lastError = err;
                            if (attempt < maxAttempts && isRetryableStreamError(err)) {
                                console.warn(`[training-generate] ${phase} 阶段流式中断，自动重试:`, err);
                                continue;
                            }
                            throw err;
                        }
                    }

                    throw lastError;
                };

                let fullScript = "";
                let fullRubric = "";
                let resolvedScriptMode: ScriptMode = scriptMode || "general";
                const teacherDocForScript = buildTeacherDocWithPlan(teacherDocContent, modulePlan);

                // 1. 生成剧本配置
                if (generateScript) {
                    if (resolvedScriptMode === "auto" && !scriptPromptTemplate) {
                        send({ type: 'start', phase: 'script', message: '正在自动识别剧本模式...' });
                        try {
                            resolvedScriptMode = await classifyTrainingScriptMode(teacherDocForScript, apiConfig);
                            send({
                                type: 'script_mode_detected',
                                requestedMode: 'auto',
                                resolvedMode: resolvedScriptMode,
                                label: getScriptModeLabel(resolvedScriptMode),
                            });
                            send({
                                type: 'start',
                                phase: 'script',
                                message: `已识别为${getScriptModeLabel(resolvedScriptMode)}，开始生成剧本配置...`,
                            });
                        } catch (err) {
                            console.warn("[training-generate] 剧本模式自动识别失败，回退通用模式:", err);
                            resolvedScriptMode = "general";
                            send({
                                type: 'script_mode_detected',
                                requestedMode: 'auto',
                                resolvedMode: resolvedScriptMode,
                                label: getScriptModeLabel(resolvedScriptMode),
                            });
                            send({
                                type: 'start',
                                phase: 'script',
                                message: '自动识别失败，已回退到通用模式并开始生成剧本配置...',
                            });
                        }
                    }

                    fullScript = await generatePhaseWithRetry(
                        'script',
                        resolvedScriptMode === "general"
                            ? '开始生成剧本配置...'
                            : `开始生成${getScriptModeLabel(resolvedScriptMode)}剧本配置...`,
                        () => generateTrainingScriptStream(teacherDocContent, apiConfig, scriptPromptTemplate || undefined, resolvedScriptMode || "general", modulePlan)
                    );

                    for (let continuationAttempt = 1; continuationAttempt <= maxContinuationAttempts; continuationAttempt++) {
                        const scriptValidation = validateScriptStructure(fullScript);
                        if (scriptValidation.ok) {
                            break;
                        }

                        if (Date.now() > continueDeadline) {
                            throw new Error(`生成结果疑似截断：${scriptValidation.reason || "剧本结构不完整"}（续写超时），请重试`);
                        }

                        send({
                            type: 'start',
                            phase: 'script',
                            message: `检测到剧本结果可能截断（${scriptValidation.reason || "结构不完整"}），正在断点续写（${continuationAttempt}/${maxContinuationAttempts}）...`,
                        });

                        try {
                            let continued = "";
                            for await (const chunk of continueTrainingScriptStream(
                                teacherDocContent,
                                fullScript,
                                apiConfig,
                                scriptPromptTemplate || undefined,
                                resolvedScriptMode || "general",
                                modulePlan
                            )) {
                                continued += chunk;
                                send({ type: 'chunk', phase: 'script', content: chunk });
                            }
                            fullScript = cleanupMarkdownFence(`${fullScript}\n${continued}`);
                        } catch (continueErr) {
                            console.warn("[training-generate] 剧本断点续写失败，准备继续续写重试:", continueErr);
                            if (continuationAttempt < maxContinuationAttempts && Date.now() <= continueDeadline) {
                                send({
                                    type: 'start',
                                    phase: 'script',
                                    message: `断点续写请求失败（可能网关超时），正在继续续写重试（${continuationAttempt + 1}/${maxContinuationAttempts}）...`,
                                });
                                continue;
                            }
                            throw continueErr;
                        }
                    }

                    const finalScriptValidation = validateScriptStructure(fullScript);
                    if (!finalScriptValidation.ok) {
                        throw new Error(`生成结果疑似截断：${finalScriptValidation.reason || "剧本结构不完整"}，请重试`);
                    }
                    send({ type: 'phase_complete', phase: 'script', fullContent: fullScript });
                }

                // 2. 生成评分标准
                if (generateRubric) {
                    fullRubric = await generatePhaseWithRetry(
                        'rubric',
                        '开始生成评分标准...',
                        () => generateTrainingRubricStream(teacherDocContent, apiConfig, rubricPromptTemplate || undefined)
                    );

                    for (let continuationAttempt = 1; continuationAttempt <= maxContinuationAttempts; continuationAttempt++) {
                        if (isRubricStructurallyValid(fullRubric)) {
                            break;
                        }

                        if (Date.now() > continueDeadline) {
                            throw new Error('生成结果疑似截断：评分标准结构不完整（续写超时），请重试');
                        }

                        send({
                            type: 'start',
                            phase: 'rubric',
                            message: `检测到评分标准结果可能截断，正在断点续写（${continuationAttempt}/${maxContinuationAttempts}）...`,
                        });
                        try {
                            let continued = "";
                            for await (const chunk of continueTrainingRubricStream(
                                teacherDocContent,
                                fullRubric,
                                apiConfig,
                                rubricPromptTemplate || undefined
                            )) {
                                continued += chunk;
                                send({ type: 'chunk', phase: 'rubric', content: chunk });
                            }
                            fullRubric = cleanupMarkdownFence(`${fullRubric}\n${continued}`);
                        } catch (continueErr) {
                            console.warn("[training-generate] 评分标准断点续写失败，准备继续续写重试:", continueErr);
                            if (continuationAttempt < maxContinuationAttempts && Date.now() <= continueDeadline) {
                                send({
                                    type: 'start',
                                    phase: 'rubric',
                                    message: `断点评分续写请求失败（可能网关超时），正在继续续写重试（${continuationAttempt + 1}/${maxContinuationAttempts}）...`,
                                });
                                continue;
                            }
                            throw continueErr;
                        }
                    }

                    if (!isRubricStructurallyValid(fullRubric)) {
                        throw new Error('生成结果疑似截断：评分标准结构不完整，请重试');
                    }
                    send({ type: 'phase_complete', phase: 'rubric', fullContent: fullRubric });
                }

                const taskName = teacherDocName.replace(/\.[^/.]+$/, ""); // 尝试去掉扩展名作为默认任务名

                send({ type: 'complete', script: fullScript, rubric: fullRubric, taskName, resolvedScriptMode: generateScript ? resolvedScriptMode : undefined });
                controller.close();

            } catch (error) {
                console.error("生成配置失败:", error);
                try {
                    const message = formatStreamErrorMessage(error);
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message })}\n\n`));
                    controller.close();
                } catch (e) {
                    // 忽略关闭错误
                }
            }
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    });
}
