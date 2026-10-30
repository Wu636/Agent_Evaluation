/**
 * POST /api/training-generate/extract-doc
 * 长文档重点提取 - 流式 SSE API
 */

import { NextRequest } from "next/server";
import { MODEL_NAME_MAPPING } from "@/lib/config";
import { ApiConfig } from "@/lib/llm/types";
import { convertDocxToText } from "@/lib/converters/docx-converter";
import { extractTeacherDoc } from "@/lib/training-generator/doc-extraction/extractor";
import { buildDocFingerprint, normalizeExtractionDoc } from "@/lib/training-generator/doc-extraction/pipeline";
import { DOC_EXTRACTION_MIN_CHARS, type ExtractionMode } from "@/lib/training-generator/doc-extraction/types";
import WordExtractor from "word-extractor";

export const runtime = "nodejs";
export const maxDuration = 300;

function normalizeMode(value: unknown): ExtractionMode {
    return value === "strict" || value === "light" ? value : "balanced";
}

async function readTeacherDoc(request: NextRequest): Promise<{
    content: string;
    name: string;
    mode: ExtractionMode;
    feedback: string;
    previousOutline: string;
    docFingerprint: string;
    apiKey: string;
    apiUrl: string;
    model: string;
}> {
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
        const formData = await request.formData();
        const file = formData.get("file") as File | null;
        if (!file) throw new Error("未收到文件");

        const buffer = Buffer.from(await file.arrayBuffer());
        const fileName = file.name.toLowerCase();
        let content = "";
        if (fileName.endsWith(".docx")) {
            content = await convertDocxToText(buffer);
        } else if (fileName.endsWith(".doc")) {
            const extractor = new WordExtractor();
            const extracted = await extractor.extract(buffer);
            content = extracted.getBody();
        } else {
            content = buffer.toString("utf-8");
        }

        return {
            content,
            name: String(formData.get("teacherDocName") || file.name || "文档"),
            mode: normalizeMode(formData.get("mode")),
            feedback: String(formData.get("feedback") || ""),
            previousOutline: String(formData.get("previousOutline") || ""),
            docFingerprint: String(formData.get("docFingerprint") || ""),
            apiKey: String(formData.get("apiKey") || ""),
            apiUrl: String(formData.get("apiUrl") || ""),
            model: String(formData.get("model") || ""),
        };
    }

    const payload = await request.json();
    return {
        content: String(payload.teacherDocContent || ""),
        name: String(payload.teacherDocName || "文档"),
        mode: normalizeMode(payload.mode),
        feedback: String(payload.feedback || ""),
        previousOutline: String(payload.previousOutline || ""),
        docFingerprint: String(payload.docFingerprint || ""),
        apiKey: String(payload.apiKey || ""),
        apiUrl: String(payload.apiUrl || ""),
        model: String(payload.model || ""),
    };
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
    request.signal.addEventListener("abort", stopStreaming, { once: true });

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
                    throw new DOMException("提取连接已关闭", "AbortError");
                }
            };
            const close = () => {
                if (streamClosed) return;
                streamClosed = true;
                if (heartbeatTimer) clearInterval(heartbeatTimer);
                request.signal.removeEventListener("abort", stopStreaming);
                try {
                    controller.close();
                } catch {
                    // 连接已被客户端关闭
                }
            };

            heartbeatTimer = setInterval(() => {
                write(": keepalive\n\n");
            }, 10_000);

            try {
                const doc = await readTeacherDoc(request);
                const content = normalizeExtractionDoc(doc.content);
                if (!content) {
                    send({ type: "error", message: "文档内容为空，请检查文件格式" });
                    close();
                    return;
                }

                if (content.length < DOC_EXTRACTION_MIN_CHARS) {
                    send({
                        type: "skip",
                        originalChars: content.length,
                        message: `当前文档约 ${content.length} 字，未达到 ${DOC_EXTRACTION_MIN_CHARS} 字，无需重点提取，可直接生成。`,
                    });
                    close();
                    return;
                }

                const apiConfig: ApiConfig & { model: string } = {
                    apiKey: doc.apiKey || process.env.LLM_API_KEY || "",
                    baseUrl: doc.apiUrl || process.env.LLM_BASE_URL || "",
                    model: MODEL_NAME_MAPPING[doc.model] || doc.model || process.env.LLM_MODEL || "gpt-4o",
                };
                if (!apiConfig.baseUrl) {
                    send({ type: "error", message: "未配置 LLM API，请先在设置中填写 API URL" });
                    close();
                    return;
                }

                const result = await extractTeacherDoc({
                    content,
                    mode: doc.mode,
                    config: apiConfig,
                    docFingerprint: doc.docFingerprint || buildDocFingerprint({ content }),
                    feedback: doc.feedback || undefined,
                    previousOutline: doc.previousOutline || undefined,
                    signal: generationAbort.signal,
                    onProgress: (progress) => {
                        if (streamClosed) {
                            generationAbort.abort();
                            return;
                        }
                        send({ type: "progress", ...progress });
                    },
                });

                if (!streamClosed) {
                    send({ type: "result", result });
                }
            } catch (error) {
                if (!streamClosed && !generationAbort.signal.aborted) {
                    const message = error instanceof Error ? error.message : "文档重点提取失败";
                    write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
                }
            } finally {
                close();
            }
        },
        cancel() {
            stopStreaming();
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
        },
    });
}
