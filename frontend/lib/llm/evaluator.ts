/**
 * LLM 评测核心逻辑 (非流式/CLI用)
 */

import {
  DimensionScore,
  EvaluationReport,
  EvaluationLevel,
  ApiConfig,
  DialogueData,
  SubDimensionScore,
} from "./types";
import { DIMENSIONS, MODEL_NAME_MAPPING } from "../config";
import { buildSubDimensionPrompt } from "./prompts";
import { formatDialogueForLLM, parseLLMResponse, callLLM } from "./utils";

// 重新导出工具函数供其他模块使用
export { formatDialogueForLLM, parseLLMResponse, callLLM } from "./utils";

/**
 * 评测单个维度 (包含多个子维度)
 */
async function evaluateDimension(
  dimensionKey: string,
  teacherDoc: string,
  dialogueData: DialogueData,
  apiConfig: ApiConfig & { model: string }
): Promise<DimensionScore> {
  const config = DIMENSIONS[dimensionKey];
  const dimensionName = config.name;

  console.log(`\n⏳ 正在评测: ${dimensionName}...`);

  const dialogueText = formatDialogueForLLM(dialogueData);
  const subDimensionScores: SubDimensionScore[] = [];

  // 遍历所有子维度
  for (const subDim of config.subDimensions) {
    console.log(`  - 正在评测子维度: ${subDim.name}...`);

    // 构造评测提示词
    const prompt = buildSubDimensionPrompt(config.name, subDim.name, {
      teacherDoc,
      dialogueText,
    });

    if (!prompt) {
      console.warn(`    ⚠️ 未找到prompt: ${dimensionKey}.${subDim.key}`);
      continue;
    }

    try {
      // 调用 LLM 评测
      const llmResponse = await callLLM(prompt, apiConfig);
      const result = parseLLMResponse(llmResponse);

      // 收集子维度分数
      subDimensionScores.push({
        sub_dimension: subDim.name,
        score: result.score,
        full_score: subDim.fullScore,
        rating: result.rating || "未知",
        score_range: result.score_range || "",
        judgment_basis: result.judgment_basis || "",
        issues: result.issues || [],
        highlights: result.highlights || [],
      });
    } catch (error) {
      console.error(`    ❌ 评测失败: ${subDim.name}`, error);
      subDimensionScores.push({
        sub_dimension: subDim.name,
        score: 0,
        full_score: subDim.fullScore,
        rating: "评估失败",
        score_range: "",
        judgment_basis: `系统错误: ${error}`,
        issues: []
      });
    }
  }

  // 汇总子维度分数
  const totalScore = subDimensionScores.reduce((sum, s) => sum + s.score, 0);

  // 聚合分析
  const analysis = subDimensionScores
    .map(s => `【${s.sub_dimension}】(${s.score}/${s.full_score}分): ${s.judgment_basis}`)
    .join("\n\n");

  // 确定评级
  let level = "合格";
  if (totalScore >= config.fullScore * 0.9) level = "优秀";
  else if (totalScore >= config.fullScore * 0.75) level = "良好";
  else if (totalScore < config.fullScore * 0.6) level = "不合格";

  // 构造评分对象
  const score: DimensionScore = {
    dimension: dimensionName,
    score: totalScore,
    full_score: config.fullScore,
    weight: config.weight,
    level: level,
    analysis: analysis,
    sub_scores: subDimensionScores,
    isVeto:
      config.isVeto &&
      config.vetoThreshold !== undefined &&
      totalScore < config.vetoThreshold,
    weighted_score: totalScore, // snake_case
  };

  console.log(`✓ ${dimensionName}: ${score.score.toFixed(1)}分 - ${score.level}`);

  return score;
}

/**
 * 生成高管摘要
 */
function generateExecutiveSummary(
  dimensions: DimensionScore[],
  totalScore: number,
  level: EvaluationLevel,
  vetoReasons: string[]
): string {
  const lines: string[] = [
    `## 评测结论: ${level} (${totalScore.toFixed(1)}/100)`,
    "",
  ];

  if (vetoReasons.length > 0) {
    lines.push("### ⚠️ 一票否决原因");
    for (const reason of vetoReasons) {
      lines.push(`- ${reason}`);
    }
    lines.push("");
  }

  lines.push("### 各维度得分");
  for (const dim of dimensions) {
    const emoji = dim.score / dim.full_score >= 0.8 ? "✅" : dim.score / dim.full_score >= 0.6 ? "⚠️" : "❌";
    lines.push(
      `${emoji} **${dim.dimension}**: ${dim.score.toFixed(1)}/${dim.full_score} `
    );
  }

  lines.push("");
  lines.push("### 核心发现");

  // 最高分维度
  const bestDim = dimensions.reduce((prev, current) =>
    current.score > prev.score ? current : prev
  );
  lines.push(`- ✨ **优势**: ${bestDim.dimension}表现最好`);

  // 最低分维度
  const worstDim = dimensions.reduce((prev, current) =>
    current.score < prev.score ? current : prev
  );
  lines.push(`- 🔧 **待改进**: ${worstDim.dimension}需要重点优化`);

  return lines.join("\n");
}

/**
 * 提取关键问题
 */
function extractCriticalIssues(dimensions: DimensionScore[]): string[] {
  const critical: string[] = [];

  for (const dim of dimensions) {
    if (dim.sub_scores) {
      for (const sub of dim.sub_scores) {
        if (sub.score < sub.full_score * 0.6) {
          const issue = sub.issues?.[0]?.description || sub.judgment_basis;
          critical.push(`【${dim.dimension}-${sub.sub_dimension}】${issue}`);
        }
      }
    }
  }

  return critical;
}

/**
 * 提取可执行建议
 */
function extractActionableSuggestions(dimensions: DimensionScore[]): string[] {
  const suggestions: string[] = [];

  for (const dim of dimensions) {
    if (dim.sub_scores) {
      for (const sub of dim.sub_scores) {
        if (["不足", "较差"].includes(sub.rating)) {
          suggestions.push(`【${dim.dimension}-${sub.sub_dimension}】建议优化: ${sub.judgment_basis.substring(0, 50)}...`);
        }
      }
    }
  }

  return suggestions;
}

/**
 * 执行完整评测
 */
export async function evaluate(
  teacherDoc: string,
  dialogueData: DialogueData,
  apiConfig: ApiConfig
): Promise<EvaluationReport> {
  console.log("\n" + "=".repeat(70));
  console.log("开始 LLM 驱动的智能体评测");
  console.log("=".repeat(70));

  // 使用映射后的模型名称
  const mappedModel = MODEL_NAME_MAPPING[apiConfig.model || ""] || apiConfig.model || "gpt-4o";

  const dimensionScores: DimensionScore[] = [];
  const vetoReasons: string[] = [];

  // 按顺序评测各维度
  for (const dimensionKey of Object.keys(DIMENSIONS)) {
    const score = await evaluateDimension(
      dimensionKey,
      teacherDoc,
      dialogueData,
      { ...apiConfig, model: mappedModel }
    );
    dimensionScores.push(score);

    // 检查一票否决
    if (score.isVeto) {
      const config = DIMENSIONS[dimensionKey];
      vetoReasons.push(
        `${score.dimension}得分${score.score.toFixed(1)}分,低于${config.vetoThreshold}分阈值`
      );
    }
  }

  // 计算总分
  const totalScore = dimensionScores.reduce(
    (sum, dim) => sum + dim.weighted_score, // snake_case
    0
  );

  // 确定最终等级
  let finalLevel: EvaluationLevel;
  let passCriteriaMet: boolean;

  if (vetoReasons.length > 0) {
    finalLevel = EvaluationLevel.VETO;
    passCriteriaMet = false;
  } else if (totalScore >= 90) {
    finalLevel = EvaluationLevel.EXCELLENT;
    passCriteriaMet = true;
  } else if (totalScore >= 75) {
    finalLevel = EvaluationLevel.GOOD;
    passCriteriaMet = true;
  } else if (totalScore >= 60) {
    finalLevel = EvaluationLevel.PASS;
    passCriteriaMet = true;
  } else {
    finalLevel = EvaluationLevel.FAIL;
    passCriteriaMet = false;
  }

  // 生成高管摘要
  const executiveSummary = generateExecutiveSummary(
    dimensionScores,
    totalScore,
    finalLevel,
    vetoReasons
  );

  // 提取关键问题和建议
  const criticalIssues = extractCriticalIssues(dimensionScores);
  const actionableSuggestions = extractActionableSuggestions(dimensionScores);

  const report: EvaluationReport = {
    task_id: dialogueData.metadata.task_id, // snake_case
    total_score: totalScore, // snake_case
    final_level: finalLevel, // snake_case
    dimensions: dimensionScores,
    analysis: executiveSummary, // mapped to analysis (which is executive_summary alias)
    issues: criticalIssues,
    suggestions: actionableSuggestions,
    pass_criteria_met: passCriteriaMet, // snake_case
    veto_reasons: vetoReasons, // snake_case
    // Add compatibility fields if needed or make optional in types
  };

  console.log("\n" + "=".repeat(70));
  console.log(`评测完成!总分: ${totalScore.toFixed(1)} - ${finalLevel}`);
  console.log("=".repeat(70));

  return report;
}
