/**
 * POST /api/evaluate-stream
 * 流式评估 API - 解决 Vercel 超时问题
 */

import { NextRequest } from "next/server";
import { parseTxtDialogue } from "@/lib/txt-converter";
import { convertDocxToMarkdown } from "@/lib/converters/docx-converter";
import { DIMENSIONS, MODEL_NAME_MAPPING } from "@/lib/config";
import { buildDimensionPrompt } from "@/lib/llm/prompts";
import { formatDialogueForLLM, parseLLMResponse, callLLM } from "@/lib/llm/utils";
import { saveEvaluation } from "@/lib/history-manager";
import type { DialogueData, ApiConfig, DimensionScore, EvaluationLevel } from "@/lib/llm/types";

// Vercel 函数配置
// 免费版：最大 300 秒（5分钟）
// Pro 版：最大 900 秒（15分钟）
// 注意：Gemini/Claude 每个维度需要 40-60 秒，6个维度总计约 240-360 秒
export const maxDuration = 300; // 如果是 Pro 版可改为 900
export const runtime = 'nodejs';

async function readFileInfo(file: File): Promise<{ name: string; content: string | Buffer }> {
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    if (file.name.endsWith(".docx")) {
        const markdown = await convertDocxToMarkdown(buffer);
        return { name: file.name, content: markdown };
    } else if (file.name.endsWith(".md") || file.name.endsWith(".txt")) {
        const text = buffer.toString("utf-8");
        return { name: file.name, content: text };
    } else {
        throw new Error(`不支持的文件格式: ${file.name}`);
    }
}

export async function POST(request: NextRequest) {
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            try {
                const formData = await request.formData();

                const teacherDoc = formData.get("teacher_doc") as File;
                const dialogueRecord = formData.get("dialogue_record") as File;
                const workflowConfigFile = formData.get("workflow_config") as File | null; // 新增：工作流配置
                const apiKey = formData.get("api_key") as string | null;
                const apiUrl = formData.get("api_url") as string | null;
                const model = formData.get("model") as string | null;

                if (!teacherDoc || !dialogueRecord) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message: '缺少必需的文件' })}\n\n`));
                    controller.close();
                    return;
                }

                // 读取文件
                const teacherDocInfo = await readFileInfo(teacherDoc);

                const dialogueBytes = await dialogueRecord.arrayBuffer();
                const dialogueBuffer = Buffer.from(dialogueBytes);

                let dialogueData: DialogueData;
                if (dialogueRecord.name.endsWith(".txt")) {
                    const textContent = dialogueBuffer.toString("utf-8");
                    dialogueData = parseTxtDialogue(textContent);
                } else if (dialogueRecord.name.endsWith(".json")) {
                    const textContent = dialogueBuffer.toString("utf-8");
                    dialogueData = JSON.parse(textContent);
                } else {
                    throw new Error(`不支持的对话记录格式: ${dialogueRecord.name}`);
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

                // 读取工作流配置（可选）
                let workflowConfigContent: string | undefined;
                if (workflowConfigFile) {
                    const workflowConfigInfo = await readFileInfo(workflowConfigFile);
                    workflowConfigContent = workflowConfigInfo.content as string;
                }

                // 发送开始事件
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start', total: Object.keys(DIMENSIONS).length })}\n\n`));

                const dimensionScores: DimensionScore[] = [];
                const vetoReasons: string[] = [];
                const dialogueText = formatDialogueForLLM(dialogueData);

                let current = 0;

                // 逐个评估维度
                for (const dimensionKey of Object.keys(DIMENSIONS)) {
                    const config = DIMENSIONS[dimensionKey];
                    current++;

                    // 发送进度
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                        type: 'progress',
                        dimension: config.name,
                        current,
                        total: Object.keys(DIMENSIONS).length
                    })}\n\n`));

                    try {
                        // 构造提示词
                        const prompt = buildDimensionPrompt(dimensionKey, {
                            teacherDoc: teacherDocInfo.content as string,
                            dialogueText,
                            workflowConfig: workflowConfigContent, // 传递工作流配置
                        });

                        // 调用 LLM
                        const llmResponse = await callLLM(prompt, apiConfig);
                        const result = parseLLMResponse(llmResponse);

                        // 构造评分对象
                        const score: DimensionScore = {
                            dimension: config.name,
                            score: result.score,
                            weight: config.weight,
                            level: result.level,
                            analysis: result.analysis,
                            evidence: result.evidence,
                            issues: result.issues,
                            suggestions: result.suggestions,
                            isVeto: config.isVeto && config.vetoThreshold !== undefined && result.score < config.vetoThreshold,
                            weightedScore: result.score * config.weight,
                        };

                        dimensionScores.push(score);

                        // 检查一票否决
                        if (score.isVeto) {
                            vetoReasons.push(`${score.dimension}得分${score.score.toFixed(1)}分,低于${config.vetoThreshold}分阈值`);
                        }

                        // 发送维度完成
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                            type: 'dimension_complete',
                            dimension: config.name,
                            score: result.score,
                            current,
                            total: Object.keys(DIMENSIONS).length
                        })}\n\n`));

                    } catch (error) {
                        console.error(`评估维度 ${config.name} 失败:`, error);
                        // 继续评估其他维度
                    }
                }

                // 计算总分
                const totalScore = dimensionScores.reduce((sum, dim) => sum + dim.weightedScore, 0);

                // 确定最终等级
                let finalLevel: EvaluationLevel;
                let passCriteriaMet: boolean;

                if (vetoReasons.length > 0) {
                    finalLevel = "一票否决" as EvaluationLevel;
                    passCriteriaMet = false;
                } else if (totalScore >= 90) {
                    finalLevel = "优秀" as EvaluationLevel;
                    passCriteriaMet = true;
                } else if (totalScore >= 75) {
                    finalLevel = "良好" as EvaluationLevel;
                    passCriteriaMet = true;
                } else if (totalScore >= 60) {
                    finalLevel = "合格" as EvaluationLevel;
                    passCriteriaMet = true;
                } else {
                    finalLevel = "不合格" as EvaluationLevel;
                    passCriteriaMet = false;
                }

                // 提取关键问题和建议
                const criticalIssues: string[] = [];
                const actionableSuggestions: string[] = [];

                for (const dim of dimensionScores) {
                    if (dim.score < 60) {
                        criticalIssues.push(...dim.issues.map(issue => `【${dim.dimension}】${issue}`));
                    } else if (dim.score < 75) {
                        criticalIssues.push(...dim.issues.slice(0, 2).map(issue => `【${dim.dimension}】${issue}`));
                    }
                }

                const sortedDims = [...dimensionScores].sort((a, b) => a.score - b.score);
                for (const dim of sortedDims) {
                    for (const suggestion of dim.suggestions.slice(0, 3)) {
                        const cleaned = suggestion.trim();
                        const finalSuggestion = /^\d+\./.test(cleaned) ? cleaned.substring(cleaned.indexOf(".") + 1).trim() : cleaned;
                        if (finalSuggestion) {
                            actionableSuggestions.push(`【${dim.dimension}】${finalSuggestion}`);
                        }
                    }
                }

                // 生成分析摘要
                const bestDim = dimensionScores.reduce((prev, current) => current.score > prev.score ? current : prev);
                const worstDim = dimensionScores.reduce((prev, current) => current.score < prev.score ? current : prev);

                const analysis = `评测结论: ${finalLevel} (${totalScore.toFixed(1)}/100)\n\n` +
                    `优势: ${bestDim.dimension}表现最好 (${bestDim.score}分)\n` +
                    `待改进: ${worstDim.dimension}需要重点优化 (${worstDim.score}分)`;

                // 转换为前端格式
                const frontendResult = {
                    total_score: totalScore,
                    dimensions: dimensionScores.reduce((acc, dim) => {
                        const key = Object.keys(DIMENSIONS).find(k => DIMENSIONS[k].name === dim.dimension) || dim.dimension;
                        acc[key] = {
                            score: dim.score,
                            comment: dim.analysis,
                        };
                        return acc;
                    }, {} as Record<string, { score: number; comment: string }>),
                    analysis,
                    issues: criticalIssues,
                    suggestions: actionableSuggestions,
                    final_level: finalLevel,
                    pass_criteria_met: passCriteriaMet,
                    veto_reasons: vetoReasons,
                    history_id: "",
                };

                // 保存到历史记录
                try {
                    const evalId = await saveEvaluation(
                        frontendResult,
                        teacherDoc.name,
                        dialogueRecord.name,
                        apiConfig.model
                    );
                    frontendResult.history_id = evalId;
                } catch (historyError) {
                    console.warn("保存历史记录失败:", historyError);
                }

                // 发送完成事件
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'complete', report: frontendResult })}\n\n`));
                controller.close();

            } catch (error) {
                console.error("流式评估失败:", error);
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                    type: 'error',
                    message: error instanceof Error ? error.message : "评估失败"
                })}\n\n`));
                controller.close();
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
