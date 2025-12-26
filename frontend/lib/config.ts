/**
 * 应用配置
 */

import { DimensionConfig } from "./llm/types";

/**
 * 评测维度配置
 */
export const DIMENSIONS: Record<string, DimensionConfig> = {
  teaching_goal_completion: {
    name: "目标达成度",
    weight: 0.4,
    isVeto: true,
    vetoThreshold: 60,
  },
  teaching_strategy: {
    name: "策略引导力",
    weight: 0.2,
    isVeto: false,
  },
  workflow_consistency: {
    name: "流程遵循度",
    weight: 0.15,
    isVeto: false,
  },
  interaction_experience: {
    name: "交互体验感",
    weight: 0.1,
    isVeto: false,
  },
  hallucination_control: {
    name: "幻觉控制力",
    weight: 0.1,
    isVeto: false,
  },
  robustness: {
    name: "异常处理力",
    weight: 0.05,
    isVeto: false,
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
