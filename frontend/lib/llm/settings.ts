import { normalizeModelId } from "@/lib/config";
import type { ApiConfig } from "./types";

export const LLM_SETTINGS_STORAGE_KEY = "llm-eval-settings";
export const LLM_SETTINGS_UPDATED_EVENT = "llm-settings-updated";
export const DEFAULT_LLM_API_URL =
  "https://llm-service.polymas.com/api/openai/v1/chat/completions";
export const DEFAULT_IMAGE_MODEL = "doubao-seedream-5-0-260128";
const LLM_SETTINGS_VERSION = 3;
const LEGACY_DEFAULT_MODELS = new Set(["gpt-4o", "claude-sonnet-4.5"]);

export type LLMModelProfileId =
  | "default"
  | "evaluation"
  | "homeworkReview"
  | "trainingGenerate"
  | "trainingOptimize"
  | "trainingInject";

export interface LLMModelProfiles {
  default: string;
  evaluation: string;
  homeworkReview: string;
  trainingGenerate: string;
  trainingOptimize: string;
  trainingInject: string;
}

export interface LLMModelProfileMeta {
  id: LLMModelProfileId;
  label: string;
  description: string;
}

interface StoredLLMSettings {
  version?: number;
  apiKey?: string;
  apiUrl?: string;
  baseUrl?: string;
  model?: string;
  modelProfiles?: Partial<Record<LLMModelProfileId, string>>;
  imageModel?: string;
}

export interface ResolvedLLMSettings extends ApiConfig {
  apiKey: string;
  apiUrl: string;
  baseUrl: string;
  model: string;
  modelProfiles: LLMModelProfiles;
  imageModel: string;
  selectedProfile: LLMModelProfileId;
  version: number;
}

export const LLM_MODEL_PROFILE_OPTIONS: LLMModelProfileMeta[] = [
  {
    id: "default",
    label: "默认/通用模型",
    description: "作为全局回退模型，未单独指定场景时使用",
  },
  {
    id: "evaluation",
    label: "评测模型",
    description: "用于对话评测与维度判分，优先质量和稳定性",
  },
  {
    id: "homeworkReview",
    label: "作业批阅模型",
    description: "用于作业批阅、评语生成和答案校验",
  },
  {
    id: "trainingGenerate",
    label: "训练配置生成模型",
    description: "用于训练剧本、评分标准和模块规划生成",
  },
  {
    id: "trainingOptimize",
    label: "训练优化模型",
    description: "用于训练配置闭环优化和问题修复建议",
  },
  {
    id: "trainingInject",
    label: "训练注入提取模型",
    description: "用于非标准 Markdown 的 LLM 提取与结构化修复",
  },
];

export const RECOMMENDED_LLM_MODEL_PROFILES: LLMModelProfiles = {
  default: "claude-sonnet-4-6",
  evaluation: "claude-opus-4-6",
  homeworkReview: "claude-sonnet-4-6",
  trainingGenerate: "claude-sonnet-4-6",
  trainingOptimize: "claude-opus-4-6",
  trainingInject: "claude-sonnet-4-6",
};

function normalizeStoredModel(model: string | undefined | null): string {
  return normalizeModelId(model || "");
}

function normalizeStoredSettings(raw: unknown): StoredLLMSettings {
  if (!raw || typeof raw !== "object") return {};
  return raw as StoredLLMSettings;
}

function hasExplicitProfileOverrides(
  rawProfiles: StoredLLMSettings["modelProfiles"]
): boolean {
  if (!rawProfiles) return false;

  return LLM_MODEL_PROFILE_OPTIONS.some((profile) =>
    Boolean(normalizeStoredModel(rawProfiles[profile.id]))
  );
}

function shouldUpgradeLegacyDefaults(
  parsed: StoredLLMSettings,
  legacyModel: string,
  hasExplicitProfiles: boolean
): boolean {
  if (hasExplicitProfiles) return false;
  if (!legacyModel) return true;

  return (
    (parsed.version ?? 0) < LLM_SETTINGS_VERSION &&
    LEGACY_DEFAULT_MODELS.has(legacyModel)
  );
}

function buildProfiles(
  parsed: StoredLLMSettings,
  legacyModel: string
): LLMModelProfiles {
  const rawProfiles = parsed.modelProfiles;
  const hasExplicitProfiles = hasExplicitProfileOverrides(rawProfiles);

  if (shouldUpgradeLegacyDefaults(parsed, legacyModel, hasExplicitProfiles)) {
    return { ...RECOMMENDED_LLM_MODEL_PROFILES };
  }

  const defaultModel =
    normalizeStoredModel(rawProfiles?.default) ||
    legacyModel ||
    RECOMMENDED_LLM_MODEL_PROFILES.default;

  return {
    default: defaultModel,
    evaluation:
      normalizeStoredModel(rawProfiles?.evaluation) ||
      RECOMMENDED_LLM_MODEL_PROFILES.evaluation,
    homeworkReview:
      normalizeStoredModel(rawProfiles?.homeworkReview) ||
      RECOMMENDED_LLM_MODEL_PROFILES.homeworkReview,
    trainingGenerate:
      normalizeStoredModel(rawProfiles?.trainingGenerate) ||
      RECOMMENDED_LLM_MODEL_PROFILES.trainingGenerate,
    trainingOptimize:
      normalizeStoredModel(rawProfiles?.trainingOptimize) ||
      RECOMMENDED_LLM_MODEL_PROFILES.trainingOptimize,
    trainingInject:
      normalizeStoredModel(rawProfiles?.trainingInject) ||
      RECOMMENDED_LLM_MODEL_PROFILES.trainingInject,
  };
}

export function getRecommendedModelForProfile(
  profileId: LLMModelProfileId
): string {
  return RECOMMENDED_LLM_MODEL_PROFILES[profileId];
}

export function getRecommendedModelProfiles(): LLMModelProfiles {
  return { ...RECOMMENDED_LLM_MODEL_PROFILES };
}

export function getRecommendedImageModel(): string {
  return DEFAULT_IMAGE_MODEL;
}

export function resolveLLMSettings(
  raw: unknown,
  profileId: LLMModelProfileId = "default"
): ResolvedLLMSettings {
  const parsed = normalizeStoredSettings(raw);
  const legacyModel = normalizeStoredModel(parsed.model);
  const modelProfiles = buildProfiles(parsed, legacyModel);
  const apiUrl = String(parsed.apiUrl || parsed.baseUrl || DEFAULT_LLM_API_URL).trim();
  const selectedModel = modelProfiles[profileId] || modelProfiles.default;
  const imageModel = String(parsed.imageModel || DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;

  return {
    apiKey: String(parsed.apiKey || "").trim(),
    apiUrl,
    baseUrl: apiUrl,
    model: selectedModel,
    modelProfiles,
    imageModel,
    selectedProfile: profileId,
    version: LLM_SETTINGS_VERSION,
  };
}

export function loadLLMSettingsFromStorage(
  profileId: LLMModelProfileId = "default"
): ResolvedLLMSettings {
  if (typeof window === "undefined") {
    return resolveLLMSettings(null, profileId);
  }

  try {
    const raw = window.localStorage.getItem(LLM_SETTINGS_STORAGE_KEY);
    if (!raw) return resolveLLMSettings(null, profileId);
    return resolveLLMSettings(JSON.parse(raw), profileId);
  } catch {
    return resolveLLMSettings(null, profileId);
  }
}

export function persistLLMSettings(params: {
  apiKey?: string;
  apiUrl?: string;
  modelProfiles: Partial<Record<LLMModelProfileId, string>>;
  imageModel?: string;
}): ResolvedLLMSettings {
  const current = loadLLMSettingsFromStorage("default");
  const nextRawProfiles: Partial<Record<LLMModelProfileId, string>> = {
    ...current.modelProfiles,
    ...params.modelProfiles,
  };
  const modelProfiles = buildProfiles(
    {
      version: current.version,
      modelProfiles: nextRawProfiles,
    },
    current.modelProfiles.default
  );

  const nextStored: StoredLLMSettings = {
    version: LLM_SETTINGS_VERSION,
    apiKey: String(params.apiKey ?? current.apiKey ?? "").trim(),
    apiUrl: String(params.apiUrl ?? current.apiUrl ?? DEFAULT_LLM_API_URL).trim(),
    model: modelProfiles.default,
    modelProfiles,
    imageModel: String(params.imageModel ?? current.imageModel ?? DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL,
  };

  if (typeof window !== "undefined") {
    window.localStorage.setItem(
      LLM_SETTINGS_STORAGE_KEY,
      JSON.stringify(nextStored)
    );
    window.dispatchEvent(new Event(LLM_SETTINGS_UPDATED_EVENT));
  }

  return resolveLLMSettings(nextStored, "default");
}
