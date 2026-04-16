/**
 * 评测模板类型定义
 */

import { DIMENSIONS as STATIC_DIMENSIONS } from "./config";
import {
    getBuiltInDimensionReference,
    getBuiltInSubDimensionReference,
    getDefaultScoringGuidanceTemplate,
} from "./evaluation-template-reference";

// 旧版子维度配置
export interface SubDimensionConfig {
    enabled: boolean;
    fullScore: number;
}

// 旧版主维度配置
export interface DimensionConfig {
    enabled: boolean;
    weight: number;
    subDimensions: Record<string, SubDimensionConfig>;
}

// 旧版完整维度配置
export type DimensionsConfig = Record<string, DimensionConfig>;

// 新版子维度定义
export interface TemplateSubDimensionDefinition {
    id: string;
    key?: string;
    name: string;
    description: string;
    fullScore: number;
    enabled: boolean;
    scoringGuidance: string;
}

// 新版主维度定义
export interface TemplateDimensionDefinition {
    id: string;
    key?: string;
    name: string;
    description: string;
    weight: number;
    enabled: boolean;
    subDimensions: TemplateSubDimensionDefinition[];
}

// 新版模板结构
export interface FlexibleDimensionsConfig {
    version: 2;
    dimensions: TemplateDimensionDefinition[];
}

// 模板维度配置：兼容旧版与新版
export type TemplateDimensionsConfig = DimensionsConfig | FlexibleDimensionsConfig;

// 评测模板
export interface EvaluationTemplate {
    id: string;
    user_id: string | null;
    name: string;
    description: string | null;
    is_default: boolean;
    is_public: boolean;
    dimensions: TemplateDimensionsConfig;
    created_at: string;
    updated_at: string;
}

// 创建/更新模板的请求体
export interface TemplatePayload {
    name: string;
    description?: string;
    is_public?: boolean;
    dimensions: TemplateDimensionsConfig;
}

// 默认维度配置 (旧版兼容结构)
export const DEFAULT_DIMENSIONS: DimensionsConfig = {
    goal_completion: {
        enabled: true,
        weight: 1.0,
        subDimensions: {
            knowledge_coverage: { enabled: true, fullScore: 10 },
            ability_coverage: { enabled: true, fullScore: 10 },
        },
    },
    workflow_adherence: {
        enabled: true,
        weight: 1.0,
        subDimensions: {
            entry_criteria: { enabled: true, fullScore: 4 },
            internal_sequence: { enabled: true, fullScore: 4 },
            global_stage_flow: { enabled: true, fullScore: 4 },
            exit_criteria: { enabled: true, fullScore: 4 },
            nonlinear_navigation: { enabled: true, fullScore: 4 },
        },
    },
    interaction_experience: {
        enabled: true,
        weight: 1.0,
        subDimensions: {
            persona_stylization: { enabled: true, fullScore: 4 },
            naturalness: { enabled: true, fullScore: 4 },
            contextual_coherence: { enabled: true, fullScore: 4 },
            loop_stasis: { enabled: true, fullScore: 4 },
            conciseness: { enabled: true, fullScore: 4 },
        },
    },
    accuracy_boundaries: {
        enabled: true,
        weight: 1.0,
        subDimensions: {
            factuality: { enabled: true, fullScore: 5 },
            logical_consistency: { enabled: true, fullScore: 5 },
            admittance_ignorance: { enabled: true, fullScore: 3 },
            safety_guardrails: { enabled: true, fullScore: 3 },
            distraction_resistance: { enabled: true, fullScore: 4 },
        },
    },
    teaching_strategy: {
        enabled: true,
        weight: 1.0,
        subDimensions: {
            socratic_frequency: { enabled: true, fullScore: 5 },
            positive_reinforcement: { enabled: true, fullScore: 5 },
            correction_pathway: { enabled: true, fullScore: 5 },
            deep_probing: { enabled: true, fullScore: 5 },
        },
    },
};

// 维度显示名称和描述
export const DIMENSION_META: Record<string, { name: string; description: string; icon: string }> = {
    goal_completion: {
        name: "目标达成度",
        description: "评估知识点和能力培养目标的覆盖程度",
        icon: "🎯",
    },
    workflow_adherence: {
        name: "流程遵循度",
        description: "评估教学流程的规范性和逻辑性",
        icon: "📋",
    },
    interaction_experience: {
        name: "交互体验性",
        description: "评估对话的自然度和用户体验",
        icon: "💬",
    },
    accuracy_boundaries: {
        name: "幻觉与边界",
        description: "评估事实准确性和安全边界控制",
        icon: "🛡️",
    },
    teaching_strategy: {
        name: "教学策略",
        description: "评估教学方法和引导技巧",
        icon: "📚",
    },
};

function createId(prefix: string, fallback: string): string {
    const safeFallback = fallback.replace(/[^a-zA-Z0-9_-]/g, "_") || "item";
    return `${prefix}_${safeFallback}`;
}

export function isFlexibleTemplateDimensions(input: unknown): input is FlexibleDimensionsConfig {
    return Boolean(
        input &&
        typeof input === "object" &&
        (input as FlexibleDimensionsConfig).version === 2 &&
        Array.isArray((input as FlexibleDimensionsConfig).dimensions)
    );
}

function normalizeSubDimensionDefinition(
    raw: Partial<TemplateSubDimensionDefinition>,
    fallbackName: string,
    fallbackKey?: string
): TemplateSubDimensionDefinition {
    const name = String(raw.name || fallbackName || "未命名子维度").trim();
    const key = raw.key || fallbackKey;
    const builtInReference = getBuiltInSubDimensionReference(key);
    const rawDescription = typeof raw.description === "string" ? raw.description.trim() : "";
    const rawScoringGuidance = typeof raw.scoringGuidance === "string" ? raw.scoringGuidance.trim() : "";
    const isGenericScoringGuidance = !rawScoringGuidance
        || /^请根据教师文档要求、对话中的真实表现/i.test(rawScoringGuidance)
        || /^请重点评估/i.test(rawScoringGuidance);

    return {
        id: String(raw.id || createId("sub", key || name)),
        key,
        name,
        description: rawDescription || builtInReference?.description || "",
        fullScore: Math.max(0, Number(raw.fullScore || 0) || 0),
        enabled: raw.enabled !== false,
        scoringGuidance: (
            isGenericScoringGuidance
                ? builtInReference?.scoringGuidance || getDefaultScoringGuidanceTemplate(name)
                : rawScoringGuidance
        ).trim(),
    };
}

function normalizeDimensionDefinition(
    raw: Partial<TemplateDimensionDefinition>,
    fallbackName: string,
    fallbackKey?: string
): TemplateDimensionDefinition {
    const name = String(raw.name || fallbackName || "未命名主维度").trim();
    const key = raw.key || fallbackKey;
    const rawSubDimensions = Array.isArray(raw.subDimensions) ? raw.subDimensions : [];
    const builtInReference = getBuiltInDimensionReference(key);
    const rawDescription = typeof raw.description === "string" ? raw.description.trim() : "";
    const isGenericDimensionDescription = !rawDescription || rawDescription === (key ? DIMENSION_META[key]?.description : undefined);

    return {
        id: String(raw.id || createId("dim", key || name)),
        key,
        name,
        description: isGenericDimensionDescription ? builtInReference?.description || rawDescription : rawDescription,
        weight: Math.max(0, Number(raw.weight || 1) || 1),
        enabled: raw.enabled !== false,
        subDimensions: rawSubDimensions.map((subDimension, index) =>
            normalizeSubDimensionDefinition(subDimension, subDimension.name || `子维度 ${index + 1}`, subDimension.key)
        ),
    };
}

function convertLegacyToFlexible(dimensions: DimensionsConfig): FlexibleDimensionsConfig {
    return {
        version: 2,
        dimensions: Object.entries(dimensions).map(([dimKey, dimConfig]) => {
            const staticDim = STATIC_DIMENSIONS[dimKey];
            const dimMeta = DIMENSION_META[dimKey];
            const subDimensions = Object.entries(dimConfig.subDimensions || {}).map(([subKey, subConfig]) => {
                const staticSub = staticDim?.subDimensions.find((item) => item.key === subKey);
                const subName = staticSub?.name || subKey;
                return normalizeSubDimensionDefinition(
                    {
                        id: createId("sub", subKey),
                        key: subKey,
                        name: subName,
                        description: "",
                        fullScore: subConfig.fullScore,
                        enabled: subConfig.enabled,
                        scoringGuidance: `请重点评估“${subName}”，结合教师文档要求和对话证据给出分数，并说明扣分原因。`,
                    },
                    subName,
                    subKey
                );
            });

            return normalizeDimensionDefinition(
                {
                    id: createId("dim", dimKey),
                    key: dimKey,
                    name: dimMeta?.name || staticDim?.name || dimKey,
                    description: dimMeta?.description || "",
                    weight: dimConfig.weight,
                    enabled: dimConfig.enabled,
                    subDimensions,
                },
                dimMeta?.name || staticDim?.name || dimKey,
                dimKey
            );
        }),
    };
}

export function normalizeTemplateDimensions(dimensions?: TemplateDimensionsConfig | null): FlexibleDimensionsConfig {
    if (isFlexibleTemplateDimensions(dimensions)) {
        return {
            version: 2,
            dimensions: dimensions.dimensions.map((dimension, index) =>
                normalizeDimensionDefinition(dimension, dimension.name || `主维度 ${index + 1}`, dimension.key)
            ),
        };
    }

    return convertLegacyToFlexible(dimensions || DEFAULT_DIMENSIONS);
}

export function createDefaultFlexibleDimensions(): FlexibleDimensionsConfig {
    return normalizeTemplateDimensions(DEFAULT_DIMENSIONS);
}

export interface EnabledTemplateSubDimension {
    dimensionId: string;
    dimensionKey?: string;
    dimensionName: string;
    dimensionDescription: string;
    dimensionWeight: number;
    subDimensionId: string;
    subDimensionKey?: string;
    subDimensionName: string;
    subDimensionDescription: string;
    scoringGuidance: string;
    fullScore: number;
}

// 计算模板的总满分
export function calculateTotalScore(dimensions: TemplateDimensionsConfig): number {
    const normalized = normalizeTemplateDimensions(dimensions);
    return normalized.dimensions
        .filter((dimension) => dimension.enabled)
        .flatMap((dimension) => dimension.subDimensions)
        .filter((subDimension) => subDimension.enabled)
        .reduce((sum, subDimension) => sum + subDimension.fullScore, 0);
}

export function getEnabledDimensions(dimensions: TemplateDimensionsConfig): TemplateDimensionDefinition[] {
    const normalized = normalizeTemplateDimensions(dimensions);
    return normalized.dimensions.filter((dimension) => dimension.enabled);
}

// 获取启用的子维度列表
export function getEnabledSubDimensions(dimensions: TemplateDimensionsConfig): EnabledTemplateSubDimension[] {
    const normalized = normalizeTemplateDimensions(dimensions);
    return normalized.dimensions
        .filter((dimension) => dimension.enabled)
        .flatMap((dimension) =>
            dimension.subDimensions
                .filter((subDimension) => subDimension.enabled)
                .map((subDimension) => ({
                    dimensionId: dimension.id,
                    dimensionKey: dimension.key,
                    dimensionName: dimension.name,
                    dimensionDescription: dimension.description,
                    dimensionWeight: dimension.weight,
                    subDimensionId: subDimension.id,
                    subDimensionKey: subDimension.key,
                    subDimensionName: subDimension.name,
                    subDimensionDescription: subDimension.description,
                    scoringGuidance: subDimension.scoringGuidance,
                    fullScore: subDimension.fullScore,
                }))
        );
}
