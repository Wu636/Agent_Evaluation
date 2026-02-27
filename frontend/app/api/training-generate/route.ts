/**
 * POST /api/training-generate
 * 训练配置和评分标准 - 流式生成 API
 */

import { NextRequest } from "next/server";
import { MODEL_NAME_MAPPING } from "@/lib/config";
import { ApiConfig } from "@/lib/llm/types";
import { generateTrainingScriptStream, generateTrainingRubricStream } from "@/lib/training-generator/generator";
import { convertDocxToText } from "@/lib/converters/docx-converter";

// Vercel 函数配置
export const maxDuration = 300;
export const runtime = 'nodejs';

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

                const contentType = request.headers.get("content-type") || "";

                if (contentType.includes("multipart/form-data")) {
                    // 文件上传模式：服务端解析文件内容
                    const formData = await request.formData();
                    const file = formData.get("file") as File | null;
                    teacherDocName = formData.get("teacherDocName") as string || "文档";
                    generateScript = formData.get("generateScript") === "true";
                    generateRubric = formData.get("generateRubric") === "true";
                    apiKey = formData.get("apiKey") as string || "";
                    apiUrl = formData.get("apiUrl") as string || "";
                    model = formData.get("model") as string || "";
                    scriptPromptTemplate = formData.get("scriptPromptTemplate") as string || undefined;
                    rubricPromptTemplate = formData.get("rubricPromptTemplate") as string || undefined;

                    if (!file) {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message: '未收到文件' })}\n\n`));
                        controller.close();
                        return;
                    }

                    const arrayBuffer = await file.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    const fileName = file.name.toLowerCase();

                    if (fileName.endsWith(".docx") || fileName.endsWith(".doc")) {
                        // 使用 mammoth 解析 docx
                        teacherDocContent = await convertDocxToText(buffer);
                    } else {
                        // txt / md 直接解码
                        teacherDocContent = buffer.toString("utf-8");
                    }
                } else {
                    // JSON 模式（文本粘贴）
                    const payload = await request.json();
                    ({ teacherDocContent, teacherDocName, generateScript, generateRubric, apiKey, apiUrl, model, scriptPromptTemplate, rubricPromptTemplate } = payload);
                }

                if (!teacherDocContent || !teacherDocContent.trim()) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message: '文档内容为空，请检查文件格式' })}\n\n`));
                    controller.close();
                    return;
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

                let fullScript = "";
                let fullRubric = "";

                // 1. 生成剧本配置
                if (generateScript) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start', phase: 'script', message: '开始生成剧本配置...' })}\n\n`));
                    const scriptStream = generateTrainingScriptStream(teacherDocContent, apiConfig, scriptPromptTemplate || undefined);
                    for await (const chunk of scriptStream) {
                        fullScript += chunk;
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'chunk', phase: 'script', content: chunk })}\n\n`));
                    }
                    // 尝试清理可能的 Markdown 块包裹
                    let cleanScript = fullScript.trim();
                    if (cleanScript.startsWith('\`\`\`markdown')) {
                        cleanScript = cleanScript.substring(13);
                    } else if (cleanScript.startsWith('\`\`\`')) {
                        cleanScript = cleanScript.substring(3);
                    }
                    if (cleanScript.endsWith('\`\`\`')) {
                        cleanScript = cleanScript.substring(0, cleanScript.length - 3);
                    }
                    fullScript = cleanScript.trim();

                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'phase_complete', phase: 'script', fullContent: fullScript })}\n\n`));
                }

                // 2. 生成评分标准
                if (generateRubric) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start', phase: 'rubric', message: '开始生成评分标准...' })}\n\n`));
                    const rubricStream = generateTrainingRubricStream(teacherDocContent, apiConfig, rubricPromptTemplate || undefined);
                    for await (const chunk of rubricStream) {
                        fullRubric += chunk;
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'chunk', phase: 'rubric', content: chunk })}\n\n`));
                    }
                    // 清理可能的 Markdown 块包裹
                    let cleanRubric = fullRubric.trim();
                    if (cleanRubric.startsWith('\`\`\`markdown')) {
                        cleanRubric = cleanRubric.substring(13);
                    } else if (cleanRubric.startsWith('\`\`\`')) {
                        cleanRubric = cleanRubric.substring(3);
                    }
                    if (cleanRubric.endsWith('\`\`\`')) {
                        cleanRubric = cleanRubric.substring(0, cleanRubric.length - 3);
                    }
                    fullRubric = cleanRubric.trim();

                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'phase_complete', phase: 'rubric', fullContent: fullRubric })}\n\n`));
                }

                const taskName = teacherDocName.replace(/\.[^/.]+$/, ""); // 尝试去掉扩展名作为默认任务名

                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'complete', script: fullScript, rubric: fullRubric, taskName })}\n\n`));
                controller.close();

            } catch (error) {
                console.error("生成配置失败:", error);
                try {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                        type: 'error',
                        message: error instanceof Error ? error.message : "生成失败"
                    })}\n\n`));
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
