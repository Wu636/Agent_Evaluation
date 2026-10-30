import { parseTrainingType, withOralTrainingContext, type TrainingType } from "@/lib/oral-training/config";
/**
 * POST /api/training-generate
 * 训练配置和评分标准 - 流式生成 API
 */

import { NextRequest } from "next/server";
import { MODEL_NAME_MAPPING } from "@/lib/config";
import { ApiConfig } from "@/lib/llm/types";
import { LlmHttpError, LlmOutputError } from "@/lib/llm/error-utils";
import {
    buildTeacherDocWithPlan,
    classifyTrainingScriptMode,
    continueTrainingRubricStream,
    continueTrainingScriptStream,
    generateTrainingScriptStream,
    generateTrainingRubricStream,
    getScriptModeLabel,
    repairTrainingScriptStructure,
    validateTrainingScriptPlan,
} from "@/lib/training-generator/generator";
import {
    alignTrainingScriptWithPlan,
    ensureNonlinearFlowConfigMarkdown,
    extractScriptStructure,
    normalizeTrainingScriptCompletion,
    hasTrainingScriptCompleteMarker,
    hasUnclosedTrainingScriptFence,
    stripNonlinearFlowConfigBlocks,
    TRAINING_SCRIPT_COMPLETE_MARKER,
} from "@/lib/training-generator/script-tools";
import { guardTrainingStream, TrainingStreamTimeoutError } from "@/lib/training-generator/stream-control";
import { findIncompleteTrainingScriptStageIndex } from "@/lib/training-generator/script-completion";
import { parseRubricMarkdown, parseTaskConfig, parseTrainingScript, repairTrainingScriptForParsing } from "@/lib/training-injector/parser";
import { convertDocxToText } from "@/lib/converters/docx-converter";
import { ScriptMode, TrainingGenerateRequestMode, TrainingScriptPlan } from "@/lib/training-generator/types";
import { stripRubricSections } from "@/lib/training-generator/doc-sections";
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
    const generationAbort = new AbortController();
    let streamClosed = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

    const stopStreaming = () => {
        if (streamClosed) return;
        streamClosed = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        generationAbort.abort();
    };
    request.signal.addEventListener('abort', stopStreaming, { once: true });

    const stream = new ReadableStream({
        async start(controller) {
            const write = (payload: string): boolean => {
                if (streamClosed) return false;
                try {
                    controller.enqueue(encoder.encode(payload));
                    return true;
                } catch {
                    stopStreaming();
                    return false;
                }
            };
            const send = (event: unknown) => {
                if (!write(`data: ${JSON.stringify(event)}\n\n`)) {
                    throw new DOMException('生成连接已关闭', 'AbortError');
                }
            };
            const close = () => {
                if (streamClosed) return;
                streamClosed = true;
                if (heartbeatTimer) clearInterval(heartbeatTimer);
                request.signal.removeEventListener('abort', stopStreaming);
                controller.close();
            };

            // 续写和结构修复会等待模型整段返回；定期写入 SSE 注释以保持连接活跃。
            heartbeatTimer = setInterval(() => {
                write(': keepalive\n\n');
            }, 10_000);

            try {
                let trainingType: TrainingType | undefined;
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
                let userSuggestions: string | undefined;
                let priorScript: string | undefined;
                let priorRubric: string | undefined;
                let skipRubricSections = false;
                let requestMode: TrainingGenerateRequestMode = "generate";

                const contentType = request.headers.get("content-type") || "";

                if (contentType.includes("multipart/form-data")) {
                    // 文件上传模式：服务端解析文件内容
                    const formData = await request.formData();
                    trainingType = parseTrainingType(formData.get("trainingType"));
                    const file = formData.get("file") as File | null;
                    teacherDocName = formData.get("teacherDocName") as string || "文档";
                    const mode = formData.get("requestMode");
                    requestMode = mode === "continue_script" || mode === "resume_script" ? mode : "generate";
                    generateScript = formData.get("generateScript") === "true";
                    generateRubric = formData.get("generateRubric") === "true";
                    scriptMode = (formData.get("scriptMode") as ScriptMode) || "general";
                    apiKey = formData.get("apiKey") as string || "";
                    apiUrl = formData.get("apiUrl") as string || "";
                    model = formData.get("model") as string || "";
                    scriptPromptTemplate = formData.get("scriptPromptTemplate") as string || undefined;
                    rubricPromptTemplate = formData.get("rubricPromptTemplate") as string || undefined;
                    userSuggestions = formData.get("userSuggestions") as string || undefined;
                    priorScript = formData.get("priorScript") as string || undefined;
                    priorRubric = formData.get("priorRubric") as string || undefined;
                    skipRubricSections = formData.get("skipRubricSections") === "true";
                    modulePlan = (() => {
                        const raw = formData.get("modulePlan") as string || "";
                        return raw ? JSON.parse(raw) : undefined;
                    })();

                    if (!file) {
                        send({ type: 'error', message: '未收到文件' });
                        close();
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
                    trainingType = parseTrainingType(payload.trainingType);
                    ({ teacherDocContent, teacherDocName, generateScript, generateRubric, apiKey, apiUrl, model, scriptPromptTemplate, rubricPromptTemplate, scriptMode = "general", modulePlan, userSuggestions, priorScript, priorRubric } = payload);
                    skipRubricSections = payload.skipRubricSections === true;
                    requestMode = payload.requestMode === "continue_script" || payload.requestMode === "resume_script" ? payload.requestMode : "generate";
                }

                if (trainingType === "oral") {
                    generateRubric = false;
                    if (!generateScript) throw new Error("口语训练暂不支持生成评分标准，请选择训练剧本配置；评分沿用平台默认配置。");
                }

                if (!teacherDocContent || !teacherDocContent.trim()) {
                    send({ type: 'error', message: '文档内容为空，请检查文件格式' });
                    close();
                    return;
                }

                teacherDocContent = withOralTrainingContext(teacherDocContent, trainingType);

                // 剧本生成不需要评分标准章节；评分标准生成仍使用完整文档。
                let scriptDocContent = teacherDocContent;
                if (generateScript && skipRubricSections) {
                    const trimmed = stripRubricSections(teacherDocContent);
                    if (trimmed.removedSections.length > 0) {
                        const removedTitles = trimmed.removedSections.map((section) => section.title).join("、");
                        scriptDocContent = `${trimmed.content}\n\n[系统说明] 以下章节已为剧本生成省略：${removedTitles}。请勿编造分值、权重或评分区间；考核重点以任务要求与流程为准。`;
                        console.info("[training-generate] 剧本生成已跳过评分标准章节", {
                            removedSections: trimmed.removedSections,
                            removedChars: trimmed.removedChars,
                            keptChars: scriptDocContent.length,
                        });
                    }
                }

                if (modulePlan) {
                    const validation = validateTrainingScriptPlan(modulePlan);
                    if (validation.some((item) => item.level === "error")) {
                        send({ type: 'error', message: '模块规划存在错误，请先修正后再生成。' });
                        close();
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
                    send({ type: 'error', message: '未配置 LLM API' });
                    close();
                    return;
                }
                const continuationWindowMs = 600_000;
                const maxContinuationAttempts = 12;

                const extractStageNumber = (heading: string): number | null => {
                    const match = heading.match(/^#{3,}\s*阶段\s*(\d+)(?:\b|[：:])/i);
                    if (!match) return null;
                    const value = Number.parseInt(match[1], 10);
                    return Number.isFinite(value) ? value : null;
                };

                const findIncompleteStageIndex = (content: string): number => {
                    const structure = extractScriptStructure(content);
                    const parsedSteps = parseTrainingScript(content);
                    const expectedStageCount = modulePlan?.modules?.length || structure.stages.length;
                    return findIncompleteTrainingScriptStageIndex(
                        structure.stages,
                        parsedSteps,
                        expectedStageCount,
                        hasTrainingScriptCompleteMarker(content),
                    );
                };

                const validateScriptStructure = (content: string): { ok: boolean; reason?: string } => {
                    const normalizedContent = normalizeTrainingScriptCompletion(content);
                    const parsedTask = parseTaskConfig(normalizedContent);
                    const parsedSteps = parseTrainingScript(normalizedContent);
                    const structure = extractScriptStructure(normalizedContent);
                    const stageCount = structure.stages.length || parsedSteps.length;
                    const stageOneMatches = structure.stages.filter((stage) => /^#{3,}\s*阶段\s*1(?:\b|[：:])/i.test(stage.heading));

                    if (!parsedTask?.trainTaskName) {
                        return { ok: false, reason: "缺少任务名称" };
                    }

                    if (parsedSteps.length === 0) {
                        return { ok: false, reason: "未解析到任何阶段" };
                    }

                    if (hasUnclosedTrainingScriptFence(normalizedContent)) {
                        return { ok: false, reason: "存在未闭合的 Markdown 代码块，疑似提示词或衔接语被截断" };
                    }

                    if (stageOneMatches.length > 1) {
                        return { ok: false, reason: "检测到剧本内容从阶段1重新开始，疑似重复生成" };
                    }

                    let lastStageNumber: number | null = null;
                    for (const stage of structure.stages) {
                        const stageNumber = extractStageNumber(stage.heading);
                        if (stageNumber === null) {
                            continue;
                        }
                        if (lastStageNumber !== null && stageNumber <= lastStageNumber) {
                            return {
                                ok: false,
                                reason: `阶段编号出现回卷（阶段${lastStageNumber}后出现阶段${stageNumber}）`,
                            };
                        }
                        lastStageNumber = stageNumber;
                    }

                    if (modulePlan?.modules?.length && stageCount < modulePlan.modules.length) {
                        return {
                            ok: false,
                            reason: `阶段数量不足（期望≥${modulePlan.modules.length}，实际=${stageCount})`,
                        };
                    }

                    if (modulePlan?.modules?.length && stageCount > modulePlan.modules.length) {
                        return {
                            ok: false,
                            reason: `阶段数量异常重复（期望=${modulePlan.modules.length}，实际=${stageCount})`,
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

                    const incompleteStageIndex = findIncompleteStageIndex(normalizedContent);
                    if (incompleteStageIndex >= 0) {
                        return { ok: false, reason: `阶段${incompleteStageIndex + 1}未完整结束，需重新生成该阶段` };
                    }

                    if (normalizedContent.trim().length < 1200) {
                        return { ok: false, reason: "整体内容长度异常偏短，疑似截断" };
                    }

                    if (!hasTrainingScriptCompleteMarker(normalizedContent)) {
                        return { ok: false, reason: `缺少完整结束标志 ${TRAINING_SCRIPT_COMPLETE_MARKER}` };
                    }

                    return { ok: true };
                };

                const getScriptContinuationWindow = (content: string): {
                    resumeStageNumber: number;
                    endStageNumber?: number;
                    context: string;
                } => {
                    const trimStageContext = (markdown: string): string => {
                        const lines = markdown.split("\n");
                        let inCodeBlock = false;
                        const kept: string[] = [];
                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!inCodeBlock && /^##\s*(?:(?:⚙️\s*)?配置说明|(?:🔀\s*)?非线性跳转关系|阶段跳转关系)/.test(trimmed)) break;
                            kept.push(line);
                            if (trimmed.startsWith("```")) inCodeBlock = !inCodeBlock;
                        }
                        return kept.join("\n").trim();
                    };

                    const structure = extractScriptStructure(content);
                    const expectedStageCount = modulePlan?.modules?.length || structure.stages.length;
                    let resumeIndex = findIncompleteStageIndex(content);
                    let tailOnly = false;

                    if (resumeIndex < 0 && structure.stages.length < expectedStageCount) {
                        resumeIndex = structure.stages.length;
                    } else if (resumeIndex < 0) {
                        tailOnly = true;
                    }

                    const resumeStageNumber = tailOnly
                        ? Math.max(1, expectedStageCount + 1)
                        : Math.max(1, resumeIndex + 1);
                    const previousStage = tailOnly
                        ? structure.stages[structure.stages.length - 1]
                        : resumeIndex > 0 ? structure.stages[resumeIndex - 1] : undefined;
                    const partialStage = resumeIndex >= 0 ? structure.stages[resumeIndex] : undefined;
                    const suffixContainsTargetStage = !partialStage && !tailOnly &&
                        new RegExp(`^###\\s*阶段\\s*${resumeStageNumber}(?:\\b|[：:])`, "im").test(structure.suffix);
                    const partialStageContext = partialStage
                        ? trimStageContext(partialStage.markdown)
                        : suffixContainsTargetStage ? trimStageContext(structure.suffix) : "";
                    const isGraph = modulePlan?.flowType === 'graph';
                    const targetModuleId = modulePlan?.modules[resumeStageNumber - 1]?.id;
                    const incoming = isGraph ? modulePlan?.edges.filter((edge) => edge.toModuleId === targetModuleId) || [] : [];
                    const relatedModuleIds = new Set(incoming.map((edge) => edge.fromModuleId));
                    const graphPredecessors = isGraph ? structure.stages.filter((stage) => {
                        const number = extractStageNumber(stage.heading);
                        return number && relatedModuleIds.has(modulePlan?.modules[number - 1]?.id || '');
                    }).slice(-2) : [];
                    let endStageNumber = !tailOnly && modulePlan?.modules.length
                        ? Math.min(resumeStageNumber + 1, expectedStageCount)
                        : undefined;
                    if (isGraph && endStageNumber && endStageNumber > resumeStageNumber) {
                        const outgoing = modulePlan?.edges.filter((edge) => edge.fromModuleId === targetModuleId) || [];
                        const adjacentModuleId = modulePlan?.modules[resumeStageNumber]?.id;
                        if (outgoing.length !== 1 || outgoing[0].toModuleId !== adjacentModuleId) {
                            // 一个请求停在当前线路终点，下一条角色线路由后续请求独立生成。
                            endStageNumber = resumeStageNumber;
                        }
                    }
                    const contextParts = [
                        tailOnly
                            ? "断点定位：所有规划阶段均已生成，请只补齐文档尾部缺失内容。"
                            : `断点定位：从阶段${resumeStageNumber}开始续写。${partialStageContext ? "请重新完整生成这个不完整阶段，再继续尚未生成的后续阶段。" : "请从这个阶段开始生成缺失内容。"}`,
                        structure.prefix.trim()
                            ? `【已生成的基础配置与全局规则，续写继续遵守】\n${structure.prefix}`
                            : '',
                        `【已有阶段目录，仅表示文档编号】\n${structure.stages.map((stage) => stage.heading).join('\n')}`,
                        isGraph
                            ? '当前是非线性图。编号相邻的阶段可能属于另一条角色线路，不构成执行前后关系；实际前驱和后继只按模块规划 edges 判断。'
                            : '',
                        ...graphPredecessors.map((stage) => `【已生成的图上前驱，参考其全局变量和教学进度】\n${stage.markdown}`),
                        previousStage && !isGraph
                            ? `【仅供衔接参考：上一完整阶段 阶段${resumeStageNumber - 1}】\n${previousStage.markdown}`
                            : "",
                        partialStageContext
                            ? `【待重生成的残缺阶段 阶段${resumeStageNumber}】\n${partialStageContext}`
                            : "",
                        (tailOnly || !partialStageContext) && structure.suffix.trim()
                            ? `【当前文档尾部】\n${structure.suffix}`
                            : "",
                        structure.stages.length === 0 && content.trim()
                            ? `【已有输出尾部】\n${content.slice(-12000)}`
                            : "",
                    ].filter(Boolean);

                    return {
                        resumeStageNumber,
                        endStageNumber,
                        context: contextParts.join("\n\n"),
                    };
                };

                const isRubricStructurallyValid = (content: string): boolean => {
                    const parsedRubric = parseRubricMarkdown(content);
                    return parsedRubric.length > 0;
                };

                const cleanupMarkdownFence = (content: string): string => {
                    let clean = content.trim();
                    clean = clean.replace(/^\`\`\`(?:markdown|md)?\s*\n?/i, '');
                    clean = clean.replace(/\n?\`\`\`\s*$/i, '');
                    return clean.trim();
                };

                const scoreScriptCompleteness = (content: string): number => {
                    const parsedTask = parseTaskConfig(content);
                    const parsedSteps = parseTrainingScript(content);
                    let score = parsedTask?.trainTaskName ? 2 : 0;

                    parsedSteps.forEach((step) => {
                        if (String(step.description || "").trim()) score += 1;
                        if (String(step.prologue || "").trim()) score += 1;
                        if (String(step.llmPrompt || "").trim()) score += 3;
                        if (String(step.flowCondition || "").trim()) score += 3;
                        if (String(step.transitionPrompt || "").trim()) score += 1;
                    });

                    score += Math.min(content.length / 6000, 3);
                    return score;
                };

                const scoreScriptCandidate = (content: string): number => {
                    const cleaned = cleanupMarkdownFence(content);
                    const parsedSteps = parseTrainingScript(cleaned);
                    const structure = extractScriptStructure(cleaned);
                    const stageOneMatches = cleaned.match(/^#{3,}\s*阶段\s*1(?:\b|[：:])/gim) || [];
                    const validation = validateScriptStructure(cleaned);

                    let score = scoreScriptCompleteness(cleaned);
                    score += parsedSteps.length * 4;
                    score += structure.stages.length * 2;
                    if (hasTrainingScriptCompleteMarker(cleaned)) score += 8;
                    if (hasUnclosedTrainingScriptFence(cleaned)) score -= 15;
                    if (validation.ok) score += 12;
                    else score -= 12;
                    if (stageOneMatches.length > 1) {
                        score -= (stageOneMatches.length - 1) * 25;
                    }
                    return score;
                };

                const chooseBestScriptCandidate = (candidates: string[]): string => {
                    let bestCandidate = cleanupMarkdownFence(candidates[0] || "");
                    let bestScore = Number.NEGATIVE_INFINITY;
                    const seen = new Set<string>();

                    for (const candidate of candidates) {
                        const cleaned = cleanupMarkdownFence(candidate);
                        if (!cleaned || seen.has(cleaned)) continue;
                        seen.add(cleaned);
                        const score = scoreScriptCandidate(cleaned);
                        if (score > bestScore) {
                            bestScore = score;
                            bestCandidate = cleaned;
                        }
                    }

                    return bestCandidate;
                };

                const normalizeRepeatedStageOneRestart = (content: string): string => {
                    const clean = cleanupMarkdownFence(content);
                    const stageOneMatches = Array.from(clean.matchAll(/^#{3,}\s*阶段\s*1(?:\b|[：:]).*$/gim));
                    if (stageOneMatches.length <= 1) {
                        return clean;
                    }

                    const structure = extractScriptStructure(clean);
                    const candidates = [clean];

                    for (let i = 1; i < stageOneMatches.length; i++) {
                        const restartIndex = stageOneMatches[i].index ?? -1;
                        if (restartIndex < 0) continue;

                        const prefixCandidate = clean.slice(0, restartIndex).trim();
                        if (prefixCandidate) {
                            candidates.push(prefixCandidate);
                        }

                        const restartCandidate = [
                            structure.prefix,
                            clean.slice(restartIndex).trim(),
                        ].filter(Boolean).join("\n\n").trim();
                        if (restartCandidate) {
                            candidates.push(restartCandidate);
                        }
                    }

                    return chooseBestScriptCandidate(candidates);
                };

                const enforceMonotonicStageOrder = (content: string): string => {
                    const structure = extractScriptStructure(content);
                    if (structure.stages.length <= 1) {
                        return content;
                    }

                    const guardedStages: string[] = [];
                    let lastStageNumber: number | null = null;
                    let truncated = false;

                    for (const stage of structure.stages) {
                        const stageNumber = extractStageNumber(stage.heading);
                        if (stageNumber !== null && lastStageNumber !== null && stageNumber <= lastStageNumber) {
                            truncated = true;
                            break;
                        }

                        guardedStages.push(stage.markdown.trim());
                        if (stageNumber !== null) {
                            lastStageNumber = stageNumber;
                        }

                        if (modulePlan?.modules?.length && guardedStages.length >= modulePlan.modules.length) {
                            if (structure.stages.length > guardedStages.length) {
                                truncated = true;
                            }
                            break;
                        }
                    }

                    if (!truncated) {
                        return content;
                    }

                    return [
                        structure.prefix,
                        guardedStages.join("\n\n"),
                    ]
                        .filter(Boolean)
                        .join("\n\n")
                        .trim();
                };

                const applyScriptContinuationGuards = (content: string): string => {
                    const clean = cleanupMarkdownFence(content);
                    return enforceMonotonicStageOrder(normalizeScriptRestartLoop(normalizeRepeatedStageOneRestart(clean)));
                };

                const normalizeGeneratedScript = (content: string): string => {
                    const completed = repairTrainingScriptForParsing(
                        normalizeTrainingScriptCompletion(applyScriptContinuationGuards(content)),
                    );
                    if (!hasTrainingScriptCompleteMarker(completed)) return completed;
                    // 残缺提示词后追加图 JSON 会把它混入阶段正文；仅在文档结束后恢复全图。
                    if (modulePlan?.flowType === "graph") {
                        return ensureNonlinearFlowConfigMarkdown(completed, modulePlan);
                    }
                    // 规划为线性时清掉模型残留的显式非线性区块，避免注入端再次改判。
                    return modulePlan
                        ? stripNonlinearFlowConfigBlocks(completed, { explicitNonlinearOnly: true })
                        : completed;
                };

                const mergeScriptContinuationContent = (
                    previousContent: string,
                    continuationContent: string,
                    resumeStageNumber: number,
                ): string => {
                    const previous = normalizeGeneratedScript(previousContent);
                    const continuation = cleanupMarkdownFence(continuationContent);
                    if (!continuation.trim()) {
                        return previous;
                    }

                    const previousStructure = extractScriptStructure(previous.replaceAll(TRAINING_SCRIPT_COMPLETE_MARKER, ''));
                    const continuationStructure = extractScriptStructure(continuation);

                    if (continuationStructure.stages.length > 0) {
                        if (modulePlan?.modules?.length && resumeStageNumber > modulePlan.modules.length) {
                            const suffix = continuationStructure.suffix.trim();
                            if (!suffix) {
                                throw new Error("续写结果没有补出文档尾部内容，请重试");
                            }
                            return normalizeGeneratedScript(`${previous.replaceAll(TRAINING_SCRIPT_COMPLETE_MARKER, '')}\n\n${suffix}`);
                        }

                        const resumedStageByNumber = new Map<number, string>();
                        for (const stage of previousStructure.stages) {
                            const number = extractStageNumber(stage.heading);
                            if (number !== null) resumedStageByNumber.set(number, stage.markdown.trim());
                        }
                        let hasTargetStage = false;
                        for (const stage of continuationStructure.stages) {
                            const stageNumber = extractStageNumber(stage.heading);
                            if (stageNumber === null || stageNumber < resumeStageNumber) continue;
                            if (modulePlan && stageNumber > modulePlan.modules.length) continue;
                            if (stageNumber === resumeStageNumber) hasTargetStage = true;
                            resumedStageByNumber.set(stageNumber, stage.markdown.trim());
                        }
                        const resumedStages = [...resumedStageByNumber.entries()]
                            .sort(([left], [right]) => left - right)
                            .map(([, markdown]) => markdown);

                        if (!hasTargetStage) {
                            throw new Error(`续写结果未包含目标阶段${resumeStageNumber}，请重试`);
                        }

                        const staleStageInSuffix = previousStructure.suffix.match(/^###\s*阶段\s*(\d+)(?:\b|[：:])/im);
                        const previousSuffix = staleStageInSuffix && Number(staleStageInSuffix[1]) >= resumeStageNumber
                            ? ""
                            : previousStructure.suffix;

                        const merged = [
                            previousStructure.prefix || continuationStructure.prefix,
                            ...resumedStages,
                            continuationStructure.suffix || previousSuffix,
                        ].filter(Boolean).join("\n\n").trim();
                        return normalizeGeneratedScript(merged);
                    }

                    if (modulePlan && resumeStageNumber <= modulePlan.modules.length) {
                        throw new Error(`续写结果缺少目标阶段${resumeStageNumber}的标准标题，请重新生成该阶段。`);
                    }

                    return normalizeGeneratedScript(`${previous.replaceAll(TRAINING_SCRIPT_COMPLETE_MARKER, '')}\n\n${continuation}`);
                };

                const normalizeScriptRestartLoop = (content: string): string => {
                    const expectedStageCount = modulePlan?.modules?.length || 0;
                    if (!expectedStageCount) return content;

                    const structure = extractScriptStructure(content);
                    if (structure.stages.length <= expectedStageCount) {
                        return content;
                    }

                    let bestCandidate = content;
                    let bestScore = -Infinity;

                    for (let start = 0; start <= structure.stages.length - expectedStageCount; start++) {
                        const selectedStages = structure.stages
                            .slice(start, start + expectedStageCount)
                            .map((stage) => stage.markdown.trim())
                            .filter(Boolean);

                        if (selectedStages.length !== expectedStageCount) continue;

                        const candidate = [
                            structure.prefix,
                            selectedStages.join("\n\n"),
                            structure.suffix,
                        ].filter(Boolean).join("\n\n").trim();

                        const parsedSteps = parseTrainingScript(candidate);
                        if (parsedSteps.length !== expectedStageCount) continue;

                        let score = scoreScriptCompleteness(candidate);
                        const firstHeading = structure.stages[start]?.heading || "";
                        if (/^###\s*阶段\s*1(?:\b|[：:])/i.test(firstHeading)) {
                            score += 1;
                        }
                        score += start * 0.05;

                        if (score > bestScore) {
                            bestScore = score;
                            bestCandidate = candidate;
                        }
                    }

                    return bestScore > -Infinity ? bestCandidate : content;
                };

                const isRetryableStreamError = (err: unknown): boolean => {
                    if (err instanceof TrainingStreamTimeoutError) return true;
                    if (err instanceof LlmOutputError) return err.retryable;
                    if (err instanceof LlmHttpError) return err.retryable;
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
                    streamFactory: (attempt: number, signal: AbortSignal) => AsyncGenerator<string, void, unknown>
                ): Promise<string> => {
                    const maxAttempts = 2; // 首次 + 1次重试
                    let lastError: unknown;

                    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                        let fullContent = '';
                        try {
                            if (attempt === 1) {
                                send({ type: 'start', phase, message: startMessage });
                            } else {
                                send({ type: 'start', phase, message: `上次请求未获得可用结果，正在缩小输出额度重试（${attempt}/${maxAttempts}）...` });
                            }

                            const phaseStream = guardTrainingStream((signal) => streamFactory(attempt, signal), {
                                signal: generationAbort.signal,
                                onProgress: ({ elapsedMs, receivedChars }) => send({
                                    type: 'progress', phase,
                                    message: `正在生成${phase === 'script' ? '剧本' : '评分标准'}，本轮已等待 ${Math.floor(elapsedMs / 1000)} 秒，已接收 ${receivedChars} 字符...`,
                                }),
                            });
                            for await (const chunk of phaseStream) {
                                fullContent += chunk;
                                send({ type: 'chunk', phase, content: chunk });
                            }

                            return phase === 'script'
                                ? normalizeGeneratedScript(fullContent)
                                : cleanupMarkdownFence(fullContent);
                        } catch (err) {
                            lastError = err;
                            if (isRetryableStreamError(err) && fullContent.trim()) {
                                console.warn(`[training-generate] ${phase} 阶段流中断，保留已生成内容并转入断点续写:`, err);
                                return phase === 'script'
                                    ? normalizeGeneratedScript(fullContent)
                                    : cleanupMarkdownFence(fullContent);
                            }
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
                const teacherDocForScript = buildTeacherDocWithPlan(scriptDocContent, modulePlan);
                if (requestMode === "resume_script" && (!generateScript || !priorScript?.trim())) {
                    send({ type: 'error', message: '恢复自动续写需要已有剧本内容' });
                    close();
                    return;
                }

                // 手动断点续写只处理当前已有剧本的缺口，不重新生成已完成阶段。
                if (requestMode === "continue_script") {
                    if (!generateScript || !priorScript?.trim()) {
                        send({ type: 'error', message: '当前没有可续写的剧本内容' });
                        close();
                        return;
                    }

                    fullScript = normalizeGeneratedScript(priorScript);
                    const continuationScriptMode = resolvedScriptMode === "auto"
                        ? modulePlan?.recommendedMode || "general"
                        : resolvedScriptMode;
                    const beforeValidation = validateScriptStructure(fullScript);
                    if (beforeValidation.ok) {
                        fullScript = alignTrainingScriptWithPlan(fullScript, modulePlan);
                        send({ type: 'phase_complete', phase: 'script', fullContent: fullScript });
                        send({
                            type: 'complete',
                            script: fullScript,
                            rubric: '',
                            taskName: teacherDocName.replace(/\.[^/.]+$/, ""),
                            resolvedScriptMode: continuationScriptMode,
                        });
                        close();
                        return;
                    }

                    const continuationWindow = getScriptContinuationWindow(fullScript);
                    const rangeLabel = continuationWindow.endStageNumber
                        ? `阶段${continuationWindow.resumeStageNumber}${continuationWindow.endStageNumber > continuationWindow.resumeStageNumber ? `–${continuationWindow.endStageNumber}` : ''}`
                        : '文档尾部与阶段关系';
                    send({
                        type: 'start',
                        phase: 'script',
                        message: `手动断点续写：正在补齐${rangeLabel}（${beforeValidation.reason || '结构不完整'}）...`,
                    });

                    let continued = '';
                    let lastSnapshotAt = 0;
                    try {
                        for await (const chunk of guardTrainingStream((signal) => continueTrainingScriptStream(
                            scriptDocContent,
                            continuationWindow.context,
                            apiConfig,
                            scriptPromptTemplate || undefined,
                            continuationScriptMode,
                            modulePlan,
                            userSuggestions,
                            continuationWindow.resumeStageNumber,
                            { signal, maxTokens: 8000, endStageNumber: continuationWindow.endStageNumber },
                        ), {
                            signal: generationAbort.signal,
                            timeoutMs: 150_000,
                            onProgress: ({ elapsedMs, receivedChars }) => send({
                                type: 'progress',
                                phase: 'script',
                                message: `手动断点续写${rangeLabel}，已等待 ${Math.floor(elapsedMs / 1000)} 秒，已接收 ${receivedChars} 字符；正在保持${modulePlan?.flowType === 'graph' ? '非线性规划连线' : '原阶段结构'}...`,
                            }),
                        })) {
                            continued += chunk;
                            if (Date.now() - lastSnapshotAt >= 750) {
                                lastSnapshotAt = Date.now();
                                try {
                                    const snapshot = mergeScriptContinuationContent(
                                        fullScript,
                                        continued,
                                        continuationWindow.resumeStageNumber,
                                    );
                                    send({ type: 'phase_snapshot', phase: 'script', fullContent: snapshot });
                                } catch {
                                    // 模型尚未输出完整阶段标题时继续等待，页面保留原剧本。
                                }
                            }
                        }

                        fullScript = mergeScriptContinuationContent(
                            fullScript,
                            continued,
                            continuationWindow.resumeStageNumber,
                        );
                    } catch (continueError) {
                        if (generationAbort.signal.aborted) throw continueError;
                        if (continued.trim()) {
                            try {
                                fullScript = mergeScriptContinuationContent(
                                    fullScript,
                                    continued,
                                    continuationWindow.resumeStageNumber,
                                );
                            } catch {
                                // 本轮输出仍不构成完整阶段，继续保留请求前的正文。
                            }
                        }
                        send({ type: 'phase_snapshot', phase: 'script', fullContent: fullScript });
                        send({
                            type: 'error',
                            message: `本轮断点续写中断，已保留当前剧本。${formatStreamErrorMessage(continueError)}，可再次点击“断点续写”。`,
                        });
                        close();
                        return;
                    }

                    fullScript = normalizeGeneratedScript(fullScript);
                    send({ type: 'phase_snapshot', phase: 'script', fullContent: fullScript });
                    const afterValidation = validateScriptStructure(fullScript);
                    if (!afterValidation.ok) {
                        send({
                            type: 'error',
                            message: `本轮已补入有效内容，但剧本仍未完整：${afterValidation.reason || '结构不完整'}。可再次点击“断点续写”。`,
                        });
                        close();
                        return;
                    }

                    fullScript = alignTrainingScriptWithPlan(fullScript, modulePlan);
                    send({ type: 'phase_complete', phase: 'script', fullContent: fullScript });
                    send({
                        type: 'complete',
                        script: fullScript,
                        rubric: '',
                        taskName: teacherDocName.replace(/\.[^/.]+$/, ""),
                        resolvedScriptMode: continuationScriptMode,
                    });
                    close();
                    return;
                }

                // 1. 生成剧本配置
                if (generateScript) {
                    let scriptContinueDeadline: number | null = null;
                    let scriptStructureRepairAttempted = false;
                    let stalledContinuationAttempts = 0;
                    if (resolvedScriptMode === "auto" && !scriptPromptTemplate) {
                        send({ type: 'start', phase: 'script', message: '正在自动识别剧本模式...' });
                        try {
                            resolvedScriptMode = await classifyTrainingScriptMode(teacherDocForScript, apiConfig, generationAbort.signal);
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
                            if (generationAbort.signal.aborted) throw err;
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

                    if (requestMode === "resume_script") {
                        fullScript = normalizeGeneratedScript(priorScript!);
                        send({ type: 'phase_snapshot', phase: 'script', fullContent: fullScript });
                    } else {
                        fullScript = await generatePhaseWithRetry(
                            'script',
                            resolvedScriptMode === "general"
                                ? '开始生成剧本配置...'
                                : `开始生成${getScriptModeLabel(resolvedScriptMode)}剧本配置...`,
                            (attempt, signal) => generateTrainingScriptStream(
                                scriptDocContent,
                                apiConfig,
                                scriptPromptTemplate || undefined,
                                resolvedScriptMode || "general",
                                modulePlan,
                                userSuggestions,
                                priorScript,
                                { signal, maxTokens: attempt > 1 ? 8000 : undefined },
                            )
                        );
                    }
                    fullScript = normalizeGeneratedScript(fullScript);

                    for (let continuationAttempt = 1; continuationAttempt <= maxContinuationAttempts; continuationAttempt++) {
                        const scriptValidation = validateScriptStructure(fullScript);
                        if (scriptValidation.ok) {
                            break;
                        }

                        const shouldRepairStructure = Boolean(
                            !scriptStructureRepairAttempted &&
                            modulePlan?.modules?.length &&
                            /阶段数量异常重复|阶段编号出现回卷/.test(scriptValidation.reason || "")
                        );

                        if (shouldRepairStructure) {
                            scriptStructureRepairAttempted = true;
                            send({
                                type: 'start',
                                phase: 'script',
                                message: `检测到阶段结构与模块规划不一致（${scriptValidation.reason || "结构异常"}），正在自动整理阶段结构...`,
                            });
                            try {
                                fullScript = normalizeGeneratedScript(await repairTrainingScriptStructure(
                                    scriptDocContent,
                                    fullScript,
                                    apiConfig,
                                    scriptPromptTemplate || undefined,
                                    resolvedScriptMode || "general",
                                    modulePlan,
                                    generationAbort.signal,
                                ));
                                continue;
                            } catch (repairErr) {
                                if (generationAbort.signal.aborted) throw repairErr;
                                console.warn("[training-generate] 剧本结构修复失败，回退续写/重试策略:", repairErr);
                            }
                        }

                        if (!scriptContinueDeadline) {
                            scriptContinueDeadline = Date.now() + continuationWindowMs;
                        }

                        if (Date.now() > scriptContinueDeadline) {
                            throw new Error(`生成结果疑似截断：${scriptValidation.reason || "剧本结构不完整"}（续写超时），请重试`);
                        }

                        const scriptBeforeContinue = fullScript;
                        const continuationWindow = getScriptContinuationWindow(fullScript);
                        if (stalledContinuationAttempts > 0 && continuationWindow.endStageNumber) {
                            // Repeating a truncated stage with the same multi-stage budget
                            // recreates the same breakpoint. Finish this stage on its own.
                            continuationWindow.endStageNumber = continuationWindow.resumeStageNumber;
                        }
                        const rangeLabel = continuationWindow.endStageNumber
                            ? `阶段${continuationWindow.resumeStageNumber}${continuationWindow.endStageNumber > continuationWindow.resumeStageNumber ? `–${continuationWindow.endStageNumber}` : ''}`
                            : `阶段${continuationWindow.resumeStageNumber}及文档尾部`;
                        send({
                            type: 'start', phase: 'script',
                            message: `检测到剧本结果可能截断（${scriptValidation.reason || '结构不完整'}），正在断点续写${rangeLabel}（${continuationAttempt}/${maxContinuationAttempts}）...`,
                        });
                        let continued = "";
                        let lastSnapshotAt = 0;
                        const publishSnapshot = (content: string) => send({ type: 'phase_snapshot', phase: 'script', fullContent: content });
                        console.info("[training-generate] 剧本续写上下文长度", {
                            resumeStageNumber: continuationWindow.resumeStageNumber,
                            endStageNumber: continuationWindow.endStageNumber,
                            flowType: modulePlan?.flowType,
                            edgeCount: modulePlan?.edges.length || 0,
                            teacherDocChars: scriptDocContent.length,
                            modulePlanChars: modulePlan ? JSON.stringify(modulePlan).length : 0,
                            userSuggestionsChars: userSuggestions?.length || 0,
                            nearbyStageChars: continuationWindow.context.length,
                        });

                        let continuationError: unknown;
                        try {
                            for await (const chunk of guardTrainingStream((signal) => continueTrainingScriptStream(
                                scriptDocContent,
                                continuationWindow.context,
                                apiConfig,
                                scriptPromptTemplate || undefined,
                                resolvedScriptMode || "general",
                                modulePlan,
                                userSuggestions,
                                continuationWindow.resumeStageNumber,
                                { signal, maxTokens: 8000, endStageNumber: continuationWindow.endStageNumber },
                            ), {
                                signal: generationAbort.signal,
                                timeoutMs: Math.min(150_000, scriptContinueDeadline - Date.now()),
                                onProgress: ({ elapsedMs, receivedChars }) => send({
                                    type: 'progress', phase: 'script',
                                    message: `正在断点续写${rangeLabel}（${continuationAttempt}/${maxContinuationAttempts}），本轮 ${Math.floor(elapsedMs / 1000)} 秒，已接收 ${receivedChars} 字符；保持${modulePlan?.flowType === 'graph' ? '规划分支连线' : '原阶段结构'}...`,
                                }),
                            })) {
                                continued += chunk;
                                if (Date.now() - lastSnapshotAt >= 750) {
                                    lastSnapshotAt = Date.now();
                                    try {
                                        publishSnapshot(mergeScriptContinuationContent(scriptBeforeContinue, continued, continuationWindow.resumeStageNumber));
                                    } catch {
                                        // 标题尚未接收完整时只更新字符进度，保留已有正文。
                                    }
                                }
                            }

                            const merged = mergeScriptContinuationContent(
                                scriptBeforeContinue,
                                continued,
                                continuationWindow.resumeStageNumber,
                            );
                            fullScript = merged;
                            publishSnapshot(fullScript);
                        } catch (continueErr) {
                            if (generationAbort.signal.aborted) throw continueErr;
                            continuationError = continueErr;
                            console.warn("[training-generate] 剧本断点续写失败，准备继续续写重试:", continueErr);
                            if (continued.trim()) {
                                try {
                                    const candidate = mergeScriptContinuationContent(
                                        scriptBeforeContinue,
                                        continued,
                                        continuationWindow.resumeStageNumber,
                                    );
                                    if (getScriptContinuationWindow(candidate).resumeStageNumber > continuationWindow.resumeStageNumber ||
                                        scoreScriptCompleteness(candidate) >= scoreScriptCompleteness(scriptBeforeContinue)) {
                                        fullScript = candidate;
                                    }
                                } catch (mergeErr) {
                                    console.warn("[training-generate] 保留中断续写片段失败:", mergeErr);
                                }
                            }
                            publishSnapshot(fullScript);
                        }

                        const advanced = validateScriptStructure(fullScript).ok ||
                            getScriptContinuationWindow(fullScript).resumeStageNumber > continuationWindow.resumeStageNumber;
                        stalledContinuationAttempts = advanced ? 0 : stalledContinuationAttempts + 1;
                        if (stalledContinuationAttempts >= 3) {
                            throw new Error(`模型连续三轮未补全${rangeLabel}，已保留已有剧本。可点击“断点续写”继续。`);
                        }

                        if (continuationError) {
                            const mergeFailure = continuationError instanceof Error && /^续写结果/.test(continuationError.message);
                            if (!isRetryableStreamError(continuationError) && !mergeFailure) {
                                throw continuationError;
                            }
                            if (continuationAttempt < maxContinuationAttempts && Date.now() <= scriptContinueDeadline) {
                                send({
                                    type: 'start',
                                    phase: 'script',
                                    message: `断点续写请求失败（可能网关超时），正在继续续写重试（${continuationAttempt + 1}/${maxContinuationAttempts}）...`,
                                });
                                continue;
                            }
                            throw continuationError;
                        }
                    }

                    fullScript = normalizeGeneratedScript(fullScript);
                    const finalScriptValidation = validateScriptStructure(fullScript);
                    if (!finalScriptValidation.ok) {
                        throw new Error(`生成结果疑似截断：${finalScriptValidation.reason || "剧本结构不完整"}，请重试`);
                    }
                    fullScript = alignTrainingScriptWithPlan(fullScript, modulePlan);
                    send({ type: 'phase_complete', phase: 'script', fullContent: fullScript });
                }

                // 2. 生成评分标准
                if (generateRubric) {
                    if (requestMode === "resume_script") {
                        send({ type: 'phase_snapshot', phase: 'rubric', fullContent: '' });
                    }
                    let rubricContinueDeadline: number | null = null;
                    fullRubric = await generatePhaseWithRetry(
                        'rubric',
                        '开始生成评分标准...',
                        (attempt, signal) => generateTrainingRubricStream(
                            teacherDocContent,
                            apiConfig,
                            rubricPromptTemplate || undefined,
                            priorRubric,
                            userSuggestions,
                            { signal, maxTokens: attempt > 1 ? 8000 : undefined },
                        )
                    );

                    for (let continuationAttempt = 1; continuationAttempt <= maxContinuationAttempts; continuationAttempt++) {
                        if (isRubricStructurallyValid(fullRubric)) {
                            break;
                        }

                        if (!rubricContinueDeadline) {
                            rubricContinueDeadline = Date.now() + continuationWindowMs;
                        }

                        if (Date.now() > rubricContinueDeadline) {
                            throw new Error('生成结果疑似截断：评分标准结构不完整（续写超时），请重试');
                        }

                        send({
                            type: 'start',
                            phase: 'rubric',
                            message: `检测到评分标准结果可能截断，正在断点续写（${continuationAttempt}/${maxContinuationAttempts}）...`,
                        });
                        let continued = "";
                        try {
                            for await (const chunk of guardTrainingStream((signal) => continueTrainingRubricStream(
                                teacherDocContent,
                                fullRubric,
                                apiConfig,
                                rubricPromptTemplate || undefined,
                                { signal, maxTokens: 8000 },
                            ), {
                                signal: generationAbort.signal,
                                timeoutMs: Math.min(150_000, rubricContinueDeadline - Date.now()),
                                onProgress: ({ elapsedMs, receivedChars }) => send({
                                    type: 'progress', phase: 'rubric',
                                    message: `正在断点续写评分标准，本轮 ${Math.floor(elapsedMs / 1000)} 秒，已接收 ${receivedChars} 字符...`,
                                }),
                            })) {
                                continued += chunk;
                                send({ type: 'chunk', phase: 'rubric', content: chunk });
                            }
                            fullRubric = cleanupMarkdownFence(`${fullRubric}\n${continued}`);
                        } catch (continueErr) {
                            if (generationAbort.signal.aborted) throw continueErr;
                            if (continued.trim()) fullRubric = cleanupMarkdownFence(`${fullRubric}\n${continued}`);
                            console.warn("[training-generate] 评分标准断点续写失败，准备继续续写重试:", continueErr);
                            if (isRetryableStreamError(continueErr) && continuationAttempt < maxContinuationAttempts && Date.now() <= rubricContinueDeadline) {
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
                close();

            } catch (error) {
                if (!streamClosed) {
                    console.error("生成配置失败:", error);
                    write(`data: ${JSON.stringify({ type: 'error', message: formatStreamErrorMessage(error) })}\n\n`);
                    close();
                }
            } finally {
                if (heartbeatTimer) clearInterval(heartbeatTimer);
                request.signal.removeEventListener('abort', stopStreaming);
            }
        },
        cancel() {
            stopStreaming();
            request.signal.removeEventListener('abort', stopStreaming);
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
            'Connection': 'keep-alive',
        },
    });
}
