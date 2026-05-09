/**
 * POST /api/training-inject
 * 训练配置注入 - SSE 流式进度 API
 */

import { NextRequest } from "next/server";
import { parseTrainingScript, parseRubricMarkdown, parseTaskConfig } from "@/lib/training-injector/parser";
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
    uploadCoverImageFromUrl,
    parsePolymasUrl,
} from "@/lib/training-injector/api";
import { InjectProgressEvent, PolymasCredentials, PolymasScriptStep } from "@/lib/training-injector/types";

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
                    const hasLLM = !!(llmSettings?.apiKey && llmSettings?.apiUrl && llmSettings?.model);

                    if (extractionMode === "llm" && hasLLM) {
                        // 纯 LLM 模式：所有字段用 LLM 提取
                        send({ type: "progress", phase: "script", message: "正在使用 AI 智能提取训练剧本配置...", current: 0, total: 1 });
                        try {
                            const extracted = await extractScriptConfig(scriptMarkdown, llmSettings);
                            steps = extracted.steps;
                            taskConfig = extracted.taskConfig;
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
                        } catch (err) {
                            console.warn("LLM 任务名提取失败，继续:", err);
                        }
                    }

                    if (steps.length === 0) {
                        send({ type: "error", message: "训练剧本中未找到任何阶段，提取失败" });
                        controller.close();
                        return;
                    }

                    // 3.1 课程封面图：先生成源图，再走上传接口，最终用于 trainTaskCover
                    let trainTaskCover: { fileId: string; fileUrl: string } | null = null;
                    if (!injectCoverImage) {
                        send({ type: "progress", phase: "script", message: "已跳过课程封面图注入", current: 0, total: steps.length });
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
                    } else if (injectCoverImage) {
                        send({ type: "progress", phase: "script", message: "缺少课程ID或任务名称，跳过课程封面图注入", current: 0, total: steps.length });
                    }

                    // 3. 更新基础配置（如果提供了 courseId 并且提取到了任务配置）
                    if (finalCourseId && taskConfig?.trainTaskName && taskConfig?.description) {
                        send({ type: "progress", phase: "script", message: "正在更新任务基础配置（名称、描述）...", current: 0, total: steps.length });
                        const ok = await editConfiguration(
                            {
                                trainTaskId: finalTrainTaskId,
                                courseId: finalCourseId,
                                trainTaskName: taskConfig.trainTaskName,
                                description: taskConfig.description,
                                trainTaskCover,
                            },
                            credentials
                        );
                        if (!ok) {
                            console.warn("[inject-route] 更新任务基础配置失败（前端不展示该提示）");
                        }
                    }

                    // 提前检测背景图能力
                    const canSetBgImage = !!(injectBackgroundImage && finalCourseId && finalLibraryFolderId);

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

                    // 创建节点
                    const X_START = 100;
                    const Y_START = 300;
                    const X_GAP = 400;
                    const baseX = appendAnchorPosition ? appendAnchorPosition.x + X_GAP : X_START;
                    const baseY = appendAnchorPosition ? appendAnchorPosition.y : Y_START;
                    const createdStepIds: string[] = [];
                    const customDigitalHumanCache = new Map<string, string>();
                    const existingDigitalHumanByExactKey = new Map<string, string>();
                    const existingDigitalHumanByName = new Map<string, string>();

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
                                const customNid = String(item.customNid || "").trim();
                                const nameKey = normalizeDigitalHumanNameForReuse(item.digitalHumanName);
                                if (!customNid || !nameKey) continue;

                                const voiceNid = String(item.voiceNid || "").trim();
                                const avatarNid = String(item.avatarNid || "").trim();
                                const exactKey = `${nameKey}::${voiceNid}::${avatarNid}`;

                                if (!existingDigitalHumanByExactKey.has(exactKey)) {
                                    existingDigitalHumanByExactKey.set(exactKey, customNid);
                                }
                                if (!existingDigitalHumanByName.has(nameKey)) {
                                    existingDigitalHumanByName.set(nameKey, customNid);
                                }
                            }

                            if (ownerDigitalHumans.length > 0) {
                                send({
                                    type: "progress",
                                    phase: "script",
                                    message: `已读取 ${ownerDigitalHumans.length} 个已有数字人，同名角色将直接复用`,
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

                        const position = { x: baseX + i * X_GAP, y: baseY };
                        const trainerName = step.trainerName || "训练引导员";
                        const agentId = step.agentId || "Tg3LpKo28D";
                        const avatarNid = step.avatarNid || "hnuOVqMu8b";
                        const digitalHumanNameKey = normalizeDigitalHumanNameForReuse(trainerName);
                        const digitalHumanExactKey = `${digitalHumanNameKey}::${agentId}::${avatarNid}`;
                        let customDigitalHuman =
                            customDigitalHumanCache.get(digitalHumanExactKey) ||
                            existingDigitalHumanByExactKey.get(digitalHumanExactKey) ||
                            existingDigitalHumanByName.get(digitalHumanNameKey) ||
                            "";

                        if (!customDigitalHuman) {
                            send({
                                type: "progress",
                                phase: "script",
                                message: `正在配置数字人：${trainerName}`,
                                current: i + 1,
                                total: steps.length,
                            });
                            try {
                                customDigitalHuman = await createCustomDigitalHuman(
                                    {
                                        digitalHumanName: trainerName,
                                        voiceNid: agentId,
                                        avatarNid,
                                    },
                                    credentials
                                ) || "";
                                if (customDigitalHuman) {
                                    customDigitalHumanCache.set(digitalHumanExactKey, customDigitalHuman);
                                    if (digitalHumanNameKey && !existingDigitalHumanByName.has(digitalHumanNameKey)) {
                                        existingDigitalHumanByName.set(digitalHumanNameKey, customDigitalHuman);
                                    }
                                    send({
                                        type: "progress",
                                        phase: "script",
                                        message: `数字人配置成功：${trainerName}`,
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
                            customDigitalHumanCache.set(digitalHumanExactKey, customDigitalHuman);
                            send({
                                type: "progress",
                                phase: "script",
                                message: `复用已有数字人：${trainerName}`,
                                current: i + 1,
                                total: steps.length,
                            });
                        }

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
                    send({ type: "progress", phase: "script", message: "正在创建节点连线...", current: steps.length, total: steps.length });

                    // START/已有最后节点 → 第一个新增节点
                    const flowStartOk = await createScriptFlow(
                        finalTrainTaskId,
                        appendAnchorStepId || startId,
                        createdStepIds[0],
                        appendAnchorStepId ? (steps[0].stepName || "下一步") : "",
                        "",
                        credentials
                    );
                    if (flowStartOk) flowsCreated++;

                    // 各节点间连线
                    for (let i = 0; i < steps.length - 1; i++) {
                        const condition = steps[i].flowCondition || steps[i + 1].stepName || "下一步";
                        const transition = steps[i].transitionPrompt || "";
                        const ok = await createScriptFlow(
                            finalTrainTaskId,
                            createdStepIds[i],
                            createdStepIds[i + 1],
                            condition,
                            transition,
                            credentials
                        );
                        if (ok) flowsCreated++;
                    }

                    // 最后节点 → END
                    const lastStep = steps[steps.length - 1];
                    const flowEndOk = await createScriptFlow(
                        finalTrainTaskId,
                        createdStepIds[createdStepIds.length - 1],
                        endId,
                        lastStep.flowCondition || "训练结束",
                        lastStep.transitionPrompt || "",
                        credentials
                    );
                    if (flowEndOk) flowsCreated++;

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
