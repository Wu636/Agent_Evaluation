/**
 * LLM 评测系统类型定义（新版本 - 分数段限定版）
 */

export enum EvaluationLevel {
  EXCELLENT = "优秀",
  GOOD = "良好",
  PASS = "合格",
  FAIL = "不合格",
  VETO = "一票否决",
}

/**
 * 子维度配置
 */
export interface SubDimensionConfig {
  key: string; // 子维度键名
  name: string; // 子维度名称
  fullScore: number; // 满分
}

/**
 * 维度配置
 */
export interface DimensionConfig {
  name: string;
  weight: number;
  fullScore: number; // 满分
  isVeto: boolean;
  vetoThreshold?: number;
  isBonus?: boolean; // 是否为加分项
  subDimensions: SubDimensionConfig[];
}

/**
 * 问题/证据项
 */
export interface IssueItem {
  description: string; // 问题描述
  location: string; // 位置定位（如"第X轮对话"）
  quote: string; // 原文引用
  severity: "high" | "medium" | "low"; // 严重程度
  impact: string; // 对分数段判定的影响说明
}

/**
 * 亮点项（用于加分项）
 */
export interface HighlightItem {
  description: string; // 亮点描述
  location: string; // 位置定位
  quote: string; // 原文引用
  impact: string; // 影响说明
}

/**
 * 子维度评分结果
 */
export interface SubDimensionScore {
  sub_dimension: string; // 子维度名称
  score: number; // 具体分数
  full_score: number; // 满分
  rating: string; // 评级（优秀/良好/合格/不足/较差）
  score_range: string; // 所属分数段
  judgment_basis: string; // 判定该分数段的核心依据
  issues?: IssueItem[]; // 问题清单
  highlights?: HighlightItem[]; // 亮点清单（加分项使用）
}

/**
 * 一级维度评分结果
 */
export interface DimensionScore {
  dimension: string; // 维度名称
  score: number; // 总分
  full_score: number; // 满分
  weight: number; // 权重
  level: string; // 评级
  analysis: string; // 详细分析
  sub_scores: SubDimensionScore[]; // 子维度评分
  isVeto: boolean; // 是否一票否决
  weighted_score: number; // 加权分数 (snake_case)
}

/**
 * 评测报告
 */
export interface EvaluationReport {
  task_id: string; // snake_case
  total_score: number; // snake_case
  final_level: EvaluationLevel; // snake_case
  dimensions: DimensionScore[];
  executive_summary?: string; // snake_case (optional in some contexts, but let's keep it consistent)
  analysis?: string; // Alias for executive_summary or detailed analysis
  issues: string[]; // snake_case
  suggestions: string[]; // snake_case
  pass_criteria_met: boolean; // snake_case
  veto_reasons: string[]; // snake_case

  // 保持兼容性字段
  criticalIssues?: string[]; // Deprecated, use issues
  actionableSuggestions?: string[]; // Deprecated, use suggestions
  executiveSummary?: string; // Deprecated, use analysis/executive_summary
}

/**
 * LLM 响应（子维度评分）
 */
export interface LLMResponse {
  sub_dimension: string;
  score: number;
  full_score: number;
  rating: string;
  score_range: string;
  judgment_basis: string;
  issues?: IssueItem[];
  highlights?: HighlightItem[];
}

// 保留旧的类型以兼容性（后续可以移除）
export interface StageSuggestion {
  stage_name: string;
  issues: string[];
  prompt_fixes: PromptFix[];
}

export interface PromptFix {
  section: string;
  current_problem: string;
  suggested_change: string;
}

export interface ApiConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
}

export interface DialogueData {
  metadata: {
    task_id: string;
    student_level?: string;
    created_at?: string;
    total_rounds: number;
  };
  stages: Array<{
    stage_name: string;
    messages: Array<{
      role: "assistant" | "user";
      content: string;
      round: number;
    }>;
  }>;
}
