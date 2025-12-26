/**
 * LLM 评测系统类型定义
 */

export enum EvaluationLevel {
  EXCELLENT = "优秀",
  GOOD = "良好",
  PASS = "合格",
  FAIL = "不合格",
  VETO = "一票否决",
}

export interface DimensionScore {
  dimension: string;
  score: number; // 0-100
  weight: number;
  level: string; // 优秀/良好/合格/不合格
  analysis: string; // 详细分析
  evidence: string[]; // 支撑证据
  issues: string[]; // 发现的问题
  suggestions: string[]; // 改进建议
  isVeto: boolean; // 是否一票否决
  weightedScore: number; // 加权分数
}

export interface EvaluationReport {
  taskId: string;
  totalScore: number;
  finalLevel: EvaluationLevel;
  dimensions: DimensionScore[];
  executiveSummary: string; // 高管摘要
  criticalIssues: string[]; // 关键问题
  actionableSuggestions: string[]; // 可执行建议
  passCriteriaMet: boolean; // 是否达到合格标准
  vetoReasons: string[]; // 一票否决原因
}

export interface DimensionConfig {
  name: string;
  weight: number;
  isVeto: boolean;
  vetoThreshold?: number;
}

export interface LLMResponse {
  score: number;
  level: string;
  analysis: string;
  evidence: string[];
  issues: string[];
  suggestions: string[];
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
      role: 'assistant' | 'user';
      content: string;
      round: number;
    }>;
  }>;
}
