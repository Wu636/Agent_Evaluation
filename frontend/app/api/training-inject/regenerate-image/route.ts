import { NextRequest, NextResponse } from "next/server";
import {
    editConfiguration,
    editScriptStep,
    generateBackgroundImage,
    generateCourseCoverImageSource,
    parsePolymasUrl,
    queryScriptSteps,
    uploadCoverImageFromUrl,
} from "@/lib/training-injector/api";
import { LLMSettings } from "@/lib/training-injector/llm-extractor";
import { PolymasCredentials } from "@/lib/training-injector/types";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const {
            trainTaskId,
            courseId,
            libraryFolderId,
            credentials,
            llmSettings,
            coverStylePrompt,
            imageModel,
            targetType,
            stepId,
            trainTaskName,
            trainDescription,
            stageDescription,
        } = body as {
            trainTaskId: string;
            courseId?: string;
            libraryFolderId?: string;
            credentials: PolymasCredentials;
            llmSettings?: LLMSettings;
            coverStylePrompt?: string;
            imageModel?: string;
            targetType: "cover" | "background" | "all";
            stepId?: string;
            trainTaskName?: string;
            trainDescription?: string;
            stageDescription?: string;
        };

        if (!trainTaskId || !credentials?.authorization || !credentials?.cookie) {
            return NextResponse.json(
                { success: false, error: "缺少参数：trainTaskId 或平台凭证" },
                { status: 400 }
            );
        }

        let finalTrainTaskId = trainTaskId;
        let finalCourseId = courseId || "";
        let finalLibraryFolderId = libraryFolderId || "";

        if (trainTaskId.includes("http") || trainTaskId.includes("?")) {
            const parsed = parsePolymasUrl(trainTaskId);
            if (parsed?.trainTaskId) {
                finalTrainTaskId = parsed.trainTaskId;
                finalCourseId = finalCourseId || parsed.courseId;
                finalLibraryFolderId = finalLibraryFolderId || parsed.libraryFolderId;
            }
        }

        if (targetType === "cover") {
            if (!finalCourseId) {
                return NextResponse.json(
                    { success: false, error: "重新生成封面图需要 courseId（请粘贴完整任务链接）" },
                    { status: 400 }
                );
            }

            const finalName = String(trainTaskName || "").trim() || "训练任务";
            const finalDesc = String(trainDescription || "").trim() || "由系统自动更新封面图";

            const coverSource = await generateCourseCoverImageSource(
                {
                    trainName: finalName,
                    trainDescription: finalDesc,
                    coverStylePrompt: String(coverStylePrompt || "").trim() || undefined,
                    arkApiKey: llmSettings?.apiKey,
                    llmApiUrl: llmSettings?.apiUrl,
                    imageModel: String(imageModel || "").trim() || undefined,
                },
                credentials
            );

            if (!coverSource?.fileUrl) {
                return NextResponse.json(
                    { success: false, error: "封面图生成失败（主接口与兜底接口均未返回可用图片）" },
                    { status: 500 }
                );
            }

            const uploaded = await uploadCoverImageFromUrl(coverSource.fileUrl, credentials);
            if (!uploaded) {
                return NextResponse.json(
                    { success: false, error: "封面图上传失败" },
                    { status: 500 }
                );
            }

            const ok = await editConfiguration(
                {
                    trainTaskId: finalTrainTaskId,
                    courseId: finalCourseId,
                    trainTaskName: finalName,
                    description: finalDesc,
                    trainTaskCover: uploaded,
                },
                credentials
            );

            if (!ok) {
                return NextResponse.json(
                    { success: false, error: "封面图写入任务配置失败" },
                    { status: 500 }
                );
            }

            return NextResponse.json({ success: true, message: "课程封面图已重新生成并更新" });
        }

        if (targetType === "background") {
            if (!stepId) {
                return NextResponse.json(
                    { success: false, error: "重新生成背景图需要指定阶段（stepId）" },
                    { status: 400 }
                );
            }
            if (!finalCourseId || !finalLibraryFolderId) {
                return NextResponse.json(
                    { success: false, error: "重新生成背景图需要 courseId 与 libraryFolderId（请粘贴完整任务链接）" },
                    { status: 400 }
                );
            }

            const steps = await queryScriptSteps(finalTrainTaskId, credentials);
            const targetStep = steps.find((s) => s.stepId === stepId && s.stepDetailDTO?.nodeType === "SCRIPT_NODE");
            if (!targetStep) {
                return NextResponse.json(
                    { success: false, error: "未找到指定阶段节点" },
                    { status: 404 }
                );
            }

            const stepDetail = targetStep.stepDetailDTO || { nodeType: "SCRIPT_NODE", stepName: "未命名阶段" };
            const stageName = stepDetail.stepName || "未命名阶段";
            const description = String(stepDetail.description || "").trim() || String(stageDescription || "").trim();

            const bgImage = await generateBackgroundImage(
                {
                    trainName: String(trainTaskName || "").trim() || "训练任务",
                    trainDescription: String(trainDescription || "").trim() || "",
                    stageName,
                    stageDescription: description,
                    arkApiKey: llmSettings?.apiKey,
                    llmApiUrl: llmSettings?.apiUrl,
                    imageModel: String(imageModel || "").trim() || undefined,
                },
                credentials
            );

            if (!bgImage) {
                return NextResponse.json(
                    { success: false, error: "阶段背景图生成失败" },
                    { status: 500 }
                );
            }

            const ok = await editScriptStep(
                finalTrainTaskId,
                stepId,
                {
                    stepName: stepDetail.stepName || "",
                    description: stepDetail.description || "",
                    prologue: stepDetail.prologue || "",
                    modelId: stepDetail.modelId || "Doubao-Seed-2.0-pro",
                    llmPrompt: stepDetail.llmPrompt || "",
                    trainerName: stepDetail.trainerName || "",
                    interactiveRounds: Number(stepDetail.interactiveRounds) || 0,
                    agentId: stepDetail.agentId || "Tg3LpKo28D",
                    avatarNid: stepDetail.avatarNid || "hnuOVqMu8b",
                    scriptStepCover: {
                        fileId: bgImage.fileId,
                        fileUrl: bgImage.fileUrl,
                    },
                    backgroundTheme: bgImage.fileId,
                },
                finalCourseId,
                finalLibraryFolderId,
                {
                    x: Number(targetStep.positionDTO?.x) || 100,
                    y: Number(targetStep.positionDTO?.y) || 300,
                },
                credentials
            );

            if (!ok) {
                return NextResponse.json(
                    { success: false, error: "阶段背景图写入失败" },
                    { status: 500 }
                );
            }

            return NextResponse.json({ success: true, message: `阶段「${stageName}」背景图已重新生成并更新` });
        }

        if (targetType === "all") {
            if (!finalCourseId || !finalLibraryFolderId) {
                return NextResponse.json(
                    { success: false, error: "重生全部图片需要 courseId 与 libraryFolderId（请粘贴完整任务链接）" },
                    { status: 400 }
                );
            }

            const encoder = new TextEncoder();
            const sendSse = (controller: ReadableStreamDefaultController, event: Record<string, unknown>) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            };

            const stream = new ReadableStream({
                async start(controller) {
                    try {
                        const finalName = String(trainTaskName || "").trim() || "训练任务";
                        const finalDesc = String(trainDescription || "").trim() || "由系统自动更新图片";

                        const steps = await queryScriptSteps(finalTrainTaskId, credentials);
                        const scriptSteps = steps.filter((s) => s.stepDetailDTO?.nodeType === "SCRIPT_NODE");
                        const total = scriptSteps.length + 1; // 封面 + 全部阶段
                        let current = 0;

                        sendSse(controller, { type: "start", total, message: `开始重生全部图片，共 ${total} 项` });

                        let coverUpdated = false;
                        sendSse(controller, { type: "progress", current, total, message: "正在生成课程封面图..." });
                        const coverSource = await generateCourseCoverImageSource(
                            {
                                trainName: finalName,
                                trainDescription: finalDesc,
                                coverStylePrompt: String(coverStylePrompt || "").trim() || undefined,
                                arkApiKey: llmSettings?.apiKey,
                                llmApiUrl: llmSettings?.apiUrl,
                                imageModel: String(imageModel || "").trim() || undefined,
                            },
                            credentials
                        );

                        if (coverSource?.fileUrl) {
                            const uploaded = await uploadCoverImageFromUrl(coverSource.fileUrl, credentials);
                            if (uploaded) {
                                const coverOk = await editConfiguration(
                                    {
                                        trainTaskId: finalTrainTaskId,
                                        courseId: finalCourseId,
                                        trainTaskName: finalName,
                                        description: finalDesc,
                                        trainTaskCover: uploaded,
                                    },
                                    credentials
                                );
                                coverUpdated = !!coverOk;
                            }
                        }
                        current += 1;
                        sendSse(controller, {
                            type: "progress",
                            current,
                            total,
                            message: `课程封面图${coverUpdated ? "已更新" : "更新失败/跳过"}（${current}/${total}）`,
                        });

                        let successCount = 0;
                        const failedStageNames: string[] = [];

                        for (const step of scriptSteps) {
                            const stepDetail = step.stepDetailDTO || { nodeType: "SCRIPT_NODE", stepName: "未命名阶段" };
                            const stageName = stepDetail.stepName || "未命名阶段";
                            const description = String(stepDetail.description || "").trim() || stageName;

                            sendSse(controller, {
                                type: "progress",
                                current,
                                total,
                                message: `正在生成阶段背景图：${stageName}...`,
                            });

                            const bgImage = await generateBackgroundImage(
                                {
                                    trainName: finalName,
                                    trainDescription: finalDesc,
                                    stageName,
                                    stageDescription: description,
                                    arkApiKey: llmSettings?.apiKey,
                                    llmApiUrl: llmSettings?.apiUrl,
                                    imageModel: String(imageModel || "").trim() || undefined,
                                },
                                credentials
                            );

                            let ok = false;
                            if (bgImage) {
                                ok = await editScriptStep(
                                    finalTrainTaskId,
                                    step.stepId,
                                    {
                                        stepName: stepDetail.stepName || "",
                                        description: stepDetail.description || "",
                                        prologue: stepDetail.prologue || "",
                                        modelId: stepDetail.modelId || "Doubao-Seed-2.0-pro",
                                        llmPrompt: stepDetail.llmPrompt || "",
                                        trainerName: stepDetail.trainerName || "",
                                        interactiveRounds: Number(stepDetail.interactiveRounds) || 0,
                                        agentId: stepDetail.agentId || "Tg3LpKo28D",
                                        avatarNid: stepDetail.avatarNid || "hnuOVqMu8b",
                                        scriptStepCover: {
                                            fileId: bgImage.fileId,
                                            fileUrl: bgImage.fileUrl,
                                        },
                                        backgroundTheme: bgImage.fileId,
                                    },
                                    finalCourseId,
                                    finalLibraryFolderId,
                                    {
                                        x: Number(step.positionDTO?.x) || 100,
                                        y: Number(step.positionDTO?.y) || 300,
                                    },
                                    credentials
                                );
                            }

                            if (ok) successCount++;
                            else failedStageNames.push(stageName);

                            current += 1;
                            sendSse(controller, {
                                type: "progress",
                                current,
                                total,
                                message: `阶段「${stageName}」背景图${ok ? "更新成功" : "更新失败"}（${current}/${total}）`,
                            });
                        }

                        sendSse(controller, {
                            type: "complete",
                            message: `全部图片重生完成：封面${coverUpdated ? "成功" : "失败/跳过"}，阶段背景 ${successCount}/${scriptSteps.length} 成功`,
                            stats: {
                                coverUpdated,
                                totalStages: scriptSteps.length,
                                successStages: successCount,
                                failedStages: failedStageNames,
                            },
                        });
                        controller.close();
                    } catch (error) {
                        sendSse(controller, {
                            type: "error",
                            message: error instanceof Error ? error.message : "重生全部图片失败",
                        });
                        controller.close();
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

        return NextResponse.json({ success: false, error: "无效 targetType" }, { status: 400 });
    } catch (error) {
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : "重新生成图片失败" },
            { status: 500 }
        );
    }
}
