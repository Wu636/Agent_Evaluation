/**
 * POST /api/training-inject
 * 训练配置注入 - SSE 流式进度 API
 */

import { NextRequest } from "next/server";
import { parseTrainingScript, parseRubricMarkdown, parseTaskConfig, parseTrainingScriptFlowConfig } from "@/lib/training-injector/parser";
import { extractScriptConfig, extractRubricConfig, LLMSettings } from "@/lib/training-injector/llm-extractor";
import {
    queryScriptSteps,
    queryScriptFlows,
    extractStartEndIds,
    getScriptNodes,
    deleteScriptStep,
    deleteScriptFlow,
    createScriptStep,
    createCustomDigitalHuman,
    listOwnerDigitalHumans,
    editScriptStep,
    createScriptFlow,
    createScoreItem,
    editConfiguration,
    generateBackgroundImage,
    generateCourseCoverImageSource,
    generateAndSyncDigitalHumanAvatar,
    uploadCoverImageFromUrl,
    queryTrainingTaskConfiguration,
    parsePolymasUrl,
} from "@/lib/training-injector/api";
import { InjectProgressEvent, ParsedFlowConfig, ParsedFlowEdge, PolymasCredentials, PolymasScriptStep } from "@/lib/training-injector/types";

export const maxDuration = 300;
export const runtime = "nodejs";

function normalizeStageNameForAppend(value: unknown): string {
    return String(value || "")
        .trim()
        .replace(/^阶段\s*[\d一二三四五六七八九十]+[：:、.\-\s]*/u, "")
        .replace(/\s+/g, "")
        .toLowerCase();
}

function normalizeDigitalHumanNameForReuse(value: unknown): string {
    return String(value || "").trim().replace(/\s+/g, "");
}

type OwnerDigitalHumanItem = Awaited<ReturnType<typeof listOwnerDigitalHumans>>[number];

interface ResolvedDigitalHumanConfig {
    customNid: string;
    digitalHumanName: string;
    nameKey: string;
    avatarNid: string;
    voiceNid: string;
    agentVoiceId?: string;
    voiceName?: string;
    source: "existing" | "created";
}

function cleanDigitalHumanValue(value: unknown): string {
    return String(value || "").trim();
}

function cleanLooseTaskConfigValue(value: string): string {
    return String(value || "")
        .replace(/^[-*+•]\s*/, "")
        .replace(/^#{1,6}\s*/, "")
        .replace(/\*\*/g, "")
        .replace(/^["'“”`]+|["'“”`]+$/g, "")
        .trim();
}

function readLooseTaskConfigLineValue(line: string, labels: string[]): string | null {
    const normalized = cleanLooseTaskConfigValue(line);
    for (const label of labels) {
        const pattern = new RegExp(`^${label}\\s*[：:]\\s*(.+)$`);
        const match = normalized.match(pattern);
        if (match?.[1]) return cleanLooseTaskConfigValue(match[1]);
    }
    return null;
}

function extractLooseTaskConfig(markdown: string): { trainTaskName: string; description: string } | null {
    const lines = String(markdown || "").split("\n");
    const nameLabels = ["任务名称", "训练任务名称", "能力训练名称"];
    const descriptionLabels = ["任务描述", "任务目标", "训练任务描述", "能力训练描述", "实训目标"];
    const stopLabels = ["智能体角色", "目标受众", "训练阶段", "模块规划", "评价标准", "评分标准", "非线性跳转关系"];
    let trainTaskName = "";
    let description = "";
    let collectingDescription = false;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("```")) continue;

        const nameValue = readLooseTaskConfigLineValue(trimmed, nameLabels);
        if (nameValue !== null) {
            trainTaskName = nameValue;
            collectingDescription = false;
            continue;
        }

        const descriptionValue = readLooseTaskConfigLineValue(trimmed, descriptionLabels);
        if (descriptionValue !== null) {
            description = descriptionValue;
            collectingDescription = true;
            continue;
        }

        const cleaned = cleanLooseTaskConfigValue(trimmed);
        if (collectingDescription) {
            const isNewField = /^[\u4e00-\u9fa5A-Za-z0-9（）()\/\s_-]{1,30}\s*[：:]/.test(cleaned);
            const isStopLine = stopLabels.some((label) => cleaned.includes(label)) || /^#{2,6}\s*\S/.test(trimmed);
            if (isNewField || isStopLine) {
                collectingDescription = false;
                continue;
            }
            if (cleaned) {
                description = description ? `${description}\n${cleaned}` : cleaned;
            }
        }
    }

    if (!trainTaskName) {
        const titleMatch = String(markdown || "").match(/^#\s+(.+?)(?:\s*-\s*训练剧本配置)?\s*$/m);
        if (titleMatch?.[1]) {
            trainTaskName = cleanLooseTaskConfigValue(titleMatch[1]);
        }
    }

    return trainTaskName || description ? { trainTaskName, description } : null;
}

function buildDigitalHumanExactKey(nameKey: string, voiceNid: string, avatarNid: string): string {
    return `${nameKey}::${voiceNid}::${avatarNid}`;
}

function toResolvedDigitalHumanConfig(item: OwnerDigitalHumanItem): ResolvedDigitalHumanConfig | null {
    const customNid = cleanDigitalHumanValue(item.customNid || item.bizId);
    const digitalHumanName = cleanDigitalHumanValue(item.digitalHumanName);
    const nameKey = normalizeDigitalHumanNameForReuse(digitalHumanName);
    const avatarNid = cleanDigitalHumanValue(item.avatarNid);
    const voiceNid = cleanDigitalHumanValue(item.voiceNid);
    if (!customNid || !nameKey || !avatarNid || !voiceNid) return null;

    const agentVoiceId = cleanDigitalHumanValue(item.bigModelVoiceParam) || undefined;

    return {
        customNid,
        digitalHumanName,
        nameKey,
        avatarNid,
        voiceNid,
        agentVoiceId,
        voiceName: cleanDigitalHumanValue(item.voiceName) || undefined,
        source: "existing",
    };
}

function findReusableDigitalHumanByName(
    configs: ResolvedDigitalHumanConfig[],
    nameKey: string
): ResolvedDigitalHumanConfig | null {
    if (!nameKey) return null;
    const exactMatch = configs.find((item) => item.nameKey === nameKey);
    if (exactMatch) return exactMatch;

    if (nameKey.length < 2) return null;
    return configs.find((item) => (
        item.nameKey.length >= 2 &&
        (item.nameKey.includes(nameKey) || nameKey.includes(item.nameKey))
    )) || null;
}

function describeDigitalHuman(config: ResolvedDigitalHumanConfig): string {
    return config.voiceName
        ? `${config.digitalHumanName}（音色：${config.voiceName}）`
        : config.digitalHumanName;
}

function getNodeX(step: PolymasScriptStep): number {
    const raw = step.positionDTO?.x;
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
}

function getNodeY(step: PolymasScriptStep): number {
    const raw = step.positionDTO?.y;
    const value = Number(raw);
    return Number.isFinite(value) ? value : 300;
}

function findLastScriptNode(scriptNodes: PolymasScriptStep[]): PolymasScriptStep | null {
    if (scriptNodes.length === 0) return null;
    return [...scriptNodes].sort((a, b) => getNodeX(b) - getNodeX(a))[0] || null;
}

function isDefaultFlow(value: unknown): boolean {
    return value === 1 || value === true || String(value || "").trim() === "1";
}

const FLOW_START_ALIASES = new Set(["start", "script_start", "开始", "起点", "训练开始"]);
const FLOW_END_ALIASES = new Set(["end", "script_end", "__end__", "task_complete", "结束", "训练结束", "本次实训到此结束"]);
const CHINESE_ORDINALS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

type ResolvedFlowEndpoint = number | "START" | "END" | null;

function normalizeFlowEndpointKey(value: unknown): string {
    return String(value || "")
        .trim()
        .replace(/^["'“”`]+|["'“”`]+$/g, "")
        .replace(/^第\s*([0-9一二三四五六七八九十]+)\s*阶段/u, "阶段$1")
        .replace(/^stage[_\s-]*(\d+)$/i, "阶段$1")
        .replace(/^step[_\s-]*(\d+)$/i, "阶段$1")
        .replace(/^module[_\s-]*(\d+)$/i, "阶段$1")
        .replace(/\s+/g, "")
        .toLowerCase();
}

function getStepFlowReferenceKeys(step: any, index: number): string[] {
    const stageNumber = index + 1;
    const chineseNumber = CHINESE_ORDINALS[stageNumber] || String(stageNumber);
    const stepName = String(step?.stepName || "").trim();
    return Array.from(new Set([
        `阶段${stageNumber}`,
        `第${stageNumber}阶段`,
        `阶段${chineseNumber}`,
        `第${chineseNumber}阶段`,
        `stage${stageNumber}`,
        `step${stageNumber}`,
        `module${stageNumber}`,
        `module_${stageNumber}`,
        stepName,
        normalizeStageNameForAppend(stepName),
    ].map(normalizeFlowEndpointKey).filter(Boolean)));
}

function resolveFlowEndpoint(value: unknown, steps: any[]): ResolvedFlowEndpoint {
    const key = normalizeFlowEndpointKey(value);
    if (!key) return null;
    if (FLOW_START_ALIASES.has(key)) return "START";
    if (FLOW_END_ALIASES.has(key)) return "END";

    for (let index = 0; index < steps.length; index++) {
        if (getStepFlowReferenceKeys(steps[index], index).includes(key)) {
            return index;
        }
    }

    return null;
}

function resolveScriptFlowEdges(flowConfig: ParsedFlowConfig, steps: any[]): Array<{
    from: Exclude<ResolvedFlowEndpoint, null>;
    to: Exclude<ResolvedFlowEndpoint, null>;
    edge: ParsedFlowEdge;
}> {
    if (flowConfig.flowType !== "graph") return [];

    return flowConfig.edges
        .map((edge) => ({
            from: resolveFlowEndpoint(edge.from, steps),
            to: resolveFlowEndpoint(edge.to, steps),
            edge,
        }))
        .filter((item): item is {
            from: Exclude<ResolvedFlowEndpoint, null>;
            to: Exclude<ResolvedFlowEndpoint, null>;
            edge: ParsedFlowEdge;
        } => item.from !== null && item.to !== null && item.from !== item.to);
}

function buildGraphStepPositions(
    steps: any[],
    resolvedEdges: Array<{ from: Exclude<ResolvedFlowEndpoint, null>; to: Exclude<ResolvedFlowEndpoint, null> }>,
    baseX: number,
    baseY: number,
    xGap: number
): Array<{ x: number; y: number }> {
    const incoming = new Map<number, number>();
    const outgoing = new Map<number, number[]>();

    steps.forEach((_, index) => {
        incoming.set(index, 0);
        outgoing.set(index, []);
    });

    resolvedEdges.forEach(({ from, to }) => {
        if (typeof from !== "number" || typeof to !== "number") return;
        outgoing.set(from, [...(outgoing.get(from) || []), to]);
        incoming.set(to, (incoming.get(to) || 0) + 1);
    });

    const layers = new Array(steps.length).fill(-1);
    const entryIndexes = steps
        .map((_, index) => index)
        .filter((index) => (incoming.get(index) || 0) === 0);
    const queue = (entryIndexes.length > 0 ? entryIndexes : [0]).filter((index) => index < steps.length);
    queue.forEach((index) => {
        layers[index] = 0;
    });

    let guard = 0;
    while (queue.length > 0 && guard < steps.length * steps.length) {
        guard += 1;
        const current = queue.shift()!;
        const nextLayer = (layers[current] >= 0 ? layers[current] : 0) + 1;
        for (const next of outgoing.get(current) || []) {
            if (layers[next] < nextLayer) {
                layers[next] = nextLayer;
                queue.push(next);
            }
        }
    }

    steps.forEach((_, index) => {
        if (layers[index] < 0) {
            layers[index] = index;
        }
    });

    const layerGroups = new Map<number, number[]>();
    layers.forEach((layer, index) => {
        layerGroups.set(layer, [...(layerGroups.get(layer) || []), index]);
    });

    const positions = new Array(steps.length).fill(null).map((_, index) => ({ x: baseX + index * xGap, y: baseY }));
    Array.from(layerGroups.entries()).forEach(([layer, indexes]) => {
        indexes.forEach((stepIndex, rank) => {
            const yOffset = (rank - (indexes.length - 1) / 2) * 220;
            positions[stepIndex] = {
                x: baseX + layer * xGap,
                y: baseY + yOffset,
            };
        });
    });

    return positions;
}

export async function POST(request: NextRequest) {
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            const send = (event: InjectProgressEvent) => {
                try {
                    controller.enqueue(
                        encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
                    );
                } catch {
                    // 忽略已关闭的 stream
                }
            };

            try {
                const body = await request.json();
                const {
                    trainTaskId,
                    courseId,
                    libraryFolderId,
                    credentials,
                    llmSettings,
                    extractionMode = "hybrid",
                    coverStylePrompt,
                    backgroundStylePrompt,
                    imageModel,
                    imageProviderPriority,
                    injectCoverImage = true,
                    injectBackgroundImage = true,
                    deferBaseConfigurationUntilCoverReady = false,
                    digitalHumanAvatarMode = "existing",
                    digitalHumanAvatarStylePrompt,
                    scriptMarkdown,
                    rubricMarkdown,
                    injectMode = "replace",
                } = body as {
                    trainTaskId: string;
                    courseId?: string;
                    libraryFolderId?: string;
                    credentials: PolymasCredentials;
                    llmSettings?: LLMSettings;
                    extractionMode?: "hybrid" | "llm" | "regex";
                    coverStylePrompt?: string;
                    backgroundStylePrompt?: string;
                    imageModel?: string;
                    imageProviderPriority?: string;
                    injectCoverImage?: boolean;
                    injectBackgroundImage?: boolean;
                    deferBaseConfigurationUntilCoverReady?: boolean;
                    digitalHumanAvatarMode?: "existing" | "ai";
                    digitalHumanAvatarStylePrompt?: string;
                    scriptMarkdown?: string;
                    rubricMarkdown?: string;
                    injectMode: "replace" | "append";
                };

                if (!trainTaskId || !credentials?.authorization || !credentials?.cookie) {
                    send({ type: "error", message: "缺少必要参数：trainTaskId 或平台凭证" });
                    controller.close();
                    return;
                }

                // 服务端兜底：如果前端传来的是完整 URL，在此解析出真正的 ID
                let finalTrainTaskId = trainTaskId;
                let finalCourseId = courseId || "";
                let finalLibraryFolderId = libraryFolderId || "";
                if (trainTaskId.includes("http") || trainTaskId.includes("?") || trainTaskId.length > 50) {
                    const parsed = parsePolymasUrl(trainTaskId);
                    if (parsed?.trainTaskId) {
                        finalTrainTaskId = parsed.trainTaskId;
                        finalCourseId = finalCourseId || parsed.courseId;
                        finalLibraryFolderId = finalLibraryFolderId || parsed.libraryFolderId;
                        console.log("[inject-route] URL parsed -> trainTaskId:", finalTrainTaskId, "courseId:", finalCourseId);
                    }
                }

                console.log("[inject-route] trainTaskId:", finalTrainTaskId, "length:", finalTrainTaskId.length);
                console.log("[inject-route] Received llmSettings:", llmSettings ? { hasApiKey: !!llmSettings.apiKey, apiUrl: llmSettings.apiUrl, model: llmSettings.model } : "NONE");

                let stepsCreated = 0;
                let flowsCreated = 0;
                let scoreItemsCreated = 0;
                let stepsDeleted = 0;
                let flowsDeleted = 0;

                // ─── 训练剧本注入 ──────────────────────────────────────

                if (scriptMarkdown) {
                    let steps: any[] = [];
                    let taskConfig: any = null;
                    let flowConfig: ParsedFlowConfig = parseTrainingScriptFlowConfig(scriptMarkdown);
                    const hasLLM = !!(llmSettings?.apiKey && llmSettings?.apiUrl && llmSettings?.model);

                    if (extractionMode === "llm" && hasLLM) {
                        // 纯 LLM 模式：所有字段用 LLM 提取
                        send({ type: "progress", phase: "script", message: "正在使用 AI 智能提取训练剧本配置...", current: 0, total: 1 });
                        try {
                            const extracted = await extractScriptConfig(scriptMarkdown, llmSettings);
                            steps = extracted.steps;
                            taskConfig = extracted.taskConfig;
                            flowConfig = extracted.flowConfig?.flowType === "graph" ? extracted.flowConfig : flowConfig;
                            send({ type: "progress", phase: "script", message: "AI 提取成功！", current: 1, total: 1 });
                        } catch (err) {
                            console.warn("LLM 剧本提取失败，回退到正则解析:", err);
                            send({ type: "progress", phase: "script", message: "AI 提取失败，回退到正则解析...", current: 0, total: 1 });
                        }
                    }

                    // 正则解析（regex 模式直接使用，hybrid 模式始终使用，LLM 失败时回退）
                    if (steps.length === 0) {
                        send({ type: "progress", phase: "script", message: "正在解析训练剧本配置...", current: 0, total: 1 });
                        steps = parseTrainingScript(scriptMarkdown);
                        flowConfig = parseTrainingScriptFlowConfig(scriptMarkdown);
                    }

                    // 提取任务名称/描述：regex 和 hybrid 模式优先用正则
                    if (!taskConfig && (extractionMode === "regex" || extractionMode === "hybrid")) {
                        const regexConfig = parseTaskConfig(scriptMarkdown);
                        if (regexConfig) {
                            taskConfig = regexConfig;
                            send({ type: "progress", phase: "script", message: `正则提取任务名称：${regexConfig.trainTaskName || '(未找到)'}`, current: 0, total: 1 });
                        }
                    }

                    // hybrid 模式下，如果正则未提取到任务名称，尝试 LLM
                    if (extractionMode === "hybrid" && hasLLM && !taskConfig) {
                        try {
                            const extracted = await extractScriptConfig(scriptMarkdown, llmSettings);
                            taskConfig = extracted.taskConfig;
                            flowConfig = extracted.flowConfig?.flowType === "graph" ? extracted.flowConfig : flowConfig;
                        } catch (err) {
                            console.warn("LLM 任务名提取失败，继续:", err);
                        }
                    }

                    const looseTaskConfig = extractLooseTaskConfig(scriptMarkdown);
                    if (looseTaskConfig) {
                        taskConfig = {
                            trainTaskName:
                                String(taskConfig?.trainTaskName || "").trim() ||
                                looseTaskConfig.trainTaskName,
                            description:
                                String(taskConfig?.description || "").trim() ||
                                looseTaskConfig.description,
                        };
                        send({
                            type: "progress",
                            phase: "script",
                            message: `基础配置解析结果：${taskConfig.trainTaskName || "(未找到名称)"} / 描述${taskConfig.description ? "已提取" : "未提取"}`,
                            current: 0,
                            total: 1,
                        });
                    }

                    if (steps.length === 0) {
                        send({ type: "error", message: "训练剧本中未找到任何阶段，提取失败" });
                        controller.close();
                        return;
                    }

                    // 3.1 课程封面图：先生成源图，再走上传接口，最终用于 trainTaskCover
                    let trainTaskCover: { fileId: string; fileUrl: string } | null = null;
                    const shouldProcessCoverImage = injectCoverImage && injectMode !== "append";
                    if (!shouldProcessCoverImage) {
                        send({
                            type: "progress",
                            phase: "script",
                            message: injectMode === "append" && injectCoverImage
                                ? "追加模式已跳过课程封面图注入，避免覆盖已有封面"
                                : "已跳过课程封面图注入",
                            current: 0,
                            total: steps.length,
                        });
                    } else if (finalCourseId && taskConfig?.trainTaskName) {
                        send({ type: "progress", phase: "script", message: "正在生成课程封面图...", current: 0, total: steps.length });
                        try {
                            const coverSource = await generateCourseCoverImageSource(
                                {
                                    trainName: taskConfig.trainTaskName,
                                    trainDescription: taskConfig?.description || "",
                                    coverStylePrompt: (coverStylePrompt || "").trim() || undefined,
                                    arkApiKey: llmSettings?.apiKey,
                                    llmApiUrl: llmSettings?.apiUrl,
                                    imageModel: imageModel || undefined,
                                    imageProviderPriority,
                                },
                                credentials
                            );

                            if (coverSource?.fileUrl) {
                                if (coverSource.fileId) {
                                    trainTaskCover = {
                                        fileId: coverSource.fileId,
                                        fileUrl: coverSource.fileUrl,
                                    };
                                } else {
                                    send({ type: "progress", phase: "script", message: "正在上传课程封面图...", current: 0, total: steps.length });
                                    trainTaskCover = await uploadCoverImageFromUrl(coverSource.fileUrl, credentials);
                                }
                                if (trainTaskCover) {
                                    send({ type: "progress", phase: "script", message: "课程封面图准备完成", current: 0, total: steps.length });
                                } else {
                                    send({ type: "progress", phase: "script", message: "课程封面图上传失败，将跳过封面设置", current: 0, total: steps.length });
                                }
                            } else {
                                send({ type: "progress", phase: "script", message: "课程封面图生成失败，将跳过封面设置", current: 0, total: steps.length });
                            }
                        } catch (err) {
                            console.warn("课程封面图生成/上传失败:", err);
                            send({ type: "progress", phase: "script", message: "课程封面图处理异常，将跳过封面设置", current: 0, total: steps.length });
                        }
                    } else if (shouldProcessCoverImage) {
                        send({ type: "progress", phase: "script", message: "缺少课程ID或任务名称，跳过课程封面图注入", current: 0, total: steps.length });
                    }

                    // 3. 主注入路径完整更新基础配置：名称、描述、入口音色、封面图
                    if (finalCourseId && (taskConfig?.trainTaskName || taskConfig?.description || trainTaskCover)) {
                        send({ type: "progress", phase: "script", message: "正在更新任务基础配置（名称、描述、入口音色）...", current: 0, total: steps.length });
                        let currentConfig: Awaited<ReturnType<typeof queryTrainingTaskConfiguration>> | null = null;
                        if (!taskConfig?.trainTaskName || !taskConfig?.description || !trainTaskCover?.fileId) {
                            currentConfig = await queryTrainingTaskConfiguration(
                                {
                                    trainTaskId: finalTrainTaskId,
                                    courseId: finalCourseId,
                                },
                                credentials
                            );
                        }
                        const resolvedTrainTaskName =
                            String(taskConfig?.trainTaskName || "").trim() ||
                            String(currentConfig?.trainTaskName || "").trim();
                        const resolvedDescription =
                            String(taskConfig?.description || "").trim() ||
                            String(currentConfig?.description || "").trim();
                        const resolvedTrainTaskCover = trainTaskCover || currentConfig?.trainTaskCover || null;

                        if (resolvedTrainTaskName && resolvedDescription && resolvedTrainTaskCover?.fileId) {
                            const ok = await editConfiguration(
                                {
                                    trainTaskId: finalTrainTaskId,
                                    courseId: finalCourseId,
                                    trainTaskName: resolvedTrainTaskName,
                                    description: resolvedDescription,
                                    trainTaskCover: resolvedTrainTaskCover,
                                },
                                credentials
                            );
                            if (!ok) {
                                console.warn("[inject-route] 更新任务基础配置失败（前端不展示该提示）");
                                send({
                                    type: "progress",
                                    phase: "script",
                                    message: "任务基础配置写入失败，请检查 editConfiguration 接口返回",
                                    current: 0,
                                    total: steps.length,
                                });
                            } else {
                                send({
                                    type: "progress",
                                    phase: "script",
                                    message: `任务基础配置已写入：${resolvedTrainTaskName} / 描述${resolvedDescription ? "已写入" : "为空"}`,
                                    current: 0,
                                    total: steps.length,
                                });
                            }
                        } else {
                            const missingParts = [
                                resolvedTrainTaskName ? "" : "任务名称",
                                resolvedDescription ? "" : "任务描述",
                                resolvedTrainTaskCover?.fileId ? "" : "当前封面图",
                            ].filter(Boolean).join("、");
                            const isOnlyWaitingForDeferredCover =
                                deferBaseConfigurationUntilCoverReady &&
                                resolvedTrainTaskName &&
                                resolvedDescription &&
                                !resolvedTrainTaskCover?.fileId;
                            send({
                                type: "progress",
                                phase: "script",
                                message: isOnlyWaitingForDeferredCover
                                    ? "基础配置已提取，等待课程封面图生成后回写名称、描述和入场音色"
                                    : `基础配置缺少${missingParts}，已跳过名称/描述写入，避免触发平台配置接口错误`,
                                current: 0,
                                total: steps.length,
                            });
                        }
                    } else if (finalCourseId) {
                        send({ type: "progress", phase: "script", message: "未提取到任务名称/描述且无封面图，已跳过任务基础配置更新", current: 0, total: steps.length });
                    }

                    // 提前检测背景图能力
                    const canSetBgImage = !!(injectBackgroundImage && finalCourseId && finalLibraryFolderId);
                    const shouldGenerateDigitalHumanAvatar = digitalHumanAvatarMode === "ai";

                    // 查询现有节点和连线
                    send({ type: "progress", phase: "script", message: "正在查询现有工作流...", current: 0, total: steps.length });
                    const existingSteps = await queryScriptSteps(finalTrainTaskId, credentials);
                    const existingFlows = await queryScriptFlows(finalTrainTaskId, credentials);
                    const { startId, endId } = extractStartEndIds(existingSteps);

                    if (!startId || !endId) {
                        send({ type: "error", message: `未找到 START/END 节点（查询到 ${existingSteps.length} 个节点）。请确认：1) 任务链接/ID 正确；2) 已在平台上打开过该任务的工作流编辑页（系统会自动初始化 START/END）；3) 凭证未过期。` });
                        controller.close();
                        return;
                    }

                    const startIdsWithDefaultFlow = new Set(
                        existingFlows
                            .filter((flow) => isDefaultFlow(flow.isDefault))
                            .map((flow) => flow.scriptStepStartId)
                            .filter(Boolean)
                    );
                    let appendAnchorStepId: string | null = null;
                    let appendAnchorPosition: { x: number; y: number } | null = null;

                    // 全新创建模式：删除旧节点和连线
                    if (injectMode === "replace") {
                        const scriptNodes = getScriptNodes(existingSteps);
                        if (scriptNodes.length > 0 || existingFlows.length > 0) {
                            send({ type: "progress", phase: "script", message: `正在清除旧工作流（${existingFlows.length} 条连线，${scriptNodes.length} 个节点）...`, current: 0, total: steps.length });

                            // 先删连线
                            for (const flow of existingFlows) {
                                await deleteScriptFlow(finalTrainTaskId, flow.flowId, credentials);
                                flowsDeleted++;
                            }
                            startIdsWithDefaultFlow.clear();
                            // 再删节点
                            for (const step of scriptNodes) {
                                await deleteScriptStep(finalTrainTaskId, step.stepId, credentials);
                                stepsDeleted++;
                            }
                        }
                    } else {
                        const scriptNodes = getScriptNodes(existingSteps);
                        const existingStageNames = new Set(
                            scriptNodes
                                .map((step) => normalizeStageNameForAppend(step.stepDetailDTO?.stepName))
                                .filter(Boolean)
                        );
                        const originalStepCount = steps.length;
                        steps = steps.filter((step) => {
                            const normalizedName = normalizeStageNameForAppend(step?.stepName);
                            return !normalizedName || !existingStageNames.has(normalizedName);
                        });

                        const skippedCount = originalStepCount - steps.length;
                        if (skippedCount > 0) {
                            send({
                                type: "progress",
                                phase: "script",
                                message: `追加模式已跳过 ${skippedCount} 个已存在阶段，不会重新生成这些阶段的背景图`,
                                current: 0,
                                total: Math.max(steps.length, 1),
                            });
                        }

                        const lastExistingNode = findLastScriptNode(scriptNodes);
                        if (lastExistingNode) {
                            appendAnchorStepId = lastExistingNode.stepId;
                            appendAnchorPosition = {
                                x: getNodeX(lastExistingNode),
                                y: getNodeY(lastExistingNode),
                            };
                        }
                    }

                    if (injectMode === "append" && flowConfig.flowType === "graph") {
                        send({
                            type: "progress",
                            phase: "script",
                            message: "检测到非线性跳转关系；追加模式下将按线性方式接入新增阶段，避免误连已存在节点",
                            current: 0,
                            total: Math.max(steps.length, 1),
                        });
                        flowConfig = { flowType: "linear", edges: [] };
                    }

                    // 创建节点
                    const X_START = 100;
                    const Y_START = 300;
                    const X_GAP = 400;
                    const baseX = appendAnchorPosition ? appendAnchorPosition.x + X_GAP : X_START;
                    const baseY = appendAnchorPosition ? appendAnchorPosition.y : Y_START;
                    const resolvedGraphEdges = resolveScriptFlowEdges(flowConfig, steps);
                    const useGraphFlow = flowConfig.flowType === "graph" && resolvedGraphEdges.length > 0;
                    const plannedPositions = useGraphFlow
                        ? buildGraphStepPositions(steps, resolvedGraphEdges, baseX, baseY, X_GAP)
                        : [];
                    const createdStepIds: string[] = [];
                    const customDigitalHumanCache = new Map<string, ResolvedDigitalHumanConfig>();
                    const existingDigitalHumanByExactKey = new Map<string, ResolvedDigitalHumanConfig>();
                    const existingDigitalHumanByName = new Map<string, ResolvedDigitalHumanConfig>();
                    const reusableDigitalHumanConfigs: ResolvedDigitalHumanConfig[] = [];
                    const generatedAvatarCache = new Map<string, { avatarNid: string; avatarUrl: string }>();

                    if (steps.length === 0) {
                        send({
                            type: "phase_complete",
                            phase: "script",
                            message: injectMode === "append"
                                ? "追加模式下未发现需要新增的阶段，已跳过训练剧本节点注入"
                                : "训练剧本中未找到需要注入的阶段",
                        });
                    } else {
                    if (finalCourseId) {
                        send({
                            type: "progress",
                            phase: "script",
                            message: "正在查询课程已有数字人，优先复用同名配置...",
                            current: 0,
                            total: steps.length,
                        });

                        try {
                            const ownerDigitalHumans = await listOwnerDigitalHumans(
                                {
                                    courseId: finalCourseId,
                                    libraryFolderId: finalLibraryFolderId,
                                },
                                credentials
                            );

                            for (const item of ownerDigitalHumans) {
                                const config = toResolvedDigitalHumanConfig(item);
                                if (!config) continue;

                                const exactKey = buildDigitalHumanExactKey(
                                    config.nameKey,
                                    config.voiceNid,
                                    config.avatarNid
                                );
                                reusableDigitalHumanConfigs.push(config);
                                if (!existingDigitalHumanByExactKey.has(exactKey)) {
                                    existingDigitalHumanByExactKey.set(exactKey, config);
                                }
                                if (!existingDigitalHumanByName.has(config.nameKey)) {
                                    existingDigitalHumanByName.set(config.nameKey, config);
                                }
                            }

                            if (ownerDigitalHumans.length > 0) {
                                send({
                                    type: "progress",
                                    phase: "script",
                                    message: `已读取 ${ownerDigitalHumans.length} 个已有数字人，其中 ${reusableDigitalHumanConfigs.length} 个可作为账号内安全参数源`,
                                    current: 0,
                                    total: steps.length,
                                });
                            }
                        } catch (digitalHumanListErr) {
                            console.warn("[inject-route] 查询已有数字人异常:", digitalHumanListErr);
                            send({
                                type: "progress",
                                phase: "script",
                                message: "查询已有数字人失败，将按需新建数字人",
                                current: 0,
                                total: steps.length,
                            });
                        }
                    }

                    send({
                        type: "start",
                        phase: "script",
                        message: `开始注入训练剧本，共 ${steps.length} 个新增阶段...`,
                        total: steps.length,
                    });

                    for (let i = 0; i < steps.length; i++) {
                        const step = steps[i];

                        // 生成背景图（仅在有 courseId + libraryFolderId 时才生成）
                        let bgImage: { fileId: string; fileUrl: string } | null = null;
                        if (canSetBgImage) {
                            send({
                                type: "progress",
                                phase: "script",
                                message: `正在为「${step.stepName}」生成背景图 (${i + 1}/${steps.length})...`,
                                current: i + 1,
                                total: steps.length,
                            });

                            try {
                                const trainName = taskConfig?.trainTaskName || "训练任务";
                                const trainDesc = taskConfig?.description || "";
                                bgImage = await generateBackgroundImage(
                                    {
                                        trainName,
                                        trainDescription: trainDesc,
                                        stageName: step.stepName,
                                        stageDescription: step.description || "",
                                        backgroundStylePrompt: (backgroundStylePrompt || "").trim() || undefined,
                                        arkApiKey: llmSettings?.apiKey,
                                        llmApiUrl: llmSettings?.apiUrl,
                                        imageModel: imageModel || undefined,
                                        imageProviderPriority,
                                    },
                                    credentials
                                );
                            if (bgImage) {
                                send({ type: "progress", phase: "script", message: `背景图生成成功`, current: i + 1, total: steps.length });
                            } else {
                                send({ type: "progress", phase: "script", message: `背景图生成跳过（返回为空）`, current: i + 1, total: steps.length });
                            }
                            } catch (err) {
                                console.warn("背景图生成失败:", err);
                                send({ type: "progress", phase: "script", message: `背景图生成失败，将跳过`, current: i + 1, total: steps.length });
                            }
                        } // end canSetBgImage

                        // 创建节点
                        send({
                            type: "progress",
                            phase: "script",
                            message: `正在创建节点 ${i + 1}/${steps.length}：${step.stepName}`,
                            current: i + 1,
                            total: steps.length,
                        });

                        const position = plannedPositions[i] || { x: baseX + i * X_GAP, y: baseY };
                        const trainerName = step.trainerName || "训练引导员";
                        const requestedAgentId = cleanDigitalHumanValue(step.agentId);
                        const requestedAvatarNid = cleanDigitalHumanValue(step.avatarNid);
                        const digitalHumanNameKey = normalizeDigitalHumanNameForReuse(trainerName);
                        const requestedExactKey = buildDigitalHumanExactKey(
                            digitalHumanNameKey,
                            requestedAgentId,
                            requestedAvatarNid
                        );
                        const exactExistingDigitalHuman =
                            (requestedAgentId && requestedAvatarNid
                                ? existingDigitalHumanByExactKey.get(requestedExactKey)
                                : null) ||
                            findReusableDigitalHumanByName(reusableDigitalHumanConfigs, digitalHumanNameKey) ||
                            existingDigitalHumanByName.get(digitalHumanNameKey) ||
                            null;
                        const fallbackDigitalHuman = exactExistingDigitalHuman || reusableDigitalHumanConfigs[0] || null;
                        let digitalHumanConfig =
                            customDigitalHumanCache.get(digitalHumanNameKey) ||
                            (shouldGenerateDigitalHumanAvatar ? null : exactExistingDigitalHuman) ||
                            null;
                        let agentId = fallbackDigitalHuman?.voiceNid || requestedAgentId || "Tg3LpKo28D";
                        let avatarNid = fallbackDigitalHuman?.avatarNid || requestedAvatarNid || "hnuOVqMu8b";
                        let agentVoiceId = fallbackDigitalHuman?.agentVoiceId;

                        if (!digitalHumanConfig && shouldGenerateDigitalHumanAvatar) {
                            let generatedAvatar = generatedAvatarCache.get(digitalHumanNameKey) || null;
                            if (!generatedAvatar) {
                                send({
                                    type: "progress",
                                    phase: "script",
                                    message: `正在为数字人「${trainerName}」生成并上传 AI 头像...`,
                                    current: i + 1,
                                    total: steps.length,
                                });
                                try {
                                    const trainName = taskConfig?.trainTaskName || "训练任务";
                                    const trainDesc = taskConfig?.description || "";
                                    const result = await generateAndSyncDigitalHumanAvatar(
                                        {
                                            trainName,
                                            trainDescription: trainDesc,
                                            trainerName,
                                            stageName: step.stepName,
                                            stageDescription: step.description || "",
                                            courseId: finalCourseId,
                                            libraryFolderId: finalLibraryFolderId,
                                            baseAvatarNid: avatarNid,
                                            avatarStylePrompt: String(digitalHumanAvatarStylePrompt || "").trim() || undefined,
                                            arkApiKey: llmSettings?.apiKey,
                                            llmApiUrl: llmSettings?.apiUrl,
                                            imageModel: imageModel || undefined,
                                            imageProviderPriority,
                                            userNid: credentials.userNid,
                                        },
                                        credentials
                                    );
                                    if (result?.avatarNid) {
                                        generatedAvatar = {
                                            avatarNid: result.avatarNid,
                                            avatarUrl: result.avatarUrl,
                                        };
                                        generatedAvatarCache.set(digitalHumanNameKey, generatedAvatar);
                                        send({
                                            type: "progress",
                                            phase: "script",
                                            message: `AI 头像已同步：${trainerName}`,
                                            current: i + 1,
                                            total: steps.length,
                                        });
                                    } else {
                                        send({
                                            type: "progress",
                                            phase: "script",
                                            message: `AI 头像生成或同步失败，将改用账号已有数字人参数：${trainerName}`,
                                            current: i + 1,
                                            total: steps.length,
                                        });
                                    }
                                } catch (avatarErr) {
                                    console.warn("[inject-route] AI 数字人头像生成/同步异常:", avatarErr);
                                    send({
                                        type: "progress",
                                        phase: "script",
                                        message: `AI 头像生成异常，将改用账号已有数字人参数：${trainerName}`,
                                        current: i + 1,
                                        total: steps.length,
                                    });
                                }
                            }

                            if (generatedAvatar?.avatarNid) {
                                avatarNid = generatedAvatar.avatarNid;
                            } else if (exactExistingDigitalHuman) {
                                digitalHumanConfig = exactExistingDigitalHuman;
                            }
                        }

                        if (!digitalHumanConfig) {
                            send({
                                type: "progress",
                                phase: "script",
                                message: shouldGenerateDigitalHumanAvatar
                                    ? `正在配置数字人：${trainerName}（使用 AI 头像和账号内可用音色）`
                                    : fallbackDigitalHuman
                                    ? `正在配置数字人：${trainerName}（使用账号内「${describeDigitalHuman(fallbackDigitalHuman)}」的可用形象/音色参数）`
                                    : `正在配置数字人：${trainerName}`,
                                current: i + 1,
                                total: steps.length,
                            });
                            try {
                                const customDigitalHuman = await createCustomDigitalHuman(
                                    {
                                        digitalHumanName: trainerName,
                                        voiceNid: agentId,
                                        avatarNid,
                                    },
                                    credentials
                                ) || "";
                                if (customDigitalHuman) {
                                    digitalHumanConfig = {
                                        customNid: customDigitalHuman,
                                        digitalHumanName: trainerName,
                                        nameKey: digitalHumanNameKey,
                                        avatarNid,
                                        voiceNid: agentId,
                                        agentVoiceId,
                                        voiceName: fallbackDigitalHuman?.voiceName,
                                        source: "created",
                                    };
                                    customDigitalHumanCache.set(digitalHumanNameKey, digitalHumanConfig);
                                    if (digitalHumanNameKey && !existingDigitalHumanByName.has(digitalHumanNameKey)) {
                                        existingDigitalHumanByName.set(digitalHumanNameKey, digitalHumanConfig);
                                    }
                                    send({
                                        type: "progress",
                                        phase: "script",
                                        message: `数字人配置成功：${describeDigitalHuman(digitalHumanConfig)}`,
                                        current: i + 1,
                                        total: steps.length,
                                    });
                                } else {
                                    send({
                                        type: "progress",
                                        phase: "script",
                                        message: `数字人配置失败，将继续创建节点：${trainerName}`,
                                        current: i + 1,
                                        total: steps.length,
                                    });
                                }
                            } catch (digitalHumanErr) {
                                console.warn("[inject-route] 数字人配置异常:", digitalHumanErr);
                                send({
                                    type: "progress",
                                    phase: "script",
                                    message: `数字人配置异常，将继续创建节点：${trainerName}`,
                                    current: i + 1,
                                    total: steps.length,
                                });
                            }
                        } else {
                            agentId = digitalHumanConfig.voiceNid || agentId;
                            avatarNid = digitalHumanConfig.avatarNid || avatarNid;
                            agentVoiceId = digitalHumanConfig.agentVoiceId || agentVoiceId;
                            customDigitalHumanCache.set(digitalHumanNameKey, digitalHumanConfig);
                            send({
                                type: "progress",
                                phase: "script",
                                message: `复用已有数字人：${describeDigitalHuman(digitalHumanConfig)}`,
                                current: i + 1,
                                total: steps.length,
                            });
                        }

                        const customDigitalHuman = digitalHumanConfig?.customNid || "";

                        const newStepId = await createScriptStep(
                            finalTrainTaskId,
                            {
                                stepName: step.stepName,
                                description: step.description,
                                prologue: step.prologue,
                                modelId: step.modelId || "Doubao-Seed-2.0-pro",
                                llmPrompt: step.llmPrompt,
                                trainerName,
                                interactiveRounds: step.interactiveRounds,
                                agentId,
                                agentVoiceId,
                                avatarNid,
                                scriptStepCover: step.scriptStepCover,
                                customDigitalHuman: customDigitalHuman || null,
                                // 不在创建时设置 backgroundTheme，改为创建后用 editScriptStep
                            },
                            position,
                            credentials
                        );

                        if (!newStepId) {
                            send({ type: "error", message: `创建节点「${step.stepName}」失败，注入已中止` });
                            controller.close();
                            return;
                        }

                        // 创建成功后，用 editScriptStep 写入场景配置、数字人和背景图等完整字段
                        if (finalCourseId && finalLibraryFolderId) {
                            console.log("[inject-route] 正在调用 editScriptStep 写入场景配置, stepId=", newStepId);
                            send({
                                type: "progress",
                                phase: "script",
                                message: bgImage ? "正在写入场景配置与背景图..." : "正在写入场景配置...",
                                current: i + 1,
                                total: steps.length,
                            });
                            try {
                                const editOk = await editScriptStep(
                                    finalTrainTaskId,
                                    newStepId,
                                    {
                                        stepName: step.stepName,
                                        description: step.description,
                                        prologue: step.prologue,
                                        modelId: step.modelId || "Doubao-Seed-2.0-pro",
                                        llmPrompt: step.llmPrompt,
                                        trainerName,
                                        interactiveRounds: step.interactiveRounds,
                                        agentId,
                                        agentVoiceId,
                                        avatarNid,
                                        scriptStepCover: bgImage ? {
                                            fileId: bgImage.fileId,
                                            fileUrl: bgImage.fileUrl,
                                        } : (step.scriptStepCover || {}),
                                        backgroundTheme: bgImage?.fileId || null,
                                        customDigitalHuman: customDigitalHuman || null,
                                    },
                                    finalCourseId,
                                    finalLibraryFolderId,
                                    position,
                                    credentials
                                );
                                if (editOk) {
                                    send({
                                        type: "progress",
                                        phase: "script",
                                        message: bgImage ? "场景配置与背景图设置成功" : "场景配置设置成功",
                                        current: i + 1,
                                        total: steps.length,
                                    });
                                } else {
                                    send({
                                        type: "progress",
                                        phase: "script",
                                        message: `场景配置设置失败（editScriptStep 返回错误）`,
                                        current: i + 1,
                                        total: steps.length,
                                    });
                                }
                            } catch (editErr) {
                                console.error("[inject-route] editScriptStep 异常:", editErr);
                                send({ type: "progress", phase: "script", message: `场景配置设置异常: ${editErr instanceof Error ? editErr.message : String(editErr)}`, current: i + 1, total: steps.length });
                            }
                        }

                        createdStepIds.push(newStepId);
                        stepsCreated++;
                    }

                    // 创建连线
                    send({
                        type: "progress",
                        phase: "script",
                        message: useGraphFlow ? "正在按非线性跳转关系创建节点连线..." : "正在创建节点连线...",
                        current: steps.length,
                        total: steps.length,
                    });

                    const createdFlowKeys = new Set<string>();
                    const createFlowOnce = async (
                        fromId: string,
                        toId: string,
                        condition: string,
                        transitionPrompt: string
                    ): Promise<boolean> => {
                        const key = `${fromId}__${toId}__${condition}`;
                        if (createdFlowKeys.has(key)) return false;
                        createdFlowKeys.add(key);
                        const shouldBeDefault = !startIdsWithDefaultFlow.has(fromId);

                        const ok = await createScriptFlow(
                            finalTrainTaskId,
                            fromId,
                            toId,
                            condition,
                            transitionPrompt,
                            credentials,
                            { isDefault: shouldBeDefault }
                        );
                        if (ok) {
                            flowsCreated++;
                            if (shouldBeDefault) {
                                startIdsWithDefaultFlow.add(fromId);
                            }
                        }
                        return ok;
                    };

                    if (useGraphFlow) {
                        const incomingNodeIndexes = new Set<number>();
                        const outgoingNodeIndexes = new Set<number>();

                        resolvedGraphEdges.forEach(({ from, to }) => {
                            if (typeof to === "number") incomingNodeIndexes.add(to);
                            if (typeof from === "number" && to !== "START") outgoingNodeIndexes.add(from);
                        });

                        const explicitStartEdges = resolvedGraphEdges.filter(({ from, to }) => from === "START" && typeof to === "number");
                        if (explicitStartEdges.length > 0) {
                            for (const { to, edge } of explicitStartEdges) {
                                if (typeof to !== "number") continue;
                                await createFlowOnce(
                                    startId,
                                    createdStepIds[to],
                                    edge.condition || "",
                                    edge.transitionPrompt || ""
                                );
                            }
                        } else {
                            const entryIndexes = steps
                                .map((_, index) => index)
                                .filter((index) => !incomingNodeIndexes.has(index));
                            const effectiveEntries = entryIndexes.length > 0 ? entryIndexes : [0];
                            for (const index of effectiveEntries) {
                                await createFlowOnce(
                                    startId,
                                    createdStepIds[index],
                                    effectiveEntries.length > 1 ? (steps[index].stepName || `入口${index + 1}`) : "",
                                    ""
                                );
                            }
                        }

                        for (const { from, to, edge } of resolvedGraphEdges) {
                            if (from === "START") continue;
                            if (from === "END" || to === "START") continue;
                            if (typeof from !== "number") continue;

                            const fromId = createdStepIds[from];
                            const toId = to === "END"
                                ? endId
                                : typeof to === "number"
                                    ? createdStepIds[to]
                                    : "";
                            if (!fromId || !toId) continue;

                            await createFlowOnce(
                                fromId,
                                toId,
                                edge.condition || steps[from]?.flowCondition || "下一步",
                                edge.transitionPrompt || ""
                            );
                        }

                        const terminalIndexes = steps
                            .map((_, index) => index)
                            .filter((index) => !outgoingNodeIndexes.has(index));
                        for (const index of terminalIndexes) {
                            const step = steps[index];
                            await createFlowOnce(
                                createdStepIds[index],
                                endId,
                                step.flowCondition || "训练结束",
                                step.transitionPrompt || ""
                            );
                        }
                    } else {
                        // START/已有最后节点 → 第一个新增节点
                        await createFlowOnce(
                            appendAnchorStepId || startId,
                            createdStepIds[0],
                            appendAnchorStepId ? (steps[0].stepName || "下一步") : "",
                            ""
                        );

                        // 各节点间连线
                        for (let i = 0; i < steps.length - 1; i++) {
                            const condition = steps[i].flowCondition || steps[i + 1].stepName || "下一步";
                            const transition = steps[i].transitionPrompt || "";
                            await createFlowOnce(
                                createdStepIds[i],
                                createdStepIds[i + 1],
                                condition,
                                transition
                            );
                        }

                        // 最后节点 → END
                        const lastStep = steps[steps.length - 1];
                        await createFlowOnce(
                            createdStepIds[createdStepIds.length - 1],
                            endId,
                            lastStep.flowCondition || "训练结束",
                            lastStep.transitionPrompt || ""
                        );
                    }

                    send({ type: "phase_complete", phase: "script", message: `训练剧本注入完成：${stepsCreated} 个节点，${flowsCreated} 条连线` });
                    }
                }

                // ─── 评分标准注入 ──────────────────────────────────────

                if (rubricMarkdown) {
                    let items: any[] = [];

                    // 1. LLM 提取（仅非 regex 模式时尝试）
                    if (extractionMode !== "regex" && llmSettings?.apiKey && llmSettings?.apiUrl && llmSettings?.model) {
                        send({
                            type: "progress",
                            phase: "rubric",
                            message: "正在使用 AI 智能提取评分标准...",
                            current: 0,
                            total: 1,
                        });
                        try {
                            items = await extractRubricConfig(rubricMarkdown, llmSettings);
                            send({ type: "progress", phase: "rubric", message: "AI 提取成功！", current: 1, total: 1 });
                        } catch (err) {
                            console.warn("LLM 评分标准提取失败，回退到正则解析:", err);
                            send({ type: "progress", phase: "rubric", message: "AI 提取失败，回退到正则规则解析...", current: 0, total: 1 });
                        }
                    }

                    // 2. 如果 LLM 提取失败或未提供配置，回退到正则解析
                    if (items.length === 0) {
                        items = parseRubricMarkdown(rubricMarkdown);
                    }

                    if (items.length === 0) {
                        send({ type: "error", message: "评分标准中未找到任何评分项，提取失败" });
                        controller.close();
                        return;
                    }

                    send({
                        type: "start",
                        phase: "rubric",
                        message: `开始注入评分标准，共 ${items.length} 个评分项...`,
                        total: items.length,
                    });

                    for (let i = 0; i < items.length; i++) {
                        const item = items[i];
                        send({
                            type: "progress",
                            phase: "rubric",
                            message: `正在创建评分项 ${i + 1}/${items.length}：${item.itemName}（${item.score}分）`,
                            current: i + 1,
                            total: items.length,
                        });

                        const scoreResult = await createScoreItem(finalTrainTaskId, item, credentials);
                        if (!scoreResult.itemId) {
                            send({ type: "error", message: `创建评分项「${item.itemName}」失败: ${scoreResult.error || '未知错误'}` });
                            controller.close();
                            return;
                        }
                        scoreItemsCreated++;
                    }

                    send({ type: "phase_complete", phase: "rubric", message: `评分标准注入完成：${scoreItemsCreated} 个评分项` });
                }

                // ─── 完成 ─────────────────────────────────────────────

                send({
                    type: "complete",
                    message: "所有内容注入成功！请前往智慧树平台刷新对应任务页面查看结果。",
                    summary: {
                        stepsCreated,
                        flowsCreated,
                        scoreItemsCreated,
                        stepsDeleted,
                        flowsDeleted,
                    },
                });
                controller.close();
            } catch (error) {
                console.error("注入失败:", error);
                try {
                    send({
                        type: "error",
                        message: error instanceof Error ? error.message : "注入过程中发生未知错误",
                    });
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
