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
    repairTrainingScriptStructure,
    validateTrainingScriptPlan,
} from "@/lib/training-generator/generator";
import { extractScriptStructure } from "@/lib/training-generator/script-tools";
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
                const continuationWindowMs = 600_000;
                const maxContinuationAttempts = 12;

                const extractStageNumber = (heading: string): number | null => {
                    const match = heading.match(/^###\s*阶段\s*(\d+)(?:\b|[：:])/i);
                    if (!match) return null;
                    const value = Number.parseInt(match[1], 10);
                    return Number.isFinite(value) ? value : null;
                };

                const validateScriptStructure = (content: string): { ok: boolean; reason?: string } => {
                    const parsedTask = parseTaskConfig(content);
                    const parsedSteps = parseTrainingScript(content);
                    const structure = extractScriptStructure(content);
                    const stageCount = structure.stages.length || parsedSteps.length;
                    const stageOneMatches = structure.stages.filter((stage) => /^###\s*阶段\s*1(?:\b|[：:])/i.test(stage.heading));

                    if (!parsedTask?.trainTaskName) {
                        return { ok: false, reason: "缺少任务名称" };
                    }

                    if (parsedSteps.length === 0) {
                        return { ok: false, reason: "未解析到任何阶段" };
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

                const findStrongTextOverlap = (previous: string, continuation: string): number => {
                    const base = previous.trimEnd();
                    const addition = continuation.trimStart();
                    const maxOverlap = Math.min(base.length, addition.length, 4000);

                    for (let len = maxOverlap; len >= 80; len--) {
                        if (base.slice(-len) === addition.slice(0, len)) {
                            return len;
                        }
                    }

                    return 0;
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
                    const stageOneMatches = cleaned.match(/^###\s*阶段\s*1(?:\b|[：:])/gim) || [];
                    const validation = validateScriptStructure(cleaned);

                    let score = scoreScriptCompleteness(cleaned);
                    score += parsedSteps.length * 4;
                    score += structure.stages.length * 2;
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
                    const stageOneMatches = Array.from(clean.matchAll(/^###\s*阶段\s*1(?:\b|[：:]).*$/gim));
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

                const mergeScriptContinuationContent = (previousContent: string, continuationContent: string): string => {
                    const previous = applyScriptContinuationGuards(previousContent);
                    const continuation = cleanupMarkdownFence(continuationContent);
                    if (!continuation.trim()) {
                        return previous;
                    }

                    const guardedCandidates: string[] = [];
                    const pushGuardedCandidate = (candidate: string) => {
                        const guarded = applyScriptContinuationGuards(candidate);
                        if (guarded.trim()) {
                            guardedCandidates.push(guarded);
                        }
                    };

                    pushGuardedCandidate(`${previous}\n${continuation}`);

                    const overlap = findStrongTextOverlap(previous, continuation);
                    if (overlap > 0) {
                        pushGuardedCandidate(`${previous}\n${continuation.trimStart().slice(overlap)}`);
                    }

                    const previousStructure = extractScriptStructure(previous);
                    const continuationStructure = extractScriptStructure(continuation);

                    if (previousStructure.stages.length > 0 && continuationStructure.stages.length > 0) {
                        const previousStageIndexByNumber = new Map<number, number>();
                        previousStructure.stages.forEach((stage, index) => {
                            const stageNumber = extractStageNumber(stage.heading);
                            if (stageNumber !== null && !previousStageIndexByNumber.has(stageNumber)) {
                                previousStageIndexByNumber.set(stageNumber, index);
                            }
                        });

                        continuationStructure.stages.forEach((stage, index) => {
                            const stageNumber = extractStageNumber(stage.heading);
                            if (stageNumber === null) return;
                            const previousIndex = previousStageIndexByNumber.get(stageNumber);
                            if (previousIndex === undefined) return;

                            const mergedStages = [
                                ...previousStructure.stages.slice(0, previousIndex).map((item) => item.markdown.trim()),
                                ...continuationStructure.stages.slice(index).map((item) => item.markdown.trim()),
                            ].filter(Boolean);

                            if (mergedStages.length === 0) return;

                            pushGuardedCandidate([
                                previousStructure.prefix,
                                mergedStages.join("\n\n"),
                                continuationStructure.suffix || previousStructure.suffix,
                            ].filter(Boolean).join("\n\n"));
                        });
                    }

                    return chooseBestScriptCandidate([previous, ...guardedCandidates]);
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
                                if (phase === 'script') {
                                    if (attempt === 1) {
                                        send({ type: 'chunk', phase, content: chunk });
                                    }
                                } else {
                                    send({ type: 'chunk', phase, content: chunk });
                                }
                            }

                            return phase === 'script'
                                ? applyScriptContinuationGuards(fullContent)
                                : cleanupMarkdownFence(fullContent);
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
                    let scriptContinueDeadline: number | null = null;
                    let scriptStructureRepairAttempted = false;
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
                    fullScript = applyScriptContinuationGuards(fullScript);

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
                                fullScript = applyScriptContinuationGuards(await repairTrainingScriptStructure(
                                    teacherDocContent,
                                    fullScript,
                                    apiConfig,
                                    scriptPromptTemplate || undefined,
                                    resolvedScriptMode || "general",
                                    modulePlan
                                ));
                                continue;
                            } catch (repairErr) {
                                console.warn("[training-generate] 剧本结构修复失败，回退续写/重试策略:", repairErr);
                            }
                        }

                        if (!scriptContinueDeadline) {
                            scriptContinueDeadline = Date.now() + continuationWindowMs;
                        }

                        if (Date.now() > scriptContinueDeadline) {
                            throw new Error(`生成结果疑似截断：${scriptValidation.reason || "剧本结构不完整"}（续写超时），请重试`);
                        }

                        send({
                            type: 'start',
                            phase: 'script',
                            message: `检测到剧本结果可能截断（${scriptValidation.reason || "结构不完整"}），正在断点续写（${continuationAttempt}/${maxContinuationAttempts}）...`,
                        });

                        try {
                            const scriptBeforeContinue = fullScript;
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
                            }

                            const merged = mergeScriptContinuationContent(scriptBeforeContinue, continued);
                            const delta = merged.startsWith(scriptBeforeContinue)
                                ? merged.slice(scriptBeforeContinue.length)
                                : "";

                            if (delta.trim()) {
                                send({ type: 'chunk', phase: 'script', content: delta });
                            }

                            fullScript = merged;
                        } catch (continueErr) {
                            console.warn("[training-generate] 剧本断点续写失败，准备继续续写重试:", continueErr);
                            if (continuationAttempt < maxContinuationAttempts && Date.now() <= scriptContinueDeadline) {
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

                    fullScript = applyScriptContinuationGuards(fullScript);
                    const finalScriptValidation = validateScriptStructure(fullScript);
                    if (!finalScriptValidation.ok) {
                        throw new Error(`生成结果疑似截断：${finalScriptValidation.reason || "剧本结构不完整"}，请重试`);
                    }
                    send({ type: 'phase_complete', phase: 'script', fullContent: fullScript });
                }

                // 2. 生成评分标准
                if (generateRubric) {
                    let rubricContinueDeadline: number | null = null;
                    fullRubric = await generatePhaseWithRetry(
                        'rubric',
                        '开始生成评分标准...',
                        () => generateTrainingRubricStream(teacherDocContent, apiConfig, rubricPromptTemplate || undefined)
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
                            if (continuationAttempt < maxContinuationAttempts && Date.now() <= rubricContinueDeadline) {
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
