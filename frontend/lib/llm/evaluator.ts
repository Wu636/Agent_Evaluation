/**
 * LLM 评测核心逻辑
 */

import {
  DimensionScore,
  EvaluationReport,
  EvaluationLevel,
  LLMResponse,
  ApiConfig,
  DialogueData,
} from "./types";
import { DIMENSIONS, MODEL_NAME_MAPPING } from "../config";
import { buildDimensionPrompt } from "./prompts";
import { formatDialogueForLLM, parseLLMResponse, callLLM } from "./utils";

// 重新导出工具函数供其他模块使用
export { formatDialogueForLLM, parseLLMResponse, callLLM } from "./utils";

/**
 * 评测单个维度
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

  // 构造评测提示词
  const dialogueText = formatDialogueForLLM(dialogueData);
  const prompt = buildDimensionPrompt(dimensionKey, {
    teacherDoc,
    dialogueText,
  });

  // 调用 LLM 评测
  const llmResponse = await callLLM(prompt, apiConfig);

  // 解析 LLM 返回的 JSON
  const result = parseLLMResponse(llmResponse);

  // 构造评分对象
  const score: DimensionScore = {
    dimension: dimensionName,
    score: result.score,
    weight: config.weight,
    level: result.level,
    analysis: result.analysis,
    evidence: result.evidence,
    issues: result.issues,
    suggestions: result.suggestions,
    isVeto:
      config.isVeto &&
      config.vetoThreshold !== undefined &&
      result.score < config.vetoThreshold,
    weightedScore: result.score * config.weight,
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
    const emoji = dim.score >= 80 ? "✅" : dim.score >= 60 ? "⚠️" : "❌";
    lines.push(
      `${emoji} **${dim.dimension}**: ${dim.weightedScore.toFixed(1)}/${dim.weight * 100} `
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
    if (dim.score < 60) {
      // 不合格的维度
      critical.push(
        ...dim.issues.map((issue) => `【${dim.dimension}】${issue}`)
      );
    } else if (dim.score < 75) {
      // 合格但需改进的维度,只取前2个
      critical.push(
        ...dim.issues.slice(0, 2).map((issue) => `【${dim.dimension}】${issue}`)
      );
    }
  }

  return critical;
}

/**
 * 提取可执行建议
 */
function extractActionableSuggestions(dimensions: DimensionScore[]): string[] {
  const suggestions: string[] = [];

  // 按分数从低到高排序,优先改进低分项
  const sortedDims = [...dimensions].sort((a, b) => a.score - b.score);

  for (const dim of sortedDims) {
    if (dim.suggestions.length > 0) {
      // 为每条建议添加维度标签,最多取前3条
      for (const suggestion of dim.suggestions.slice(0, 3)) {
        const cleaned = suggestion.trim();
        // 如果建议以数字开头,移除它
        const finalSuggestion = /^\d+\./.test(cleaned)
          ? cleaned.substring(cleaned.indexOf(".") + 1).trim()
          : cleaned;
        if (finalSuggestion) {
          suggestions.push(`【${dim.dimension}】${finalSuggestion}`);
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
    (sum, dim) => sum + dim.weightedScore,
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
    taskId: dialogueData.metadata.task_id,
    totalScore,
    finalLevel,
    dimensions: dimensionScores,
    executiveSummary,
    criticalIssues,
    actionableSuggestions,
    passCriteriaMet,
    vetoReasons,
  };

  console.log("\n" + "=".repeat(70));
  console.log(`评测完成!总分: ${totalScore.toFixed(1)} - ${finalLevel}`);
  console.log("=".repeat(70));

  return report;
}
