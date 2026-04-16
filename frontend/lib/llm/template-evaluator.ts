import { normalizeTemplateDimensions, TemplateDimensionDefinition, TemplateDimensionsConfig, TemplateSubDimensionDefinition } from "@/lib/templates";

import {
  ApiConfig,
  DialogueData,
  DimensionScore,
  EvaluationLevel,
  EvaluationReport,
  SubDimensionScore,
} from "./types";
import { buildWorkflowContext } from "../workflow-helper";
import { formatDialogueForLLM, parseLLMResponse, callLLM } from "./utils";
import { DIMENSIONS, MODEL_NAME_MAPPING } from "../config";
import { buildDynamicPrompt, buildSubDimensionPrompt } from "./prompts";

function clampScore(score: number, fullScore: number): number {
  if (!Number.isFinite(score)) return 0;
  if (!Number.isFinite(fullScore) || fullScore <= 0) return 0;
  const clamped = Math.max(0, Math.min(score, fullScore));
  return Math.round(clamped * 10) / 10;
}

function buildCustomTemplatePrompt(
  dimension: TemplateDimensionDefinition,
  subDimension: TemplateSubDimensionDefinition,
  context: {
    teacherDoc: string;
    dialogueText: string;
    workflowConfig?: string;
  }
): string {
  const workflowContext = context.workflowConfig
    ? `\n## 工作流配置参考\n${buildWorkflowContext(context.workflowConfig)}`
    : "";

  return [
    `# 评测任务: ${dimension.name} - ${subDimension.name}`,
    "",
    "## 评测对象",
    "你需要评测对话中标记为「AI」的智能体表现，只针对当前给定的主维度和子维度进行评分。",
    "",
    "> **重要说明:**",
    "> - 对话记录中「AI:」表示被评测的智能体，「用户:」表示真实学生/用户",
    "> - 你的任务是评价智能体(AI)的行为质量，而非学生行为",
    "> - 只能依据教师文档、工作流配置、对话记录和当前维度定义打分，不能编造证据",
    "",
    "## 教师文档",
    "```markdown",
    context.teacherDoc,
    "```",
    "",
    "## 实际对话记录",
    "```markdown",
    context.dialogueText,
    "```",
    workflowContext,
    "",
    "## 当前评测模板定义",
    `- 主维度名称: ${dimension.name}`,
    `- 主维度定义: ${dimension.description || "未提供"}`,
    `- 子维度名称: ${subDimension.name}`,
    `- 子维度定义: ${subDimension.description || "未提供"}`,
    `- 子维度满分: ${subDimension.fullScore} 分`,
    `- 评分规则/打分方法: ${subDimension.scoringGuidance || "请结合定义、教师文档要求和对话证据综合评分。"}`,
    "",
    "## 评分要求",
    `1. 严格按 ${subDimension.fullScore} 分制评分，score 必须在 0 到 ${subDimension.fullScore} 之间。`,
    "2. judgment_basis 必须解释为什么得这个分，并点明达标点与不足点。",
    "3. issues 只列真实不足；若没有明显问题，可返回空数组。",
    "4. 每条 issue 都要包含 location 和 quote，且 quote 必须来自原始对话。",
    '5. rating 必须是 "优秀"、"良好"、"合格"、"不足"、"较差" 之一。',
    "6. 如果模板定义和教师文档冲突，以教师文档任务目标为硬约束；如果模板定义更细，则按模板定义细化评分。",
    "",
    "## 输出要求",
    "你必须只输出严格 JSON，不要输出任何解释性文字。",
    "",
    "```json",
    "{",
    `  "sub_dimension": "${subDimension.name}",`,
    '  "score": 0,',
    `  "full_score": ${subDimension.fullScore},`,
    '  "rating": "合格",',
    '  "score_range": "填写分数段或简短评分档位说明",',
    '  "judgment_basis": "结合教师文档要求、模板定义和对话证据给出具体分析",',
    '  "issues": [',
    "    {",
    '      "description": "具体问题描述",',
    '      "location": "第X轮对话",',
    '      "quote": "引用原文",',
    '      "severity": "medium",',
    '      "impact": "该问题对本子维度达标情况的影响"',
    "    }",
    "  ]",
    "}",
    "```",
  ].join("\n");
}

function buildTemplatePrompt(params: {
  dimension: TemplateDimensionDefinition;
  subDimension: TemplateSubDimensionDefinition;
  teacherDoc: string;
  dialogueText: string;
  workflowConfig?: string;
  preferStaticPrompts?: boolean;
}): string {
  if (params.preferStaticPrompts && params.dimension.key && params.subDimension.key) {
    const staticDimension = DIMENSIONS[params.dimension.key];
    const staticSubDimension = staticDimension?.subDimensions.find(
      (item) => item.key === params.subDimension.key
    );

    if (staticDimension && staticSubDimension) {
      if (params.subDimension.fullScore !== staticSubDimension.fullScore) {
        return buildDynamicPrompt(
          staticDimension.name,
          staticSubDimension.name,
          params.subDimension.fullScore,
          {
            teacherDoc: params.teacherDoc,
            dialogueText: params.dialogueText,
            workflowConfig: params.workflowConfig,
          }
        );
      }

      return buildSubDimensionPrompt(staticDimension.name, staticSubDimension.name, {
        teacherDoc: params.teacherDoc,
        dialogueText: params.dialogueText,
        workflowConfig: params.workflowConfig,
      });
    }
  }

  return buildCustomTemplatePrompt(params.dimension, params.subDimension, {
    teacherDoc: params.teacherDoc,
    dialogueText: params.dialogueText,
    workflowConfig: params.workflowConfig,
  });
}

export interface TemplateEvaluationProgress {
  current: number;
  total: number;
  dimensionName: string;
  subDimensionName: string;
  score?: number;
  fullScore?: number;
}

export async function evaluateTemplateSubDimension(params: {
  dimension: TemplateDimensionDefinition;
  subDimension: TemplateSubDimensionDefinition;
  teacherDoc: string;
  dialogueText: string;
  apiConfig: ApiConfig & { model: string };
  workflowConfig?: string;
  preferStaticPrompts?: boolean;
}): Promise<SubDimensionScore> {
  const prompt = buildTemplatePrompt({
    dimension: params.dimension,
    subDimension: params.subDimension,
    teacherDoc: params.teacherDoc,
    dialogueText: params.dialogueText,
    workflowConfig: params.workflowConfig,
    preferStaticPrompts: params.preferStaticPrompts,
  });

  try {
    const llmResponse = await callLLM(prompt, params.apiConfig);
    const result = parseLLMResponse(llmResponse);
    const safeScore = clampScore(result.score, params.subDimension.fullScore);

    return {
      sub_dimension: params.subDimension.name,
      score: safeScore,
      full_score: params.subDimension.fullScore,
      rating: result.rating || "未知",
      score_range: result.score_range || "",
      judgment_basis: result.judgment_basis || "",
      issues: result.issues || [],
      highlights: result.highlights || [],
    };
  } catch (error) {
    return {
      sub_dimension: params.subDimension.name,
      score: 0,
      full_score: params.subDimension.fullScore,
      rating: "评估失败",
      score_range: "",
      judgment_basis: `系统错误: ${error instanceof Error ? error.message : String(error)}`,
      issues: [],
      highlights: [],
    };
  }
}

export async function evaluateWithTemplate(
  teacherDoc: string,
  dialogueData: DialogueData,
  templateDimensions: TemplateDimensionsConfig,
  apiConfig: ApiConfig,
  options?: {
    workflowConfig?: string;
    onProgress?: (progress: TemplateEvaluationProgress) => void;
    preferStaticPrompts?: boolean;
  }
): Promise<EvaluationReport> {
  const mappedModel = MODEL_NAME_MAPPING[apiConfig.model || ""] || apiConfig.model || "gpt-4o";
  const normalizedTemplate = normalizeTemplateDimensions(templateDimensions);
  const enabledDimensions = normalizedTemplate.dimensions.filter((dimension) => dimension.enabled);
  const totalSubDimensions = enabledDimensions.reduce(
    (sum, dimension) => sum + dimension.subDimensions.filter((subDimension) => subDimension.enabled).length,
    0
  );
  const dialogueText = formatDialogueForLLM(dialogueData);

  let current = 0;
  const dimensionScores: DimensionScore[] = [];

  for (const dimension of enabledDimensions) {
    const enabledSubDimensions = dimension.subDimensions.filter((subDimension) => subDimension.enabled);
    const subScores: SubDimensionScore[] = [];

    for (const subDimension of enabledSubDimensions) {
      const score = await evaluateTemplateSubDimension({
        dimension,
        subDimension,
        teacherDoc,
        dialogueText,
        workflowConfig: options?.workflowConfig,
        apiConfig: { ...apiConfig, model: mappedModel },
        preferStaticPrompts: options?.preferStaticPrompts,
      });

      subScores.push(score);
      current += 1;
      options?.onProgress?.({
        current,
        total: totalSubDimensions,
        dimensionName: dimension.name,
        subDimensionName: subDimension.name,
        score: score.score,
        fullScore: subDimension.fullScore,
      });
    }

    const fullScore = enabledSubDimensions.reduce((sum, subDimension) => sum + subDimension.fullScore, 0);
    const totalScore = clampScore(
      subScores.reduce((sum, subScore) => sum + subScore.score, 0),
      fullScore
    );
    const ratio = fullScore > 0 ? totalScore / fullScore : 0;

    let level = "合格";
    if (ratio >= 0.9) level = "优秀";
    else if (ratio >= 0.75) level = "良好";
    else if (ratio < 0.6) level = "不合格";

    dimensionScores.push({
      dimension: dimension.name,
      score: totalScore,
      full_score: fullScore,
      weight: dimension.weight,
      level,
      analysis: subScores
        .map((subScore) => `【${subScore.sub_dimension}】(${subScore.score}/${subScore.full_score}): ${subScore.judgment_basis}`)
        .join("\n\n"),
      sub_scores: subScores,
      isVeto: false,
      weighted_score: totalScore,
    });
  }

  const totalScore = dimensionScores.reduce((sum, dimension) => sum + dimension.weighted_score, 0);
  const totalPossibleScore = dimensionScores.reduce((sum, dimension) => sum + dimension.full_score, 0);
  const scoreRatio = totalPossibleScore > 0 ? totalScore / totalPossibleScore : 0;

  let finalLevel = EvaluationLevel.FAIL;
  if (scoreRatio >= 0.9) finalLevel = EvaluationLevel.EXCELLENT;
  else if (scoreRatio >= 0.75) finalLevel = EvaluationLevel.GOOD;
  else if (scoreRatio >= 0.6) finalLevel = EvaluationLevel.PASS;

  const issues = dimensionScores.flatMap((dimension) =>
    (dimension.sub_scores || []).flatMap((subScore) =>
      (subScore.issues || []).map((issue) => `[${subScore.sub_dimension}] ${issue.description}`)
    )
  );

  const suggestions = dimensionScores.flatMap((dimension) =>
    (dimension.sub_scores || [])
      .filter((subScore) => ["不足", "较差", "评估失败", "解析失败"].includes(subScore.rating))
      .map((subScore) => `优化${subScore.sub_dimension}: ${subScore.judgment_basis}`)
  );

  return {
    task_id: "",
    total_score: totalScore,
    dimensions: dimensionScores,
    analysis: `评测完成。总分: ${totalScore.toFixed(1)} / ${totalPossibleScore}`,
    issues,
    suggestions,
    final_level: finalLevel,
    pass_criteria_met: scoreRatio >= 0.6,
    veto_reasons: [],
  };
}
