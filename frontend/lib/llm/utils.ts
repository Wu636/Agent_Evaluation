/**
 * LLM 工具函数
 */

import type { LLMResponse, ApiConfig, DialogueData, IssueItem, HighlightItem } from "./types";

import { jsonrepair } from 'jsonrepair';
import { LlmHttpError, LlmOutputError, summarizeLlmHttpError } from "./error-utils";

function formatLlmNetworkError(baseUrl: string, error: unknown): Error {
    const anyError = error as {
        message?: string;
        cause?: { message?: string; code?: string };
    };
    const message = String(anyError?.message || error || "");
    const causeMessage = String(anyError?.cause?.message || "");
    const causeCode = String(anyError?.cause?.code || "");
    const combined = `${message} ${causeMessage} ${causeCode}`.toLowerCase();

    if (
        combined.includes("fetch failed") ||
        combined.includes("timeout") ||
        combined.includes("connecttimeouterror") ||
        combined.includes("und_err_connect_timeout") ||
        combined.includes("econnrefused") ||
        combined.includes("enotfound")
    ) {
        return new Error(
            `当前 LLM API 地址不可达：${baseUrl}。请检查 API URL 是否正确、当前网络是否能访问该地址，必要时改为可直连的 HTTPS 地址。`
        );
    }

    return error instanceof Error ? error : new Error(String(error || "LLM 请求失败"));
}

function buildLlmHeaders(apiKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
        "api-key": apiKey || "",
        "Content-Type": "application/json",
    };

    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }

    return headers;
}

function normalizeChatCompletionEndpoint(baseUrl: string): string {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    if (trimmed.includes("/chat/completions")) return trimmed;
    return `${trimmed}/chat/completions`;
}

export function modelRequiresDefaultTemperature(model: string): boolean {
    const normalized = String(model || "")
        .trim()
        .toLowerCase()
        .replace(/[_\s]+/g, "-");
    if (!normalized) return false;

    return /(^|[/:])gpt-?[56](?:$|[.\-_:])/.test(normalized)
        || /(^|[/:])o[134](?:$|[.\-_:])/.test(normalized);
}

export function modelRequiresCompletionTokens(model: string): boolean {
    return modelRequiresDefaultTemperature(model) && !/chat/i.test(model);
}

export function buildTemperatureCompatiblePayload<T extends Record<string, unknown>>(
    payload: T,
    model: string,
    temperature: number
): T & { temperature?: number } {
    if (modelRequiresDefaultTemperature(model)) {
        const { temperature: _ignored, ...rest } = payload as T & { temperature?: unknown };
        return rest as T & { temperature?: number };
    }

    return {
        ...payload,
        temperature,
    };
}

function getStreamEndpoint(baseUrl: string): string {
    const normalized = normalizeChatCompletionEndpoint(baseUrl);
    if (!normalized) return normalized;

    const url = new URL(normalized);
    // 仅平台网关使用专用流式路径；标准 OpenAI 接口通过 stream 参数启用。
    if (url.hostname === "llm-service.polymas.com" && !url.pathname.endsWith("/stream")) {
        url.pathname = `${url.pathname}/stream`;
    }
    return url.toString();
}

/**
 * 格式化对话记录为 LLM 可读格式
 */
export function formatDialogueForLLM(dialogueData: DialogueData): string {
    const lines: string[] = [];

    for (const stage of dialogueData.stages) {
        lines.push(`\n## ${stage.stage_name}\n`);

        for (const msg of stage.messages) {
            const role = msg.role === "assistant" ? "智能体" : "学生";
            lines.push(`**${role}(第${msg.round}轮):** ${msg.content}\n`);
        }
    }

    return lines.join("\n");
}

/**
 * 解析 LLM 返回的 JSON（增强版）
 * 能够处理 LLM 在 JSON 前后添加解释性文字的情况
 */
export function parseLLMResponse(response: string): LLMResponse {
    try {
        let cleaned = response.trim();

        // 1. 移除 thinking 标签
        cleaned = cleaned.replace(/\<thinking\>[\s\S]*?\<\/thinking\>/g, "");
        cleaned = cleaned.trim();

        let jsonText: string | null = null;

        // 2. 优先查找 JSON 代码块
        const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (codeBlockMatch) {
            jsonText = codeBlockMatch[1].trim();
        }

        // 3. 如果没有代码块，尝试查找 JSON 对象
        if (!jsonText) {
            // 尝试找到第一个 { 和最后一个 } 之间的内容
            const firstBrace = cleaned.indexOf("{");
            const lastBrace = cleaned.lastIndexOf("}");
            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                jsonText = cleaned.substring(firstBrace, lastBrace + 1);
            }
        }

        // 4. 如果还是没有找到，尝试更宽松的匹配
        if (!jsonText) {
            // 尝试匹配任何看起来像 JSON 的内容
            const jsonMatch = cleaned.match(/\{[\s\S]*"sub_dimension"[\s\S]*\}/);
            if (jsonMatch) {
                jsonText = jsonMatch[0];
            }
        }

        // 5. 如果仍然没有 JSON，返回默认值
        if (!jsonText) {
            console.error("无法从响应中提取 JSON");
            console.error("原始响应:", cleaned.substring(0, 500));
            return createDefaultResponse("无法提取 JSON");
        }

        let result: any;

        try {
            // 6. 首先尝试标准解析
            result = JSON.parse(jsonText);
        } catch (parseError) {
            // 7. 如果标准解析失败，使用 jsonrepair 修复
            console.warn("标准 JSON 解析失败，尝试使用 jsonrepair 修复...");
            try {
                const repaired = jsonrepair(jsonText);
                result = JSON.parse(repaired);
            } catch (repairError) {
                console.error("jsonrepair 修复失败:", repairError);
                // Last resort logging
                console.error("问题 JSON 片段:", jsonText.substring(0, 500));
                return createDefaultResponse(`JSON 解析失败: ${repairError}`);
            }
        }

        // 8. 填充默认值并返回标准化结果
        return normalizeResult(result);

    } catch (error) {
        console.error("JSON解析失败:", error);
        console.error("原始响应:", response.substring(0, 1000));
        return createDefaultResponse(`解析错误: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * (已弃用 - 使用 jsonrepair) 修复常见的 JSON 格式问题
 */
function fixCommonJsonIssues(jsonText: string): string {
    return jsonText;
}

/**
 * (已弃用 - 使用 jsonrepair) 更激进的 JSON 修复
 */
function aggressiveJsonFix(jsonText: string): string {
    return jsonText;
}

/**
 * 创建默认响应
 */
function createDefaultResponse(errorMessage: string): LLMResponse {
    return {
        sub_dimension: "解析失败",
        score: 0,
        full_score: 0,
        rating: "解析失败",
        score_range: "",
        judgment_basis: errorMessage,
        issues: [],
        highlights: []
    };
}

/**
 * 标准化解析结果
 */
function normalizeResult(result: any): LLMResponse {
    return {
        sub_dimension: result.sub_dimension || "未知子维度",
        score: typeof result.score === 'number' ? result.score : 0,
        full_score: typeof result.full_score === 'number' ? result.full_score : 5,
        rating: result.rating || "未知",
        score_range: result.score_range || "未知",
        judgment_basis: result.judgment_basis || "未提供判定依据",
        issues: Array.isArray(result.issues) ? normalizeIssues(result.issues) : [],
        highlights: Array.isArray(result.highlights) ? normalizeHighlights(result.highlights) : []
    };
}

function normalizeIssues(issues: any[]): IssueItem[] {
    return issues.map(item => ({
        description: String(item.description ?? ""),
        location: String(item.location || "未定位"),
        quote: String(item.quote || ""),
        severity: (["high", "medium", "low"].includes(item.severity) ? item.severity : "medium") as "high" | "medium" | "low",
        impact: String(item.impact || "")
    }));
}

function normalizeHighlights(highlights: any[]): HighlightItem[] {
    return highlights.map(item => ({
        description: String(item.description ?? ""),
        location: String(item.location || "未定位"),
        quote: String(item.quote || ""),
        impact: String(item.impact || "")
    }));
}

/**
 * 调用 LLM API（带重试和详细日志）
 */
export async function callLLM(
    prompt: string,
    config: ApiConfig & { model: string },
    temperature: number = 0.1, // 降低温度以获得更确定性的输出
    systemPrompt?: string
): Promise<string> {
    const { apiKey, baseUrl, model } = config;

    if (!baseUrl) throw new Error("未配置 LLM API 地址");

    const defaultSystemPrompt = `你是一位资深的教学质量评估专家。你的任务是分析教学智能体的对话质量并输出评分结果。

**重要规则：你必须只输出 JSON，不要输出任何其他内容！**
- 不要写"为了..."、"首先..."、"让我..."等解释性文字
- 不要写任何前言或总结
- 直接输出 JSON 对象，以 { 开头，以 } 结尾
- 如果需要思考，在心里思考，不要写出来`;

    const payload = buildTemperatureCompatiblePayload({
        maxTokens: 4000,
        messages: [
            {
                role: "system",
                content: systemPrompt || defaultSystemPrompt,
            },
            {
                role: "user",
                content: prompt,
            },
        ],
        model,
        n: 1,
        presencePenalty: 0.0,
    }, model, temperature);

    console.log(`[LLM调用] 模型: ${model}, API: ${baseUrl}`);
    const startTime = Date.now();

    try {
        // 使用 AbortController 来控制超时
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 180000); // 3分钟超时

        let response: Response;
        try {
            response = await fetch(baseUrl, {
                method: "POST",
                headers: buildLlmHeaders(apiKey),
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
        } catch (error) {
            clearTimeout(timeoutId);
            throw formatLlmNetworkError(baseUrl, error);
        }

        clearTimeout(timeoutId);

        const elapsed = Date.now() - startTime;
        console.log(`[LLM响应] 耗时: ${elapsed}ms, 状态: ${response.status}`);

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[LLM错误] HTTP ${response.status}:`, errorText.substring(0, 500));
            throw new Error(summarizeLlmHttpError(response.status, errorText));
        }

        const result = await response.json();

        if (result.choices && result.choices.length > 0) {
            const content = result.choices[0].message.content;
            console.log(`[LLM成功] 返回内容长度: ${content.length} 字符`);
            return content;
        } else {
            console.error(`[LLM错误] 返回格式异常:`, JSON.stringify(result).substring(0, 500));
            throw new Error(`API返回格式异常: ${JSON.stringify(result).substring(0, 200)}`);
        }
    } catch (error) {
        const elapsed = Date.now() - startTime;

        if (error instanceof Error) {
            if (error.name === 'AbortError') {
                console.error(`[LLM超时] 模型: ${model}, 耗时: ${elapsed}ms`);
                throw new Error(`API请求超时（${Math.round(elapsed / 1000)}秒）。Claude和Gemini模型响应较慢，建议：1) 检查网络连接 2) 尝试使用GPT模型 3) 减少评估维度数量`);
            }

            console.error(`[LLM异常] 模型: ${model}, 错误: ${error.message}, 耗时: ${elapsed}ms`);

            // 网络错误
            if (error.message.includes('fetch') || error.message.includes('network')) {
                throw new Error(`网络错误: ${error.message}. 请检查：1) API密钥是否正确 2) API地址是否可访问 3) 网络连接是否正常`);
            }
        }

        throw error;
    }
}

/**
 * 流式调用 LLM API（用于绕过 Vercel 60s 超时限制）
 * 返回一个 AsyncGenerator，逐块 yield LLM 的输出
 */
export async function* callLLMStream(
    prompt: string,
    config: ApiConfig & { model: string },
    temperature: number = 0.1,
    systemPrompt?: string,
    options: {
        maxTokens?: number;
        lowReasoningEffort?: boolean;
        signal?: AbortSignal;
        requireComplete?: boolean;
    } = {},
): AsyncGenerator<string, void, unknown> {
    const { apiKey, baseUrl, model } = config;

    if (!baseUrl) throw new Error("未配置 LLM API 地址");

    const defaultSystemPrompt = `你是一位资深的教学质量评估专家。你的任务是分析教学智能体的对话质量并输出评分结果。

**重要规则：你必须只输出 JSON，不要输出任何其他内容！**
- 不要写"为了..."、"首先..."、"让我..."等解释性文字
- 不要写任何前言或总结
- 直接输出 JSON 对象，以 { 开头，以 } 结尾
- 如果需要思考，在心里思考，不要写出来`;

    const streamUrl = getStreamEndpoint(baseUrl);
    const maxTokens = options.maxTokens ?? 16000;
    const isPolymas = new URL(streamUrl).hostname === "llm-service.polymas.com";
    const isReasoningModel = modelRequiresCompletionTokens(model);
    // 平台 Claude 请求统一使用网关的 maxTokens 字段，避免重复声明额度。
    const usesPolymasClaudeTokens = isPolymas && /(?:^|[/:\s])claude(?:[-\s]|$)/i.test(model);
    const tokenLimits = isReasoningModel
        ? { ...(isPolymas ? { maxTokens } : {}), max_completion_tokens: maxTokens }
        : usesPolymasClaudeTokens ? { maxTokens }
            : isPolymas ? { maxTokens, max_tokens: maxTokens } : { max_tokens: maxTokens };
    const payload = buildTemperatureCompatiblePayload({
        ...tokenLimits,
        ...(options.lowReasoningEffort && isReasoningModel ? { reasoning_effort: "low" } : {}),
        messages: [
            {
                role: "system",
                content: systemPrompt || defaultSystemPrompt,
            },
            {
                role: "user",
                content: prompt,
            },
        ],
        model,
        n: 1,
        stream: true, // 启用流式响应
    }, model, temperature);

    console.log(`[LLM流式调用] 模型: ${model}, 输入: ${prompt.length} 字符, 输出额度: ${maxTokens}`);
    const startTime = Date.now();

    let response: Response;
    try {
        response = await fetch(streamUrl, {
            method: "POST",
            headers: buildLlmHeaders(apiKey),
            body: JSON.stringify(payload),
            signal: options.signal,
        });
    } catch (error) {
        options.signal?.throwIfAborted();
        throw formatLlmNetworkError(streamUrl, error);
    }

    if (!response.ok) {
        const errorText = await response.text();
        console.warn(`[LLM流式调用] HTTP ${response.status}，等待 ${Date.now() - startTime}ms，输入 ${prompt.length} 字符，输出额度 ${maxTokens}`);
        throw new LlmHttpError(response.status, errorText);
    }

    if (!response.body) {
        throw new Error("响应没有 body，无法进行流式读取");
    }

    let finished = false;
    let finishReason = '';
    let outputChars = 0;
    const parseContent = (text: string): string => {
        if (text.trim() === "[DONE]") {
            finished = true;
            if (!finishReason) finishReason = 'done';
            return "";
        }
        const json = JSON.parse(text);
        if (json.error) {
            const status = Number(json.error.status || json.error.code || 502);
            throw new LlmHttpError(Number.isFinite(status) ? status : 502, JSON.stringify(json.error));
        }
        const choice = json.choices?.[0];
        if (choice?.finish_reason) finishReason = String(choice.finish_reason);
        if (choice?.finish_reason === 'content_filter') {
            throw new LlmOutputError('content_filter', `模型 ${model} 的上游返回 content_filter，未完成文本生成。本次响应未作为有效生成结果接受，请联系网关服务方核查拦截原因。`);
        }
        if (choice?.delta?.refusal || choice?.message?.refusal) {
            throw new LlmOutputError('refusal', `模型 ${model} 的上游返回 refusal，未完成文本生成。本次响应未作为有效生成结果接受，请核查模型通道的响应。`);
        }
        if (options.requireComplete && choice?.finish_reason === "length") {
            throw new Error("模型输出达到额度上限，优化方案不完整，需要压缩后重新生成。");
        }
        if (choice?.finish_reason) finished = true;
        const content = choice?.delta?.content ?? choice?.message?.content;
        if (Array.isArray(content)) {
            const text = content.map((item: { text?: string; content?: string }) => item.text || item.content || "").join("");
            outputChars += text.length;
            return text;
        }
        if (typeof content === 'string') outputChars += content.length;
        return typeof content === "string" ? content : "";
    };
    const ensureTextReceived = () => {
        if (outputChars === 0) {
            throw new LlmOutputError('empty_response', `模型 ${model} 返回空正文（结束原因：${finishReason || 'eof'}）。本次响应未被视为生成成功。`);
        }
    };

    // 有些兼容服务忽略 stream 参数，仍返回完整 JSON。
    if (response.headers.get("content-type")?.includes("application/json")) {
        const content = parseContent(await response.text());
        options.signal?.throwIfAborted();
        ensureTextReceived();
        console.log(`[LLM流式完成] JSON兼容响应, 耗时: ${Date.now() - startTime}ms, 结束原因: ${finishReason || 'json'}, 正文: ${outputChars} 字符`);
        if (content) yield content;
        return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let dataLines: string[] = [];
    const consumeLine = (line: string): string => {
        const trimmed = line.trim();
        if (!trimmed && dataLines.length) {
            const data = dataLines.join("\n");
            dataLines = [];
            return parseContent(data);
        }
        if (trimmed.startsWith("data:")) {
            dataLines.push(trimmed.slice(5).trimStart());
        } else if (trimmed.startsWith("{")) {
            return parseContent(trimmed);
        }
        return "";
    };

    try {
        while (true) {
            options.signal?.throwIfAborted();
            const { done, value } = await reader.read();
            options.signal?.throwIfAborted();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
                const content = consumeLine(line);
                if (content) yield content;
                if (finished) {
                    ensureTextReceived();
                    return;
                }
            }
            if (done) {
                if (buffer) {
                    const content = consumeLine(buffer);
                    if (content) yield content;
                }
                const content = consumeLine("");
                if (content) yield content;
                if (options.requireComplete && !finished) {
                    throw new Error("模型数据流提前结束，未收到完成标记，优化方案未被接受。");
                }
                ensureTextReceived();
                return;
            }
        }
    } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
        const elapsed = Date.now() - startTime;
        console.log(`[LLM流式完成] 耗时: ${elapsed}ms, 结束原因: ${finishReason || (options.signal?.aborted ? 'aborted' : 'eof')}, 正文: ${outputChars} 字符`);
    }
}
