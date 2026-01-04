/**
 * LLM 工具函数
 */

import type { LLMResponse, ApiConfig, DialogueData } from "./types";

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
 * 解析 LLM 返回的 JSON
 */
export function parseLLMResponse(response: string): LLMResponse {
    try {
        let cleaned = response.trim();

        // 移除 thinking 标签
        cleaned = cleaned.replace(/\<thinking\>[\s\S]*?\<\/thinking\>/g, "");
        cleaned = cleaned.trim();

        let jsonText: string | null = null;

        // 提取 JSON
        const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (codeBlockMatch) {
            jsonText = codeBlockMatch[1].trim();
        } else {
            const firstBrace = cleaned.indexOf("{");
            const lastBrace = cleaned.lastIndexOf("}");
            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                jsonText = cleaned.substring(firstBrace, lastBrace + 1);
            } else {
                jsonText = cleaned;
            }
        }

        const result = JSON.parse(jsonText) as LLMResponse;

        // 验证必要字段
        const requiredFields: (keyof LLMResponse)[] = [
            "score",
            "level",
            "analysis",
            "evidence",
            "issues",
            "suggestions",
        ];
        for (const field of requiredFields) {
            if (!(field in result)) {
                throw new Error(`LLM返回缺少必要字段: ${field}`);
            }
        }

        return result;
    } catch (error) {
        console.error("JSON解析失败:", error);
        return {
            score: 50,
            level: "合格",
            analysis: `JSON解析失败,使用默认分数。错误: ${error instanceof Error ? error.message : String(error)}`,
            evidence: [],
            issues: ["LLM返回格式错误"],
            suggestions: ["需要修复LLM提示词或响应解析"],
        };
    }
}

/**
 * 调用 LLM API
 */
export async function callLLM(
    prompt: string,
    config: ApiConfig & { model: string },
    temperature: number = 0.3
): Promise<string> {
    const { apiKey, baseUrl, model } = config;

    if (!apiKey) throw new Error("未配置 LLM API 密钥");
    if (!baseUrl) throw new Error("未配置 LLM API 地址");

    const payload = {
        maxTokens: 4000,
        messages: [
            {
                role: "system",
                content: "你是一位资深的教学质量评估专家,擅长分析教学智能体的对话质量。你的评价客观、专业、有建设性。",
            },
            {
                role: "user",
                content: prompt,
            },
        ],
        model,
        n: 1,
        presencePenalty: 0.0,
        temperature,
    };

    const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
            "api-key": apiKey,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120000),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API请求失败: HTTP ${response.status}\n${errorText.substring(0, 500)}`);
    }

    const result = await response.json();

    if (result.choices && result.choices.length > 0) {
        return result.choices[0].message.content;
    } else {
        throw new Error(`API返回格式异常: ${JSON.stringify(result)}`);
    }
}
