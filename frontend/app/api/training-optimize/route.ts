import { NextRequest } from "next/server";
import WordExtractor from "word-extractor";

import { MODEL_NAME_MAPPING } from "@/lib/config";
import { ApiConfig } from "@/lib/llm/types";
import { convertDocxToText } from "@/lib/converters/docx-converter";
import { runTrainingOptimizationLoop } from "@/lib/training-optimizer/engine";
import { TrainingScriptPlan } from "@/lib/training-generator/types";
import { TemplateDimensionsConfig } from "@/lib/templates";

export const runtime = "nodejs";
export const maxDuration = 300;

async function readTeacherDoc(file: File): Promise<string> {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const fileName = file.name.toLowerCase();

    if (fileName.endsWith(".docx")) {
        return convertDocxToText(buffer);
    }
    if (fileName.endsWith(".doc")) {
        const extractor = new WordExtractor();
        const extracted = await extractor.extract(buffer);
        return extracted.getBody();
    }
    return buffer.toString("utf-8");
}

async function readDialogueRecord(file: File): Promise<string> {
    const arrayBuffer = await file.arrayBuffer();
    return Buffer.from(arrayBuffer).toString("utf-8");
}

export async function POST(request: NextRequest) {
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            const send = (payload: Record<string, unknown>) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            };

            try {
                let teacherDocContent = "";
                let teacherDocName = "教师文档";
                let dialogueRecordContent = "";
                let dialogueRecordName = "对话记录.txt";
                let scriptMarkdown = "";
                let rubricMarkdown = "";
                let modulePlan: TrainingScriptPlan | undefined;
                let maxActions = 3;
                let optimizationFeedback = "";
                let apiKey = "";
                let apiUrl = "";
                let model = "";
                let evaluationTemplateId = "";
                let evaluationTemplateName = "";
                let evaluationTemplateDimensions: TemplateDimensionsConfig | undefined;

                send({
                    type: "start",
                    stage: "prepare",
                    message: "正在读取教师文档、对话记录和当前训练剧本...",
                });

                const contentType = request.headers.get("content-type") || "";
                if (contentType.includes("multipart/form-data")) {
                    const formData = await request.formData();

                    const teacherDocFile = formData.get("teacherDocFile") as File | null;
                    teacherDocName = String(formData.get("teacherDocName") || teacherDocFile?.name || "教师文档");
                    teacherDocContent = teacherDocFile
                        ? await readTeacherDoc(teacherDocFile)
                        : String(formData.get("teacherDocContent") || "");

                    const dialogueFile = formData.get("dialogueFile") as File | null;
                    dialogueRecordName = String(formData.get("dialogueRecordName") || dialogueFile?.name || "对话记录.txt");
                    dialogueRecordContent = dialogueFile
                        ? await readDialogueRecord(dialogueFile)
                        : String(formData.get("dialogueRecordContent") || "");

                    scriptMarkdown = String(formData.get("scriptMarkdown") || "");
                    rubricMarkdown = String(formData.get("rubricMarkdown") || "");
                    const modulePlanRaw = String(formData.get("modulePlan") || "");
                    modulePlan = modulePlanRaw ? JSON.parse(modulePlanRaw) as TrainingScriptPlan : undefined;
                    maxActions = Number(formData.get("maxActions") || 3) || 3;
                    optimizationFeedback = String(formData.get("optimizationFeedback") || "");
                    apiKey = String(formData.get("apiKey") || "");
                    apiUrl = String(formData.get("apiUrl") || "");
                    model = String(formData.get("model") || "");
                    evaluationTemplateId = String(formData.get("evaluationTemplateId") || "");
                    evaluationTemplateName = String(formData.get("evaluationTemplateName") || "");
                    const templateDimensionsRaw = String(formData.get("evaluationTemplateDimensions") || "");
                    evaluationTemplateDimensions = templateDimensionsRaw
                        ? JSON.parse(templateDimensionsRaw) as TemplateDimensionsConfig
                        : undefined;
                } else {
                    const body = await request.json();
                    teacherDocContent = String(body.teacherDocContent || "");
                    teacherDocName = String(body.teacherDocName || "教师文档");
                    dialogueRecordContent = String(body.dialogueRecordContent || "");
                    dialogueRecordName = String(body.dialogueRecordName || "对话记录.txt");
                    scriptMarkdown = String(body.scriptMarkdown || "");
                    rubricMarkdown = String(body.rubricMarkdown || "");
                    modulePlan = body.modulePlan || undefined;
                    maxActions = Number(body.maxActions || 3) || 3;
                    optimizationFeedback = String(body.optimizationFeedback || "");
                    apiKey = String(body.apiKey || "");
                    apiUrl = String(body.apiUrl || "");
                    model = String(body.model || "");
                    evaluationTemplateId = String(body.evaluationTemplateId || "");
                    evaluationTemplateName = String(body.evaluationTemplateName || "");
                    evaluationTemplateDimensions = body.evaluationTemplateDimensions || undefined;
                }

                if (!teacherDocContent.trim()) {
                    send({ type: "error", stage: "prepare", message: "教师文档内容为空" });
                    controller.close();
                    return;
                }
                if (!dialogueRecordContent.trim()) {
                    send({ type: "error", stage: "prepare", message: "请提供对话记录" });
                    controller.close();
                    return;
                }
                if (!scriptMarkdown.trim()) {
                    send({ type: "error", stage: "prepare", message: "请先生成训练剧本，再执行闭环优化" });
                    controller.close();
                    return;
                }

                const apiConfig: ApiConfig & { model: string } = {
                    apiKey: apiKey || process.env.LLM_API_KEY || "",
                    baseUrl: apiUrl || process.env.LLM_BASE_URL || "",
                    model: MODEL_NAME_MAPPING[model || ""] || model || process.env.LLM_MODEL || "gpt-4o",
                };

                if (!apiConfig.baseUrl) {
                    send({ type: "error", stage: "prepare", message: "未配置 LLM API 地址" });
                    controller.close();
                    return;
                }

                await runTrainingOptimizationLoop({
                    teacherDocContent,
                    teacherDocName,
                    dialogueInput: {
                        dialogueRecordContent,
                        dialogueRecordName,
                    },
                    scriptMarkdown,
                    rubricMarkdown: rubricMarkdown || undefined,
                    modulePlan,
                    apiConfig,
                    maxActions,
                    optimizationFeedback,
                    evaluationTemplateId: evaluationTemplateId || undefined,
                    evaluationTemplateName: evaluationTemplateName || undefined,
                    evaluationTemplateDimensions,
                    onProgress: (event) => send(event as unknown as Record<string, unknown>),
                });
            } catch (error) {
                console.error("[training-optimize] 闭环优化失败:", error);
                send({
                    type: "error",
                    stage: "error",
                    message: error instanceof Error ? error.message : "闭环优化失败",
                });
            } finally {
                controller.close();
            }
        }
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    });
}
