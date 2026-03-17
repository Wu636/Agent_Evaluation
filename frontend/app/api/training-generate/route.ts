/**
 * POST /api/training-generate
 * 训练配置和评分标准 - 流式生成 API
 */

import { NextRequest } from "next/server";
import { MODEL_NAME_MAPPING } from "@/lib/config";
import { ApiConfig } from "@/lib/llm/types";
import { generateTrainingScriptStream, generateTrainingRubricStream } from "@/lib/training-generator/generator";
import { convertDocxToText } from "@/lib/converters/docx-converter";
import WordExtractor from 'word-extractor';

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

                const send = (event: unknown) => {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
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
                                // 清空前一次半成品，避免前端出现重复拼接
                                send({ type: 'phase_complete', phase, fullContent: '' });
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

                // 1. 生成剧本配置
                if (generateScript) {
                    fullScript = await generatePhaseWithRetry(
                        'script',
                        '开始生成剧本配置...',
                        () => generateTrainingScriptStream(teacherDocContent, apiConfig, scriptPromptTemplate || undefined)
                    );
                    send({ type: 'phase_complete', phase: 'script', fullContent: fullScript });
                }

                // 2. 生成评分标准
                if (generateRubric) {
                    fullRubric = await generatePhaseWithRetry(
                        'rubric',
                        '开始生成评分标准...',
                        () => generateTrainingRubricStream(teacherDocContent, apiConfig, rubricPromptTemplate || undefined)
                    );
                    send({ type: 'phase_complete', phase: 'rubric', fullContent: fullRubric });
                }

                const taskName = teacherDocName.replace(/\.[^/.]+$/, ""); // 尝试去掉扩展名作为默认任务名

                send({ type: 'complete', script: fullScript, rubric: fullRubric, taskName });
                controller.close();

            } catch (error) {
                console.error("生成配置失败:", error);
                try {
                    const rawMsg = error instanceof Error ? error.message : '生成失败';
                    const message = /terminated|econnreset|fetch failed/i.test(rawMsg)
                        ? 'LLM 流式连接中断（网络波动或网关超时）。系统已自动重试一次但仍失败，请稍后重试。'
                        : rawMsg;
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
