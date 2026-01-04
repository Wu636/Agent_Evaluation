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

        // 尝试修复常见的 JSON 格式问题
        if (jsonText) {
            // 修复数组中缺少逗号的问题（Claude 有时会这样）
            jsonText = jsonText.replace(/"\s*\n\s*"/g, '",\n"');
            // 修复对象中缺少逗号的问题
            jsonText = jsonText.replace(/"\s*\n\s*([a-zA-Z_])/g, '",\n$1');
            // 移除尾随逗号
            jsonText = jsonText.replace(/,(\s*[}\]])/g, '$1');
        }

        let result: LLMResponse;

        try {
            result = JSON.parse(jsonText) as LLMResponse;
        } catch (parseError) {
            console.error("JSON 解析失败，尝试更激进的修复...");
            console.error("原始 JSON:", jsonText?.substring(0, 500));

            // 尝试更激进的修复
            if (jsonText) {
                // 移除所有注释
                jsonText = jsonText.replace(/\/\*[\s\S]*?\*\//g, '');
                jsonText = jsonText.replace(/\/\/.*/g, '');

                // 再次尝试解析
                result = JSON.parse(jsonText) as LLMResponse;
            } else {
                throw parseError;
            }
        }

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
                console.warn(`LLM返回缺少字段: ${field}，使用默认值`);
                // 提供默认值
                if (field === "score") result.score = 50;
                else if (field === "level") result.level = "合格";
                else if (field === "analysis") result.analysis = "分析内容缺失";
                else if (field === "evidence" || field === "issues" || field === "suggestions") {
                    (result as any)[field] = [];
                }
            }
        }

        // 确保数组字段是数组
        if (!Array.isArray(result.evidence)) result.evidence = [];
        if (!Array.isArray(result.issues)) result.issues = [];
        if (!Array.isArray(result.suggestions)) result.suggestions = [];

        // 将数组中的对象转换为字符串（Claude 有时会返回对象而非字符串）
        const ensureStringArray = (arr: any[]): string[] => {
            return arr.map(item => {
                if (typeof item === 'string') return item;
                if (typeof item === 'object' && item !== null) {
                    // 尝试提取常见的文本字段
                    if (item.text) return String(item.text);
                    if (item.content) return String(item.content);
                    if (item.description) return String(item.description);
                    if (item.message) return String(item.message);
                    if (item.issue) return String(item.issue);
                    if (item.suggestion) return String(item.suggestion);
                    // 如果是对象，将其转换为 JSON 字符串或使用第一个字符串值
                    const values = Object.values(item);
                    const firstString = values.find(v => typeof v === 'string');
                    if (firstString) return String(firstString);
                    return JSON.stringify(item);
                }
                return String(item);
            });
        };

        result.evidence = ensureStringArray(result.evidence);
        result.issues = ensureStringArray(result.issues);
        result.suggestions = ensureStringArray(result.suggestions);

        return result;
    } catch (error) {
        console.error("JSON解析失败:", error);
        console.error("原始响应:", response.substring(0, 1000));

        // 返回默认值
        return {
            score: 50,
            level: "合格",
            analysis: `JSON解析失败，使用默认分数。错误: ${error instanceof Error ? error.message : String(error)}`,
            evidence: [],
            issues: ["LLM返回格式错误，请检查模型配置"],
            suggestions: ["建议使用 GPT-4 或其他兼容模型"],
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
