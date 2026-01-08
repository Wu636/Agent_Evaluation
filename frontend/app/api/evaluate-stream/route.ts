/**
 * POST /api/evaluate-stream
 * 流式评估 API - 支持子维度评测 (新版本)
 */

import { NextRequest } from "next/server";
import { parseTxtDialogue } from "@/lib/txt-converter";
import { convertDocxToMarkdown } from "@/lib/converters/docx-converter";
import { DIMENSIONS, MODEL_NAME_MAPPING } from "@/lib/config";
import { buildSubDimensionPrompt } from "@/lib/llm/prompts";
import { formatDialogueForLLM, parseLLMResponse, callLLM } from "@/lib/llm/utils";
import { saveEvaluation } from "@/lib/history-manager";
import type {
    DialogueData, ApiConfig, DimensionScore, EvaluationLevel,
    SubDimensionScore, IssueItem
} from "@/lib/llm/types";

// Vercel 函数配置
// 免费版：最大 300 秒（5分钟）
// Pro 版：最大 900 秒（15分钟）
// 注意：现在有21个子维度，如果串行执行会非常慢，可能需要更长时间
export const maxDuration = 300;
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
                const workflowConfigFile = formData.get("workflow_config") as File | null;
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

                // 计算总子维度数量
                const totalSubDimensions = Object.values(DIMENSIONS).reduce(
                    (sum, dim) => sum + dim.subDimensions.length,
                    0
                );

                // 发送开始事件
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start', total: totalSubDimensions })}\n\n`));

                const dimensionScores: DimensionScore[] = [];
                const vetoReasons: string[] = [];
                const dialogueText = formatDialogueForLLM(dialogueData);

                let currentProgress = 0;

                // 逐个评估一级维度
                for (const dimensionKey of Object.keys(DIMENSIONS)) {
                    const dimConfig = DIMENSIONS[dimensionKey];
                    const subDimensionScores: SubDimensionScore[] = [];

                    // 逐个评估子维度
                    for (const subDim of dimConfig.subDimensions) {
                        currentProgress++;

                        // 发送进度
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                            type: 'progress',
                            dimension: dimConfig.name,
                            sub_dimension: subDim.name,
                            current: currentProgress,
                            total: totalSubDimensions
                        })}\n\n`));

                        try {
                            // 构造子维度提示词
                            const prompt = buildSubDimensionPrompt(
                                dimConfig.name,
                                subDim.name,
                                {
                                    teacherDoc: teacherDocInfo.content as string,
                                    dialogueText,
                                    workflowConfig: workflowConfigContent,
                                }
                            );

                            if (!prompt) {
                                console.warn(`未找到prompt: ${dimensionKey}.${subDim.key}`);
                                continue;
                            }

                            // 调用 LLM
                            const llmResponse = await callLLM(prompt, apiConfig);
                            const result = parseLLMResponse(llmResponse);

                            // 如果解析失败，尝试兼容处理
                            if (!result) {
                                console.error(`解析失败: ${dimensionKey}.${subDim.key}`);
                                continue;
                            }

                            // 收集子维度分数
                            subDimensionScores.push({
                                sub_dimension: subDim.name,
                                score: result.score, // 假设 LLM 返回正确的分数
                                full_score: subDim.fullScore,
                                rating: result.rating || "未知",
                                score_range: result.score_range || "",
                                judgment_basis: result.judgment_basis || "",
                                issues: result.issues || [],
                                highlights: result.highlights || [],
                            });

                        } catch (error) {
                            console.error(`评估子维度 ${subDim.name} 失败:`, error);
                            // 添加一个失败记录，避免总分计算错误
                            subDimensionScores.push({
                                sub_dimension: subDim.name,
                                score: 0,
                                full_score: subDim.fullScore,
                                rating: "评估失败",
                                score_range: "",
                                judgment_basis: `系统错误: ${error}`,
                                issues: [],
                            });
                        }
                    }

                    // 汇总子维度分数到一级维度
                    const totalScore = subDimensionScores.reduce((sum, s) => sum + s.score, 0);

                    // 聚合分析和证据
                    const analysis = subDimensionScores
                        .map(s => `【${s.sub_dimension}】(${s.score}/${s.full_score}): ${s.judgment_basis}`)
                        .join("\n\n");

                    const evidence = subDimensionScores
                        .flatMap(s => s.issues?.map(i => `[${s.sub_dimension}] ${i.description}`) || [])
                        .filter(Boolean);

                    const issues = subDimensionScores
                        .flatMap(s => s.issues?.map(i => i.description) || [])
                        .filter(Boolean);

                    // 确定评级
                    let level = "合格";
                    if (totalScore >= dimConfig.fullScore * 0.9) level = "优秀";
                    else if (totalScore >= dimConfig.fullScore * 0.75) level = "良好";
                    else if (totalScore < dimConfig.fullScore * 0.6) level = "不合格";

                    const dimScore: DimensionScore = {
                        dimension: dimConfig.name,
                        score: totalScore,
                        full_score: dimConfig.fullScore,
                        weight: dimConfig.weight,
                        level: level,
                        analysis: analysis,
                        sub_scores: subDimensionScores, // 保存子维度详细信息
                        isVeto: dimConfig.isVeto && dimConfig.vetoThreshold !== undefined && totalScore < dimConfig.vetoThreshold,
                        weighted_score: totalScore, // 假设满分就是权重分（每个20分）
                    };

                    dimensionScores.push(dimScore);

                    // 检查一票否决
                    if (dimScore.isVeto) {
                        vetoReasons.push(`${dimScore.dimension}得分${dimScore.score.toFixed(1)}分,低于${dimConfig.vetoThreshold}分阈值`);
                    }

                    // 发送维度完成事件
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                        type: 'dimension_complete',
                        dimension: dimConfig.name,
                        score: totalScore,
                        current: currentProgress,
                        total: totalSubDimensions
                    })}\n\n`));
                }

                // 计算总分
                const finalTotalScore = dimensionScores.reduce((sum, dim) => sum + dim.weighted_score, 0);

                // 确定最终等级
                let finalLevel: EvaluationLevel;
                let passCriteriaMet: boolean;

                if (vetoReasons.length > 0) {
                    finalLevel = "一票否决" as EvaluationLevel;
                    passCriteriaMet = false;
                } else if (finalTotalScore >= 90) {
                    finalLevel = "优秀" as EvaluationLevel;
                    passCriteriaMet = true;
                } else if (finalTotalScore >= 75) {
                    finalLevel = "良好" as EvaluationLevel;
                    passCriteriaMet = true;
                } else if (finalTotalScore >= 60) {
                    finalLevel = "合格" as EvaluationLevel;
                    passCriteriaMet = true;
                } else {
                    finalLevel = "不合格" as EvaluationLevel;
                    passCriteriaMet = false;
                }

                // 提取关键问题和建议
                const criticalIssues: string[] = [];
                const actionableSuggestions: string[] = [];

                // 遍历所有子维度的 issue
                dimensionScores.forEach(dim => {
                    dim.sub_scores?.forEach(sub => {
                        if (sub.score < sub.full_score * 0.6) {
                            criticalIssues.push(`【${dim.dimension}-${sub.sub_dimension}】${sub.issues?.[0]?.description || '表现不佳'}`);
                        }
                    });
                });

                // 生成简单的改进建议（后续可以用 LLM 生成专门的建议）
                dimensionScores.forEach(dim => {
                    dim.sub_scores?.forEach(sub => {
                        if (sub.rating === "不足" || sub.rating === "较差") {
                            actionableSuggestions.push(`优化${sub.sub_dimension}: ${sub.judgment_basis.substring(0, 50)}...`);
                        }
                    });
                });

                // 生成分析摘要
                const bestDim = dimensionScores.reduce((prev, current) => current.score > prev.score ? current : prev);
                const worstDim = dimensionScores.reduce((prev, current) => current.score < prev.score ? current : prev);

                const analysis = `评测结论: ${finalLevel} (${finalTotalScore.toFixed(1)}/100)\n\n` +
                    `优势: ${bestDim.dimension}表现最好 (${bestDim.score}/${bestDim.full_score}分)\n` +
                    `待改进: ${worstDim.dimension}需要重点优化 (${worstDim.score}/${worstDim.full_score}分)`;

                // 转换为前端需要的最终格式
                const frontendResult = {
                    total_score: finalTotalScore,
                    dimensions: dimensionScores, // 直接传递完整结构，包含子维度
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
