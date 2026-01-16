/**
 * 评测模板类型定义
 */

// 子维度配置
export interface SubDimensionConfig {
    enabled: boolean;
    fullScore: number;
}

// 主维度配置
export interface DimensionConfig {
    enabled: boolean;
    weight: number;
    subDimensions: Record<string, SubDimensionConfig>;
}

// 完整维度配置
export type DimensionsConfig = Record<string, DimensionConfig>;

// 评测模板
export interface EvaluationTemplate {
    id: string;
    user_id: string | null;
    name: string;
    description: string | null;
    is_default: boolean;
    is_public: boolean;
    dimensions: DimensionsConfig;
    created_at: string;
    updated_at: string;
}

// 创建/更新模板的请求体
export interface TemplatePayload {
    name: string;
    description?: string;
    is_public?: boolean;
    dimensions: DimensionsConfig;
}

// 默认维度配置 (与数据库种子数据一致)
export const DEFAULT_DIMENSIONS: DimensionsConfig = {
    "goal_completion": {
        enabled: true,
        weight: 1.0,
        subDimensions: {
            "knowledge_coverage": { enabled: true, fullScore: 10 },
            "ability_coverage": { enabled: true, fullScore: 10 }
        }
    },
    "workflow_adherence": {
        enabled: true,
        weight: 1.0,
        subDimensions: {
            "entry_criteria": { enabled: true, fullScore: 4 },
            "internal_sequence": { enabled: true, fullScore: 4 },
            "global_stage_flow": { enabled: true, fullScore: 4 },
            "exit_criteria": { enabled: true, fullScore: 4 },
            "nonlinear_navigation": { enabled: true, fullScore: 4 }
        }
    },
    "interaction_experience": {
        enabled: true,
        weight: 1.0,
        subDimensions: {
            "persona_stylization": { enabled: true, fullScore: 4 },
            "naturalness": { enabled: true, fullScore: 4 },
            "contextual_coherence": { enabled: true, fullScore: 4 },
            "loop_stasis": { enabled: true, fullScore: 4 },
            "conciseness": { enabled: true, fullScore: 4 }
        }
    },
    "accuracy_boundaries": {
        enabled: true,
        weight: 1.0,
        subDimensions: {
            "factuality": { enabled: true, fullScore: 5 },
            "logical_consistency": { enabled: true, fullScore: 5 },
            "admittance_ignorance": { enabled: true, fullScore: 3 },
            "safety_guardrails": { enabled: true, fullScore: 3 },
            "distraction_resistance": { enabled: true, fullScore: 4 }
        }
    },
    "teaching_strategy": {
        enabled: true,
        weight: 1.0,
        subDimensions: {
            "socratic_frequency": { enabled: true, fullScore: 5 },
            "positive_reinforcement": { enabled: true, fullScore: 5 },
            "correction_pathway": { enabled: true, fullScore: 5 },
            "deep_probing": { enabled: true, fullScore: 5 }
        }
    }
};

// 维度显示名称和描述
export const DIMENSION_META: Record<string, { name: string; description: string; icon: string }> = {
    "goal_completion": {
        name: "目标达成度",
        description: "评估知识点和能力培养目标的覆盖程度",
        icon: "🎯"
    },
    "workflow_adherence": {
        name: "流程遵循度",
        description: "评估教学流程的规范性和逻辑性",
        icon: "📋"
    },
    "interaction_experience": {
        name: "交互体验性",
        description: "评估对话的自然度和用户体验",
        icon: "💬"
    },
    "accuracy_boundaries": {
        name: "幻觉与边界",
        description: "评估事实准确性和安全边界控制",
        icon: "🛡️"
    },
    "teaching_strategy": {
        name: "教学策略",
        description: "评估教学方法和引导技巧",
        icon: "📚"
    }
};

// 计算模板的总满分
export function calculateTotalScore(dimensions: DimensionsConfig): number {
    let total = 0;
    for (const [, dim] of Object.entries(dimensions)) {
        if (!dim.enabled) continue;
        for (const [, sub] of Object.entries(dim.subDimensions)) {
            if (sub.enabled) {
                total += sub.fullScore;
            }
        }
    }
    return total;
}

// 获取启用的子维度列表
export function getEnabledSubDimensions(dimensions: DimensionsConfig): Array<{
    dimension: string;
    subDimension: string;
    fullScore: number;
}> {
    const result: Array<{ dimension: string; subDimension: string; fullScore: number }> = [];

    for (const [dimKey, dim] of Object.entries(dimensions)) {
        if (!dim.enabled) continue;
        for (const [subKey, sub] of Object.entries(dim.subDimensions)) {
            if (sub.enabled) {
                result.push({
                    dimension: dimKey,
                    subDimension: subKey,
                    fullScore: sub.fullScore
                });
            }
        }
    }

    return result;
}
