import { AVAILABLE_MODELS } from "./config";
import type {
  ModelCatalogResponse,
  ModelCategory,
  ModelGroup,
  ModelInfo,
} from "./llm/types";

const DEFAULT_MODELS_ENDPOINT =
  "https://llm-service.polymas.com/api/openai/v1/models";
const LIVE_CACHE_TTL_MS = 10 * 60 * 1000;
const FALLBACK_CACHE_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const FLAT_LIST_CATEGORIES: ModelCategory[] = ["text"];
const CATEGORY_ORDER: ModelCategory[] = [
  "text",
  "reasoning",
  "multimodal",
  "image",
  "embedding",
  "audio",
  "video",
  "tooling",
  "other",
];

const CATEGORY_META: Record<
  ModelCategory,
  { label: string; description: string }
> = {
  text: {
    label: "文生文",
    description: "适合评测、批阅、训练配置等纯文本生成任务",
  },
  reasoning: {
    label: "推理",
    description: "更擅长复杂推理和慢思考任务，通常更慢",
  },
  multimodal: {
    label: "多模态",
    description: "支持视觉或跨模态理解，但当前项目暂未作为默认候选",
  },
  image: {
    label: "文生图",
    description: "适合封面图、背景图等图像生成任务",
  },
  embedding: {
    label: "向量",
    description: "适合检索、召回、排序等嵌入任务",
  },
  audio: {
    label: "音频",
    description: "语音识别、合成或语音相关模型",
  },
  video: {
    label: "视频",
    description: "视频生成或图生视频模型",
  },
  tooling: {
    label: "工具",
    description: "翻译、OCR、文档处理等工具型能力",
  },
  other: {
    label: "其他",
    description: "暂未识别的模型或内部工具",
  },
};

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  xai: "xAI",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  bytedance: "字节跳动",
  zhipu: "智谱",
  moonshot: "Moonshot",
  iflytek: "讯飞",
  baidu: "百度",
  baichuan: "百川",
  yi: "零一万物",
  polymas: "Polymas",
  other: "其他",
};

interface ModelCatalogOptions {
  apiKey?: string;
  apiUrl?: string;
  modelsUrl?: string;
}

const KNOWN_MODEL_META: Record<
  string,
  Partial<ModelInfo> & {
    name: string;
    description: string;
    category: ModelCategory;
    provider: string;
    family: string;
    rank?: number;
  }
> = {
  "claude-opus-4-6": {
    name: "Claude Opus 4.6",
    description: "Anthropic 旗舰模型，适合高质量复杂生成",
    category: "text",
    provider: "anthropic",
    family: "Claude",
    recommended: true,
    rank: 10,
  },
  "claude-sonnet-4.5": {
    name: "Claude Sonnet 4.5",
    description: "综合质量强，适合评测、批阅和训练配置",
    category: "text",
    provider: "anthropic",
    family: "Claude",
    recommended: true,
    rank: 20,
  },
  "claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6",
    description: "新版 Sonnet，适合高质量生成与批阅",
    category: "text",
    provider: "anthropic",
    family: "Claude",
    recommended: true,
    rank: 15,
  },
  "claude-opus-4": {
    name: "Claude Opus 4",
    description: "Anthropic 高质量模型，适合复杂长文本任务",
    category: "text",
    provider: "anthropic",
    family: "Claude",
    recommended: true,
    rank: 30,
  },
  "claude-haiku-4.5": {
    name: "Claude Haiku 4.5",
    description: "更快的 Claude 轻量模型，适合成本敏感场景",
    category: "text",
    provider: "anthropic",
    family: "Claude",
    rank: 70,
  },
  "gpt-5.4": {
    name: "GPT-5.4",
    description: "OpenAI 新一代文本模型，适合高质量生成",
    category: "text",
    provider: "openai",
    family: "GPT-5",
    recommended: true,
    rank: 40,
  },
  "gpt-5": {
    name: "GPT-5",
    description: "OpenAI GPT-5 系列模型",
    category: "text",
    provider: "openai",
    family: "GPT-5",
    rank: 50,
  },
  "gpt-5-chat": {
    name: "GPT-5 Chat",
    description: "面向通用对话的 GPT-5 变体",
    category: "text",
    provider: "openai",
    family: "GPT-5",
    rank: 55,
  },
  "gpt-5-mini": {
    name: "GPT-5 Mini",
    description: "更轻量的 GPT-5 变体，适合速度优先场景",
    category: "text",
    provider: "openai",
    family: "GPT-5",
    rank: 80,
  },
  "gpt-5-nano": {
    name: "GPT-5 Nano",
    description: "超轻量 GPT-5 变体，适合基础快速任务",
    category: "text",
    provider: "openai",
    family: "GPT-5",
    rank: 90,
  },
  "gpt-4.1": {
    name: "GPT-4.1",
    description: "结构化输出稳定，适合提取、修复和判分",
    category: "text",
    provider: "openai",
    family: "GPT-4.1",
    recommended: true,
    rank: 45,
  },
  "gpt-4.1-mini": {
    name: "GPT-4.1 Mini",
    description: "轻量 GPT-4.1，适合高频文本任务",
    category: "text",
    provider: "openai",
    family: "GPT-4.1",
    rank: 85,
  },
  "gpt-4.1-nano": {
    name: "GPT-4.1 Nano",
    description: "更轻量的 GPT-4.1 变体",
    category: "text",
    provider: "openai",
    family: "GPT-4.1",
    rank: 95,
  },
  "gpt-4o": {
    name: "GPT-4o",
    description: "通用能力强，兼顾质量与兼容性",
    category: "text",
    provider: "openai",
    family: "GPT-4o",
    recommended: true,
    rank: 60,
  },
  "gpt-4o-mini": {
    name: "GPT-4o Mini",
    description: "更快的 GPT-4o 轻量模型",
    category: "text",
    provider: "openai",
    family: "GPT-4o",
    rank: 100,
  },
  "gemini-2.5-pro": {
    name: "Gemini 2.5 Pro",
    description: "长文档与复杂结构生成能力强",
    category: "text",
    provider: "google",
    family: "Gemini",
    recommended: true,
    rank: 65,
  },
  "gemini-2.5-flash": {
    name: "Gemini 2.5 Flash",
    description: "速度更快的 Gemini 2.5 变体",
    category: "text",
    provider: "google",
    family: "Gemini",
    rank: 110,
  },
  "grok-4": {
    name: "Grok-4",
    description: "xAI 旗舰模型",
    category: "text",
    provider: "xai",
    family: "Grok",
    recommended: true,
    rank: 75,
  },
  "deepseek-v3.1": {
    name: "DeepSeek V3.1",
    description: "中文表现强，适合成本与质量平衡场景",
    category: "text",
    provider: "deepseek",
    family: "DeepSeek",
    recommended: true,
    rank: 120,
  },
  "deepseek-v4-pro": {
    name: "DeepSeek V4 Pro",
    description: "DeepSeek 新一代旗舰文本模型",
    category: "text",
    provider: "deepseek",
    family: "DeepSeek",
    recommended: true,
    rank: 112,
  },
  "deepseek-v4": {
    name: "DeepSeek V4",
    description: "DeepSeek 新一代文本模型",
    category: "text",
    provider: "deepseek",
    family: "DeepSeek",
    recommended: true,
    rank: 118,
  },
  "deepseek-v3": {
    name: "DeepSeek V3",
    description: "中文文本生成表现稳定",
    category: "text",
    provider: "deepseek",
    family: "DeepSeek",
    rank: 130,
  },
  "qwen3.6-plus": {
    name: "Qwen 3.6 Plus",
    description: "阿里系高质量中文文本模型",
    category: "text",
    provider: "qwen",
    family: "Qwen",
    recommended: true,
    rank: 140,
  },
  "qwen3.5-plus": {
    name: "Qwen 3.5 Plus",
    description: "Qwen 高质量文本模型",
    category: "text",
    provider: "qwen",
    family: "Qwen",
    rank: 150,
  },
  "qwen3-max": {
    name: "Qwen 3 Max",
    description: "Qwen 旗舰文本模型",
    category: "text",
    provider: "qwen",
    family: "Qwen",
    rank: 145,
  },
  "gpt-image-1.5": {
    name: "GPT Image 1.5",
    description: "OpenAI 图像生成模型，适合高质量封面与背景图",
    category: "image",
    provider: "openai",
    family: "GPT Image",
    recommended: true,
    rank: 10,
  },
  "dall-e-3": {
    name: "DALL-E 3",
    description: "OpenAI 图像生成模型，适合文生图",
    category: "image",
    provider: "openai",
    family: "DALL-E",
    recommended: true,
    rank: 20,
  },
  "doubao-seedream-4-0-250828": {
    name: "豆包 Seedream 4.0",
    description: "适合中文教学场景封面与背景图",
    category: "image",
    provider: "bytedance",
    family: "Seedream",
    recommended: true,
    rank: 30,
  },
  "doubao-seedream-5-0-260128": {
    name: "豆包 Seedream 5.0",
    description: "新一代 Seedream 图像模型",
    category: "image",
    provider: "bytedance",
    family: "Seedream",
    recommended: true,
    rank: 15,
  },
  "qwen-image-plus": {
    name: "Qwen Image Plus",
    description: "阿里系图像生成模型，适合中文场景",
    category: "image",
    provider: "qwen",
    family: "Qwen Image",
    recommended: true,
    rank: 40,
  },
};

const CANONICAL_ALIASES: Array<[string, string]> = [
  ["Claude 3.5 HaiKu", "claude-3.5-haiku"],
  ["claude-3.5-HaiKu", "claude-3.5-haiku"],
  ["Claude 3.5 Sonnet", "claude-3.5-sonnet"],
  ["claude-3-5-sonnet-20241022", "claude-3.5-sonnet"],
  ["Claude 3.7 Sonnet", "claude-3.7-sonnet"],
  ["claude-3.7-sonnet", "claude-3.7-sonnet"],
  ["Claude Sonnet 4", "claude-sonnet-4"],
  ["Claude Sonnet 4.5", "claude-sonnet-4.5"],
  ["claude-4.5-sonnet", "claude-sonnet-4.5"],
  ["claude-sonnet-4-20250514", "claude-sonnet-4.5"],
  ["Claude Sonnet 4.6", "claude-sonnet-4-6"],
  ["claude-sonnet-4-6", "claude-sonnet-4-6"],
  ["Claude Haiku 4.5", "claude-haiku-4.5"],
  ["claude-4.5-haiku", "claude-haiku-4.5"],
  ["Claude Opus 4", "claude-opus-4"],
  ["claude-opus-4", "claude-opus-4"],
  ["Claude Opus 4.6", "claude-opus-4-6"],
  ["claude-opus-4-6", "claude-opus-4-6"],
  ["Doubao-Seedream-4.0", "doubao-seedream-4-0-250828"],
  ["doubao-seedream-4-0-250828", "doubao-seedream-4-0-250828"],
  ["doubao-seedream-3-0-t2i-250415", "doubao-seedream-3-0-t2i-250415"],
  ["Doubao-Seed-2.0-pro", "Doubao-Seed-2.0-pro"],
  ["gpt-4o", "gpt-4o"],
  ["gpt-4o-mini", "gpt-4o-mini"],
  ["gpt-4.1", "gpt-4.1"],
  ["gpt-4.1-mini", "gpt-4.1-mini"],
  ["gpt-4.1-nano", "gpt-4.1-nano"],
  ["gpt-5.4", "gpt-5.4"],
  ["gemini-2.5-pro", "gemini-2.5-pro"],
  ["gemini-2.5-flash", "gemini-2.5-flash"],
  ["grok-4", "grok-4"],
  ["deepseek-v4-pro", "deepseek-v4-pro"],
  ["deepseek-v4", "deepseek-v4"],
  ["deepseek-v3.1", "deepseek-v3.1"],
  ["qwen3.6-plus", "qwen3.6-plus"],
  ["gpt-image-1.5", "gpt-image-1.5"],
  ["dall-e-3", "dall-e-3"],
  ["qwen-image-plus", "qwen-image-plus"],
];

const CANONICAL_ALIAS_MAP = new Map(
  CANONICAL_ALIASES.map(([alias, canonical]) => [normalizeAliasKey(alias), canonical])
);

const cachedCatalogs = new Map<
  string,
  { expiresAt: number; value: ModelCatalogResponse }
>();

function normalizeAliasKey(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeModelsEndpoint(baseUrl?: string): string {
  const raw = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!raw) return DEFAULT_MODELS_ENDPOINT;

  const normalized = raw
    .replace(/\/chat\/completions(?:\/stream)?$/i, "/models")
    .replace(/\/images\/generations$/i, "/models");

  if (/\/models$/i.test(normalized)) {
    return normalized;
  }

  return `${normalized}/models`;
}

function canonicalizeModelId(rawModel: string): string {
  const raw = String(rawModel || "").trim();
  if (!raw) return "";
  return CANONICAL_ALIAS_MAP.get(normalizeAliasKey(raw)) || raw;
}

function detectCategory(modelId: string): ModelCategory {
  const key = modelId.toLowerCase();

  if (
    /(dall-e|gpt-image|seedream|stable-diffusion|cogview|wanx|wan\d|qwen-image|jimeng|image-edit|t2i|i2i|gemini-.*image)/i.test(
      key
    )
  ) {
    return "image";
  }

  if (/(t2v|i2v|video)/i.test(key)) {
    return "video";
  }

  if (/(embedding|rerank)/i.test(key)) {
    return "embedding";
  }

  if (/(speech|voice|tts|paraformer|cosyvoice|audio)/i.test(key)) {
    return "audio";
  }

  if (
    /(ocr|translate|pdf-to-markdown|deepresearch|research|compress|kb-v1)/i.test(
      key
    )
  ) {
    return "tooling";
  }

  if (/(vl|vision|omni|image-preview)/i.test(key)) {
    return "multimodal";
  }

  if (
    /(^o1\b|^o3\b|^o4\b|reason|thinking|r1\b|qwq|qvq|reasoner)/i.test(key)
  ) {
    return "reasoning";
  }

  if (
    /(gpt|claude|gemini|grok|deepseek|qwen|glm|chatglm|moonshot|kimi|doubao|spark|yi-|baichuan|ernie|eb-instant|bloomz|maas|xinghai|completions)/i.test(
      key
    )
  ) {
    return "text";
  }

  return "other";
}

function detectProvider(modelId: string): string {
  const key = modelId.toLowerCase();

  if (/(gpt|dall-e|^o1\b|^o3\b|^o4\b)/i.test(key)) return "openai";
  if (/claude/i.test(key)) return "anthropic";
  if (/gemini/i.test(key)) return "google";
  if (/grok/i.test(key)) return "xai";
  if (/deepseek/i.test(key)) return "deepseek";
  if (/(qwen|wanx|wan\d|ali-)/i.test(key)) return "qwen";
  if (/(doubao|seedream|paraformer|cosyvoice)/i.test(key)) return "bytedance";
  if (/(glm|chatglm|cogview)/i.test(key)) return "zhipu";
  if (/(moonshot|kimi)/i.test(key)) return "moonshot";
  if (/spark/i.test(key)) return "iflytek";
  if (/(baidu|ernie|eb-instant)/i.test(key)) return "baidu";
  if (/baichuan/i.test(key)) return "baichuan";
  if (/yi-/i.test(key)) return "yi";
  if (/(polymas|maas)/i.test(key)) return "polymas";
  return "other";
}

function detectFamily(modelId: string, provider: string): string {
  const key = modelId.toLowerCase();

  if (provider === "openai") {
    if (key.startsWith("gpt-5")) return "GPT-5";
    if (key.startsWith("gpt-4.1")) return "GPT-4.1";
    if (key.startsWith("gpt-4o")) return "GPT-4o";
    if (key.includes("dall-e")) return "DALL-E";
    if (key.includes("gpt-image")) return "GPT Image";
    if (/^o[134]/.test(key)) return "o-series";
  }

  if (provider === "anthropic") return "Claude";
  if (provider === "google") return "Gemini";
  if (provider === "xai") return "Grok";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "qwen") return key.includes("image") ? "Qwen Image" : "Qwen";
  if (provider === "bytedance") {
    return key.includes("seedream") ? "Seedream" : "Doubao";
  }
  if (provider === "zhipu") return "GLM";
  if (provider === "moonshot") return "Moonshot";
  if (provider === "iflytek") return "Spark";
  if (provider === "baidu") return "ERNIE";
  if (provider === "baichuan") return "Baichuan";
  if (provider === "yi") return "Yi";
  if (provider === "polymas") return "Polymas";
  return "Other";
}

function buildGenericDescription(
  category: ModelCategory,
  provider: string
): string {
  const categoryLabel = CATEGORY_META[category].label;
  const providerLabel = PROVIDER_LABELS[provider] || PROVIDER_LABELS.other;
  return `${categoryLabel} · ${providerLabel}`;
}

function prettifyModelName(modelId: string): string {
  const raw = String(modelId || "").trim();
  if (!raw) return "";
  if (/[A-Z\u4e00-\u9fa5 ]/.test(raw)) return raw;

  return raw
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => {
      if (/^(gpt|glm|ocr|tts|vl|maas)$/i.test(part)) {
        return part.toUpperCase();
      }
      if (/^\d/.test(part)) {
        return part;
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function isProjectRelevantTextModel(model: ModelInfo): boolean {
  return Boolean(
    model.category && FLAT_LIST_CATEGORIES.includes(model.category)
  );
}

function modelRank(model: ModelInfo): number {
  return Number(KNOWN_MODEL_META[model.id]?.rank || 9_999);
}

function compareModels(a: ModelInfo, b: ModelInfo): number {
  const byRank = modelRank(a) - modelRank(b);
  if (byRank !== 0) return byRank;

  if (a.recommended !== b.recommended) {
    return a.recommended ? -1 : 1;
  }

  const providerA = PROVIDER_LABELS[a.provider || "other"] || "";
  const providerB = PROVIDER_LABELS[b.provider || "other"] || "";
  const byProvider = providerA.localeCompare(providerB, "zh-Hans-CN");
  if (byProvider !== 0) return byProvider;

  return a.name.localeCompare(b.name, "zh-Hans-CN", {
    numeric: true,
    sensitivity: "base",
  });
}

function createModelInfo(
  canonicalId: string,
  aliases: string[],
  source: "live" | "fallback"
): ModelInfo {
  const known = KNOWN_MODEL_META[canonicalId];
  const category = known?.category || detectCategory(canonicalId);
  const provider = known?.provider || detectProvider(canonicalId);
  const family = known?.family || detectFamily(canonicalId, provider);

  return {
    id: canonicalId,
    name: known?.name || prettifyModelName(canonicalId),
    description:
      known?.description || buildGenericDescription(category, provider),
    category,
    categoryLabel: CATEGORY_META[category].label,
    provider,
    family,
    aliases: aliases.length > 1 ? aliases.sort() : undefined,
    recommended: Boolean(known?.recommended),
    source,
  };
}

function extractRawModelNames(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return payload
      .map((item) => (typeof item === "string" ? item : ""))
      .filter(Boolean);
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const container = payload as Record<string, unknown>;
  const candidates = [container.models, container.data];

  for (const value of candidates) {
    if (!Array.isArray(value)) continue;

    if (value.every((item) => typeof item === "string")) {
      return value as string[];
    }

    const names = value
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const row = item as Record<string, unknown>;
        return String(row.id || row.model || row.name || "").trim();
      })
      .filter(Boolean);

    if (names.length > 0) return names;
  }

  return [];
}

function buildCatalogFromModelNames(
  rawModels: string[],
  source: "live" | "fallback",
  endpoint: string,
  error?: string
): ModelCatalogResponse {
  const deduped = new Map<string, Set<string>>();

  for (const rawModel of rawModels) {
    const trimmed = String(rawModel || "").trim();
    if (!trimmed) continue;

    const canonicalId = canonicalizeModelId(trimmed);
    if (!canonicalId) continue;

    if (!deduped.has(canonicalId)) {
      deduped.set(canonicalId, new Set<string>());
    }
    deduped.get(canonicalId)?.add(trimmed);
  }

  const allModels = Array.from(deduped.entries())
    .map(([canonicalId, aliases]) =>
      createModelInfo(canonicalId, Array.from(aliases), source)
    )
    .sort(compareModels);

  const groups: ModelGroup[] = CATEGORY_ORDER.map((category) => {
    const models = allModels
      .filter((model) => model.category === category)
      .sort(compareModels);

    return {
      key: category,
      label: CATEGORY_META[category].label,
      description: CATEGORY_META[category].description,
      models,
    };
  }).filter((group) => group.models.length > 0);

  const models = allModels.filter(isProjectRelevantTextModel).sort(compareModels);

  return {
    models,
    groups,
    source,
    fetchedAt: new Date().toISOString(),
    modelEndpoint: endpoint,
    totalRawModels: rawModels.length,
    totalModels: allModels.length,
    error,
  };
}

function buildFallbackCatalog(endpoint: string, error?: string): ModelCatalogResponse {
  const fallbackModels = AVAILABLE_MODELS.map((model) => model.id);
  return buildCatalogFromModelNames(fallbackModels, "fallback", endpoint, error);
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

function buildCatalogCacheKey(endpoint: string, apiKey?: string): string {
  return `${endpoint}::${String(apiKey || "").trim()}`;
}

async function fetchLiveCatalog(
  endpoint: string,
  apiKeyOverride?: string
): Promise<ModelCatalogResponse> {
  const apiKey = String(apiKeyOverride || process.env.LLM_API_KEY || "").trim();
  const headers: Record<string, string> = {};

  if (apiKey) {
    headers["api-key"] = apiKey;
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetchJsonWithTimeout(
    endpoint,
    {
      method: "GET",
      headers,
    },
    FETCH_TIMEOUT_MS
  );

  if (!response.ok) {
    const rawText = await response.text().catch(() => "");
    throw new Error(
      `模型接口请求失败 (${response.status})${rawText ? `: ${rawText.slice(0, 160)}` : ""}`
    );
  }

  const payload = await response.json();
  const rawModels = extractRawModelNames(payload);

  if (rawModels.length === 0) {
    throw new Error("模型接口返回为空或格式无法识别");
  }

  return buildCatalogFromModelNames(rawModels, "live", endpoint);
}

export async function getModelCatalog(
  options: ModelCatalogOptions = {}
): Promise<ModelCatalogResponse> {
  const endpoint = normalizeModelsEndpoint(
    options.modelsUrl ||
      options.apiUrl ||
      process.env.LLM_MODELS_URL ||
      process.env.LLM_BASE_URL
  );
  const apiKey = String(options.apiKey || process.env.LLM_API_KEY || "").trim();
  const cacheKey = buildCatalogCacheKey(endpoint, apiKey);
  const now = Date.now();
  const cachedCatalog = cachedCatalogs.get(cacheKey);

  if (cachedCatalog && cachedCatalog.expiresAt > now) {
    return cachedCatalog.value;
  }

  try {
    const liveCatalog = await fetchLiveCatalog(endpoint, apiKey);
    cachedCatalogs.set(cacheKey, {
      expiresAt: now + LIVE_CACHE_TTL_MS,
      value: liveCatalog,
    });
    return liveCatalog;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error || "模型接口拉取失败");
    const fallbackCatalog = buildFallbackCatalog(endpoint, message);
    cachedCatalogs.set(cacheKey, {
      expiresAt: now + FALLBACK_CACHE_TTL_MS,
      value: fallbackCatalog,
    });
    return fallbackCatalog;
  }
}
