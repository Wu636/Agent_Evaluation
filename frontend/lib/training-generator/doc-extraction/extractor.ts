import type { ApiConfig } from "@/lib/llm/types";
import { summarizeLlmHttpError } from "@/lib/llm/error-utils";
import { buildTemperatureCompatiblePayload } from "@/lib/llm/utils";
import {
    DOC_EXTRACTION_BUDGET_MS,
    DOC_EXTRACTION_CHUNK_CHARS,
    DOC_EXTRACTION_CHUNK_OVERLAP,
    DOC_EXTRACTION_MAX_CHARS,
    DOC_EXTRACTION_MAX_CHUNKS,
    DOC_EXTRACTION_PROMPT_VERSION,
    EXTRACTION_MODE_TARGETS,
    type ChunkExtractionSection,
    type DocExtractionProgress,
    type DocExtractionResult,
    type ExtractionMode,
} from "./types";
import { buildChunkExtractionPrompt, DOC_EXTRACTION_SYSTEM_PROMPT } from "./prompts";
import {
    aggregateChunkSections,
    buildExtractionMarkdown,
    createExtractionResult,
    normalizeExtractionDoc,
    normalizeExtractionStatus,
    splitDocIntoChunks,
    splitDocSections,
} from "./pipeline";

const CHUNK_TIMEOUT_MS = 90_000;
const CHUNK_MAX_ATTEMPTS = 2;
const CHUNK_CONCURRENCY = 2;

class DocExtractionTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DocExtractionTimeoutError";
    }
}

function normalizeChatCompletionEndpoint(baseUrl: string): string {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    if (trimmed.includes("/chat/completions")) return trimmed;
    return `${trimmed}/chat/completions`;
}

function buildLlmHeaders(apiKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
        "api-key": apiKey || "",
        "Content-Type": "application/json",
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return headers;
}

function readMessageContent(data: unknown): string {
    const choice = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
        const text = content
            .map((part) => {
                if (typeof part === "string") return part;
                const typed = part as { text?: unknown };
                return typeof typed?.text === "string" ? typed.text : "";
            })
            .join("");
        if (text.trim()) return text;
    }
    throw new Error("模型返回内容为空或格式异常");
}

function parseJsonLoose(raw: string): unknown {
    let cleaned = String(raw || "").trim();
    cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();

    const fenced = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
    if (fenced) cleaned = fenced[1].trim();

    if (!cleaned.startsWith("{") && !cleaned.startsWith("[")) {
        const firstBrace = cleaned.indexOf("{");
        const lastBrace = cleaned.lastIndexOf("}");
        if (firstBrace >= 0 && lastBrace > firstBrace) cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }

    return JSON.parse(cleaned);
}

function mapChunkSections(raw: unknown): ChunkExtractionSection[] {
    const root = raw as { sections?: unknown };
    const list = Array.isArray(raw) ? raw : Array.isArray(root?.sections) ? root.sections : null;
    if (!list) throw new Error("模型未返回 sections 数组");

    const sections: ChunkExtractionSection[] = [];
    list.forEach((item) => {
        const record = item as Record<string, unknown>;
        if (!record || typeof record !== "object") return;
        const title = String(record.title || "").trim();
        if (!title) return;
        const status = normalizeExtractionStatus(record.status);
        const level = Math.max(1, Math.min(6, Number(record.level) || 2));
        const markdownSource = record.markdown ?? record.content ?? "";
        const markdown = status === "omitted" ? "" : String(markdownSource || "").trim();
        sections.push({
            title,
            level,
            path: String(record.path || "").trim() || title,
            status,
            mergedInto: record.mergedInto ? String(record.mergedInto).trim() : undefined,
            markdown,
            excerpt: String(record.excerpt || "").trim(),
            reason: String(record.reason || "").trim(),
        });
    });

    if (sections.length === 0) throw new Error("模型没有返回有效的章节");
    return sections;
}

async function requestChunkExtraction(params: {
    prompt: string;
    config: ApiConfig & { model: string };
    signal?: AbortSignal;
    timeoutMs: number;
}): Promise<ChunkExtractionSection[]> {
    const endpoint = normalizeChatCompletionEndpoint(params.config.baseUrl || "");
    if (!endpoint) throw new Error("未配置 LLM API 地址");

    const requestSignal = params.signal
        ? AbortSignal.any([params.signal, AbortSignal.timeout(params.timeoutMs)])
        : AbortSignal.timeout(params.timeoutMs);

    let response: Response;
    try {
        response = await fetch(endpoint, {
            method: "POST",
            headers: buildLlmHeaders(params.config.apiKey),
            body: JSON.stringify(buildTemperatureCompatiblePayload({
                model: params.config.model,
                maxTokens: 3000,
                n: 1,
                presence_penalty: 0.0,
                messages: [
                    { role: "system", content: DOC_EXTRACTION_SYSTEM_PROMPT },
                    { role: "user", content: params.prompt },
                ],
            }, params.config.model, 0.1)),
            signal: requestSignal,
        });
    } catch (error) {
        if (params.signal?.aborted) throw error;
        if (requestSignal.aborted) {
            throw new DocExtractionTimeoutError(`单个分块提取超过 ${Math.round(params.timeoutMs / 1000)} 秒。`);
        }
        throw new Error(`当前 LLM API 地址不可达：${endpoint}。请检查 API URL 与网络连接。`);
    }

    if (!response.ok) {
        const rawText = await response.text().catch(() => "");
        const message = summarizeLlmHttpError(response.status, rawText);
        if (response.status === 504) {
            throw new DocExtractionTimeoutError(`模型网关超时（504）。${message}`);
        }
        throw new Error(message);
    }

    const data = await response.json().catch(() => {
        throw new Error("模型返回的不是合法 JSON");
    });
    return mapChunkSections(parseJsonLoose(readMessageContent(data)));
}

async function extractChunkWithRetry(params: {
    chunkText: string;
    chunkPath: string;
    mode: ExtractionMode;
    targetChars?: number;
    feedback?: string;
    previousOutline?: string;
    config: ApiConfig & { model: string };
    signal?: AbortSignal;
    timeoutMs: number;
}): Promise<ChunkExtractionSection[]> {
    const prompt = buildChunkExtractionPrompt({
        chunkText: params.chunkText,
        chunkPath: params.chunkPath,
        mode: params.mode,
        targetChars: params.targetChars,
        feedback: params.feedback,
        previousOutline: params.previousOutline,
    });

    let lastError: unknown;
    for (let attempt = 1; attempt <= CHUNK_MAX_ATTEMPTS; attempt++) {
        try {
            return await requestChunkExtraction({
                prompt,
                config: params.config,
                signal: params.signal,
                timeoutMs: params.timeoutMs,
            });
        } catch (error) {
            lastError = error;
            if (params.signal?.aborted) throw error;
            if (error instanceof DocExtractionTimeoutError) throw error;
            if (attempt < CHUNK_MAX_ATTEMPTS) continue;
        }
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError || "未知错误");
    throw new Error(`分块「${params.chunkPath}」提取失败：${detail}`);
}

export interface ExtractTeacherDocParams {
    content: string;
    mode: ExtractionMode;
    config: ApiConfig & { model: string };
    docFingerprint: string;
    feedback?: string;
    previousOutline?: string;
    signal?: AbortSignal;
    onProgress?: (progress: DocExtractionProgress) => void;
}

export async function extractTeacherDoc(params: ExtractTeacherDocParams): Promise<DocExtractionResult> {
    const { signal, onProgress } = params;
    const report = (progress: DocExtractionProgress) => {
        try {
            onProgress?.(progress);
        } catch {
            // 进度回调失败不影响提取本身
        }
    };

    report({ stage: "parse", current: 0, total: 1, message: "正在解析文档结构" });
    const normalized = normalizeExtractionDoc(params.content);
    if (!normalized) throw new Error("文档内容为空");
    if (normalized.length > DOC_EXTRACTION_MAX_CHARS) {
        throw new Error(`文档约 ${normalized.length} 字，超过单次提取上限 ${DOC_EXTRACTION_MAX_CHARS} 字。请先删减附录或拆分文档。`);
    }

    const sourceSections = splitDocSections(normalized);
    const chunks = splitDocIntoChunks(normalized, {
        maxChars: DOC_EXTRACTION_CHUNK_CHARS,
        overlap: DOC_EXTRACTION_CHUNK_OVERLAP,
    });
    if (chunks.length === 0) throw new Error("文档分块失败");
    if (chunks.length > DOC_EXTRACTION_MAX_CHUNKS) {
        throw new Error(`文档被拆分为 ${chunks.length} 个分块，超过上限 ${DOC_EXTRACTION_MAX_CHUNKS}。请先删减附录或拆分文档。`);
    }

    const deadline = Date.now() + DOC_EXTRACTION_BUDGET_MS;
    const modeTarget = EXTRACTION_MODE_TARGETS[params.mode];
    const targetTotal = Math.round((modeTarget.min + modeTarget.max) / 2);
    const chunkTargetChars = Math.max(500, Math.round(targetTotal / chunks.length));
    const internalAbort = new AbortController();
    const mergedSignal = signal ? AbortSignal.any([signal, internalAbort.signal]) : internalAbort.signal;
    const results: ChunkExtractionSection[][] = new Array(chunks.length);
    let completed = 0;
    let nextIndex = 0;

    const worker = async () => {
        while (true) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= chunks.length) return;

            const remaining = deadline - Date.now();
            if (remaining < 5_000) {
                throw new DocExtractionTimeoutError("提取已接近 240 秒上限仍未完成，请改用严格档或先删减附录后重试。");
            }

            const chunk = chunks[index];
            const sections = await extractChunkWithRetry({
                chunkText: chunk.text,
                chunkPath: chunk.path,
                mode: params.mode,
                targetChars: chunkTargetChars,
                feedback: params.feedback,
                previousOutline: params.previousOutline,
                config: params.config,
                signal: mergedSignal,
                timeoutMs: Math.min(CHUNK_TIMEOUT_MS, remaining),
            });
            results[index] = sections;
            completed += 1;
            report({
                stage: "chunk",
                current: completed,
                total: chunks.length,
                message: `已提取 ${completed}/${chunks.length} 块：${chunk.path}`,
            });
        }
    };

    try {
        await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunks.length) }, worker));
    } catch (error) {
        internalAbort.abort();
        throw error;
    }

    report({ stage: "merge", current: 0, total: 1, message: "正在合并分块并核对章节覆盖" });
    const chunkSections = results.flat();
    const aggregated = aggregateChunkSections(chunkSections, sourceSections);
    const extractedMarkdown = buildExtractionMarkdown(aggregated.sections);
    if (!extractedMarkdown.trim()) {
        throw new Error("模型未返回可用的提取内容，请重试或改用严格档。");
    }

    report({ stage: "audit", current: 0, total: 1, message: "正在检查数字、评分项与约束是否保真" });
    return createExtractionResult({
        originalContent: normalized,
        extractedMarkdown,
        sections: aggregated.sections,
        conflicts: aggregated.conflicts,
        mode: params.mode,
        docFingerprint: params.docFingerprint,
        promptVersion: DOC_EXTRACTION_PROMPT_VERSION,
        feedback: params.feedback,
    });
}
