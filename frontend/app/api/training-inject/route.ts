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
    editScriptStep,
    createScriptFlow,
    createScoreItem,
    editConfiguration,
    generateBackgroundImage,
    parsePolymasUrl,
} from "@/lib/training-injector/api";
import { InjectProgressEvent, PolymasCredentials } from "@/lib/training-injector/types";

export const maxDuration = 300;
export const runtime = "nodejs";

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

                    // 3. 更新基础配置（如果提供了 courseId 并且 LLM 提取到了任务配置）
                    if (finalCourseId && taskConfig?.trainTaskName && taskConfig?.description) {
                        send({ type: "progress", phase: "script", message: "正在更新任务基础配置（名称、描述）...", current: 0, total: steps.length });
                        const ok = await editConfiguration(
                            {
                                trainTaskId: finalTrainTaskId,
                                courseId: finalCourseId,
                                trainTaskName: taskConfig.trainTaskName,
                                description: taskConfig.description,
                            },
                            credentials
                        );
                        if (!ok) {
                            send({ type: "progress", phase: "script", message: "更新任务基础配置失败，将跳过该步骤", current: 0, total: steps.length });
                        }
                    }

                    send({
                        type: "start",
                        phase: "script",
                        message: `开始注入训练剧本，共 ${steps.length} 个阶段...`,
                        total: steps.length,
                    });

                    // 提前检测背景图能力
                    const canSetBgImage = !!(finalCourseId && finalLibraryFolderId);
                    if (!canSetBgImage) {
                        send({ type: "progress", phase: "script", message: "⚠️ 未检测到 libraryFolderId，将跳过背景图设置（提示：使用包含 libraryId 参数的完整链接可启用背景图）", current: 0, total: steps.length });
                    }

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
                    }

                    // 创建节点
                    const X_START = 100;
                    const Y_START = 300;
                    const X_GAP = 400;
                    const createdStepIds: string[] = [];

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

                        const position = { x: X_START + i * X_GAP, y: Y_START };
                        const newStepId = await createScriptStep(
                            finalTrainTaskId,
                            {
                                stepName: step.stepName,
                                description: step.description,
                                prologue: step.prologue,
                                modelId: step.modelId || "Doubao-Seed-2.0-pro",
                                llmPrompt: step.llmPrompt,
                                trainerName: step.trainerName,
                                interactiveRounds: step.interactiveRounds,
                                agentId: step.agentId || "Tg3LpKo28D",
                                avatarNid: step.avatarNid,
                                scriptStepCover: step.scriptStepCover,
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

                        // 创建成功后，用 editScriptStep 设置背景图
                        if (bgImage && canSetBgImage) {
                            console.log("[inject-route] 正在调用 editScriptStep 设置背景图, stepId=", newStepId);
                            send({ type: "progress", phase: "script", message: `正在设置背景图...`, current: i + 1, total: steps.length });
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
                                        trainerName: step.trainerName,
                                        interactiveRounds: step.interactiveRounds,
                                        agentId: step.agentId || "Tg3LpKo28D",
                                        avatarNid: step.avatarNid,
                                        scriptStepCover: {
                                            fileId: bgImage.fileId,
                                            fileUrl: bgImage.fileUrl,
                                        },
                                        backgroundTheme: bgImage.fileId,
                                    },
                                    finalCourseId,
                                    finalLibraryFolderId,
                                    position,
                                    credentials
                                );
                                if (editOk) {
                                    send({ type: "progress", phase: "script", message: `背景图设置成功`, current: i + 1, total: steps.length });
                                } else {
                                    send({ type: "progress", phase: "script", message: `背景图设置失败（editScriptStep 返回错误）`, current: i + 1, total: steps.length });
                                }
                            } catch (editErr) {
                                console.error("[inject-route] editScriptStep 异常:", editErr);
                                send({ type: "progress", phase: "script", message: `背景图设置异常: ${editErr instanceof Error ? editErr.message : String(editErr)}`, current: i + 1, total: steps.length });
                            }
                        }

                        createdStepIds.push(newStepId);
                        stepsCreated++;
                    }

                    // 创建连线
                    send({ type: "progress", phase: "script", message: "正在创建节点连线...", current: steps.length, total: steps.length });

                    // START → 第一个节点
                    const flowStartOk = await createScriptFlow(
                        finalTrainTaskId,
                        startId,
                        createdStepIds[0],
                        "",
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
