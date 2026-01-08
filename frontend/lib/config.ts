/**
 * 应用配置
 */

import { DimensionConfig } from "./llm/types";

/**
 * 评测维度配置（新版本 - 基于分数段限定版）
 * 
 * 5个一级维度，每个20分，权重均等
 * 每个一级维度包含多个二级维度
 */
export const DIMENSIONS: Record<string, DimensionConfig> = {
  // 一、目标达成度（20分）
  goal_completion: {
    name: "目标达成度",
    weight: 0.2,
    fullScore: 20,
    isVeto: true,
    vetoThreshold: 12, // 60%
    subDimensions: [
      {
        key: "knowledge_coverage",
        name: "知识点覆盖率",
        fullScore: 10,
      },
      {
        key: "ability_coverage",
        name: "能力覆盖率",
        fullScore: 10,
      },
    ],
  },

  // 二、流程遵循度（20分）
  workflow_adherence: {
    name: "流程遵循度",
    weight: 0.2,
    fullScore: 20,
    isVeto: false,
    subDimensions: [
      {
        key: "entry_criteria",
        name: "环节准入条件",
        fullScore: 4,
      },
      {
        key: "internal_sequence",
        name: "环节内部顺序",
        fullScore: 4,
      },
      {
        key: "global_stage_flow",
        name: "全局环节流转",
        fullScore: 4,
      },
      {
        key: "exit_criteria",
        name: "环节准出检查",
        fullScore: 4,
      },
      {
        key: "nonlinear_navigation",
        name: "非线性跳转处理",
        fullScore: 4,
      },
    ],
  },

  // 三、交互体验性（20分）
  interaction_experience: {
    name: "交互体验性",
    weight: 0.2,
    fullScore: 20,
    isVeto: false,
    subDimensions: [
      {
        key: "persona_stylization",
        name: "人设语言风格",
        fullScore: 4,
      },
      {
        key: "naturalness",
        name: "表达自然度",
        fullScore: 4,
      },
      {
        key: "contextual_coherence",
        name: "上下文衔接",
        fullScore: 4,
      },
      {
        key: "loop_stasis",
        name: "循环僵局",
        fullScore: 4,
      },
      {
        key: "conciseness",
        name: "回复长度控制",
        fullScore: 4,
      },
    ],
  },

  // 四、幻觉与边界（20分）
  accuracy_boundaries: {
    name: "幻觉与边界",
    weight: 0.2,
    fullScore: 20,
    isVeto: false,
    subDimensions: [
      {
        key: "factuality",
        name: "事实正确性",
        fullScore: 5,
      },
      {
        key: "logical_consistency",
        name: "逻辑自洽性",
        fullScore: 5,
      },
      {
        key: "admittance_ignorance",
        name: "未知承认",
        fullScore: 3,
      },
      {
        key: "safety_guardrails",
        name: "安全围栏",
        fullScore: 3,
      },
      {
        key: "distraction_resistance",
        name: "干扰抵抗",
        fullScore: 4,
      },
    ],
  },

  // 五、教学策略（20分 - 加分项）
  teaching_strategy: {
    name: "教学策略",
    weight: 0.2,
    fullScore: 20,
    isVeto: false,
    isBonus: true, // 标记为加分项
    subDimensions: [
      {
        key: "socratic_frequency",
        name: "启发式提问频率",
        fullScore: 5,
      },
      {
        key: "positive_reinforcement",
        name: "正向激励机制",
        fullScore: 5,
      },
      {
        key: "correction_pathway",
        name: "纠错引导路径",
        fullScore: 5,
      },
      {
        key: "deep_probing",
        name: "深度追问技巧",
        fullScore: 5,
      },
    ],
  },
};

/**
 * 模型名称映射
 * 将前端模型ID映射到API实际需要的模型名称
 */
export const MODEL_NAME_MAPPING: Record<string, string> = {
  "gpt-4.1": "gpt-4.1",
  "gpt-4.1-mini": "gpt-4.1-mini",
  "gpt-4.1-nano": "gpt-4.1-nano",
  "gemini-2.5-pro": "gemini-2.5-pro",
  "gemini-2.5-flash": "gemini-2.5-flash",
  "claude-sonnet-4.5": "Claude Sonnet 4.5",
  "claude-haiku-4.5": "Claude Haiku 4.5",
  "claude-opus-4": "Claude Opus 4",
  "grok-4": "grok-4",
};

/**
 * 可用模型列表
 */
export const AVAILABLE_MODELS = [
  { id: "gpt-4o", name: "GPT-4o", description: "Most capable" },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", description: "Faster, cost-effective" },
  { id: "gpt-4.1", name: "GPT-4.1", description: "Latest GPT-4 version" },
  { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", description: "Compact GPT-4.1" },
  { id: "gpt-4.1-nano", name: "GPT-4.1 Nano", description: "Ultra-compact" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", description: "Google's flagship" },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", description: "Fast Gemini" },
  { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", description: "Newest Sonnet" },
  { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", description: "Latest Haiku" },
  { id: "claude-opus-4", name: "Claude Opus 4", description: "Most capable Claude" },
  { id: "grok-4", name: "Grok-4", description: "xAI's model" },
];

/**
 * 获取环境变量配置
 */
export function getEnvConfig() {
  return {
    llmApiKey: process.env.LLM_API_KEY || "",
    llmBaseUrl:
      process.env.LLM_BASE_URL ||
      "http://llm-service.polymas.com/api/openai/v1/chat/completions",
    llmModel: process.env.LLM_MODEL || "gpt-4o",
    historyFile: process.env.HISTORY_FILE || "evaluations_history.json",
    dataDir: process.env.DATA_DIR || process.cwd(),
  };
}
