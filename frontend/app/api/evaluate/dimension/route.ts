import { NextRequest } from "next/server";
import { DIMENSIONS, MODEL_NAME_MAPPING } from "@/lib/config";
import { buildSubDimensionPrompt } from "@/lib/llm/prompts";
import { formatDialogueForLLM, parseLLMResponse, callLLMStream } from "@/lib/llm/utils";
import { ApiConfig } from "@/lib/llm/types";

export const maxDuration = 300; // 提高到最大值，因为流式响应不会真正超时

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const {
            dimensionKey,
            subDimensionKey,
            teacherDocContent,
            dialogueData,
            workflowConfigContent,
            apiConfig: clientApiConfig
        } = body;

        if (!dimensionKey || !subDimensionKey || !teacherDocContent || !dialogueData) {
            return new Response(JSON.stringify({ error: "缺少必要的参数" }), {
                status: 400,
                headers: { "Content-Type": "application/json" }
            });
        }

        const dimConfig = DIMENSIONS[dimensionKey];
        const subDim = dimConfig?.subDimensions.find(sub => sub.key === subDimensionKey);

        if (!dimConfig || !subDim) {
            return new Response(JSON.stringify({ error: "无效的维度Key" }), {
                status: 400,
                headers: { "Content-Type": "application/json" }
            });
        }

        // 构建 LLM 配置
        const apiConfig: ApiConfig & { model: string } = {
            apiKey: clientApiConfig?.apiKey || process.env.LLM_API_KEY || "",
            baseUrl: clientApiConfig?.baseUrl || process.env.LLM_BASE_URL || "",
            model: MODEL_NAME_MAPPING[clientApiConfig?.model || ""] || clientApiConfig?.model || process.env.LLM_MODEL || "gpt-4o",
        };

        if (!apiConfig.apiKey || !apiConfig.baseUrl) {
            return new Response(JSON.stringify({ error: "未配置 LLM API" }), {
                status: 500,
                headers: { "Content-Type": "application/json" }
            });
        }

        const dialogueText = formatDialogueForLLM(dialogueData);

        // 构造 Prompt
        console.log(`[流式评测] 维度: ${dimConfig.name} - ${subDim.name}`);

        let prompt = "";
        const fullScore = body.fullScore || subDim.fullScore;

        if (fullScore !== subDim.fullScore) {
            prompt = require("@/lib/llm/prompts").buildDynamicPrompt(
                dimConfig.name,
                subDim.name,
                fullScore,
                {
                    teacherDoc: teacherDocContent,
                    dialogueText,
                    workflowConfig: workflowConfigContent,
                }
            );
        } else {
            prompt = buildSubDimensionPrompt(
                dimConfig.name,
                subDim.name,
                {
                    teacherDoc: teacherDocContent,
                    dialogueText,
                    workflowConfig: workflowConfigContent,
                }
            );
        }

        if (!prompt) {
            return new Response(JSON.stringify({ error: "Prompt生成失败" }), {
                status: 500,
                headers: { "Content-Type": "application/json" }
            });
        }

        // 创建流式响应
        const stream = new ReadableStream({
            async start(controller) {
                const encoder = new TextEncoder();
                let fullContent = "";

                try {
                    // 使用流式 LLM 调用
                    const llmStream = callLLMStream(prompt, apiConfig);

                    for await (const chunk of llmStream) {
                        fullContent += chunk;
                        // 每个 chunk 都发送给客户端，保持连接活跃
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk })}\n\n`));
                    }

                    // 流结束后，解析完整内容并发送最终结果
                    const result = parseLLMResponse(fullContent);

                    // 确保使用传入的 fullScore
                    const finalResult = {
                        sub_dimension: subDim.name,
                        score: result.score, // 模型通常会根据新的满分打分，但如果它不知道满分变了，可能需要在此处按比例调整吗？
                        // 我们在 prompt 里已经告诉它满分是多少了，所以直接信任模型输出的分数
                        full_score: fullScore,
                        rating: result.rating || "未知",
                        score_range: result.score_range || "",
                        judgment_basis: result.judgment_basis || "",
                        issues: result.issues || [],
                        highlights: result.highlights || [],
                    };

                    // 发送最终结果
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, result: finalResult })}\n\n`));

                } catch (error) {
                    console.error("流式评测失败:", error);
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                        error: error instanceof Error ? error.message : "评估失败"
                    })}\n\n`));
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

    } catch (error) {
        console.error("维度评估失败:", error);
        return new Response(JSON.stringify({
            error: error instanceof Error ? error.message : "评估失败"
        }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }
}
