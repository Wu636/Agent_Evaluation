import { NextRequest, NextResponse } from "next/server";
import { DIMENSIONS, MODEL_NAME_MAPPING } from "@/lib/config";
import { buildSubDimensionPrompt } from "@/lib/llm/prompts";
import { formatDialogueForLLM, parseLLMResponse, callLLM } from "@/lib/llm/utils";
import { ApiConfig } from "@/lib/llm/types";

export const maxDuration = 60; // Enough for single LLM call (usually < 20s)

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
            return NextResponse.json({ error: "缺少必要的参数" }, { status: 400 });
        }

        const dimConfig = DIMENSIONS[dimensionKey];
        const subDim = dimConfig?.subDimensions.find(sub => sub.key === subDimensionKey);

        if (!dimConfig || !subDim) {
            return NextResponse.json({ error: "无效的维度Key" }, { status: 400 });
        }

        // 构建 LLM 配置
        const apiConfig: ApiConfig & { model: string } = {
            apiKey: clientApiConfig?.apiKey || process.env.LLM_API_KEY || "",
            baseUrl: clientApiConfig?.baseUrl || process.env.LLM_BASE_URL || "",
            model: MODEL_NAME_MAPPING[clientApiConfig?.model || ""] || clientApiConfig?.model || process.env.LLM_MODEL || "gpt-4o",
        };

        if (!apiConfig.apiKey || !apiConfig.baseUrl) {
            return NextResponse.json({ error: "未配置 LLM API" }, { status: 500 });
        }

        const dialogueText = formatDialogueForLLM(dialogueData);

        // 构造 Prompt
        const prompt = buildSubDimensionPrompt(
            dimConfig.name,
            subDim.name,
            {
                teacherDoc: teacherDocContent,
                dialogueText,
                workflowConfig: workflowConfigContent,
            }
        );

        if (!prompt) {
            return NextResponse.json({ error: "Prompt生成失败" }, { status: 500 });
        }

        // 调用 LLM
        const llmResponse = await callLLM(prompt, apiConfig);
        const result = parseLLMResponse(llmResponse);

        if (!result) {
            return NextResponse.json({
                error: "LLM响应解析失败",
                rawResponse: llmResponse
            }, { status: 500 });
        }

        // 返回标准化结果
        return NextResponse.json({
            sub_dimension: subDim.name,
            score: result.score,
            full_score: subDim.fullScore,
            rating: result.rating || "未知",
            score_range: result.score_range || "",
            judgment_basis: result.judgment_basis || "",
            issues: result.issues || [],
            highlights: result.highlights || [],
            raw_response: llmResponse // Optional: beneficial for debugging
        });

    } catch (error) {
        console.error("维度评估失败:", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "评估失败" },
            { status: 500 }
        );
    }
}
