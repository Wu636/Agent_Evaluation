import { NextRequest, NextResponse } from "next/server";
import { MODEL_NAME_MAPPING } from "@/lib/config";
import { summarizeLlmHttpError } from "@/lib/llm/error-utils";

export const runtime = "nodejs";

function normalizeChatCompletionEndpoint(baseUrl: string): string {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    if (trimmed.includes("/chat/completions")) return trimmed;
    return `${trimmed}/chat/completions`;
}

function formatConnectivityError(endpoint: string, error: unknown): string {
    const anyError = error as {
        message?: string;
        cause?: { message?: string; code?: string };
    };
    const message = String(anyError?.message || error || "");
    const causeMessage = String(anyError?.cause?.message || "");
    const causeCode = String(anyError?.cause?.code || "");
    const combined = `${message} ${causeMessage} ${causeCode}`.toLowerCase();

    if (
        combined.includes("timeout") ||
        combined.includes("connecttimeouterror") ||
        combined.includes("und_err_connect_timeout")
    ) {
        return `连接超时：${endpoint}`;
    }

    if (
        combined.includes("fetch failed") ||
        combined.includes("econnrefused") ||
        combined.includes("enotfound")
    ) {
        return `无法连接到 API 地址：${endpoint}`;
    }

    return message || "连通性测试失败";
}

export async function POST(request: NextRequest) {
    try {
        const payload = await request.json();
        const apiKey = String(payload.apiKey || "").trim();
        const apiUrl = String(payload.apiUrl || "").trim();
        const rawModel = String(payload.model || "").trim();

        if (!apiUrl) {
            return NextResponse.json({ ok: false, error: "请先填写 API URL" }, { status: 400 });
        }

        const model = MODEL_NAME_MAPPING[rawModel] || rawModel || "gpt-4o";
        const endpoint = normalizeChatCompletionEndpoint(apiUrl);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        const startedAt = Date.now();

        try {
            const headers: Record<string, string> = {
                "api-key": apiKey,
                "Content-Type": "application/json",
            };
            if (apiKey) {
                headers.Authorization = `Bearer ${apiKey}`;
            }

            const response = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    maxTokens: 32,
                    n: 1,
                    presence_penalty: 0.0,
                    model,
                    temperature: 0,
                    messages: [
                        { role: "system", content: "你是一个连通性测试助手，只回复 OK。" },
                        { role: "user", content: "你好" },
                    ],
                }),
                signal: controller.signal,
            });

            clearTimeout(timeout);
            const latencyMs = Date.now() - startedAt;

            if (!response.ok) {
                const errorText = await response.text().catch(() => "");
                return NextResponse.json({
                    ok: false,
                    endpoint,
                    latencyMs,
                    status: response.status,
                    model,
                    error: summarizeLlmHttpError(response.status, errorText),
                }, { status: response.status });
            }

            await response.json().catch(() => null);
            return NextResponse.json({
                ok: true,
                endpoint,
                latencyMs,
                model,
                message: "API 可达，鉴权和基础对话请求正常。",
            });
        } catch (error) {
            clearTimeout(timeout);
            return NextResponse.json({
                ok: false,
                endpoint,
                error: formatConnectivityError(endpoint, error),
            });
        }
    } catch (error) {
        return NextResponse.json(
            { ok: false, error: error instanceof Error ? error.message : "连通性测试失败" },
            { status: 500 }
        );
    }
}
