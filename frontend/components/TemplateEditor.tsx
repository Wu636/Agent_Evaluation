"use client";

import React, { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Info, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
    createDefaultFlexibleDimensions,
    EvaluationTemplate,
    FlexibleDimensionsConfig,
    normalizeTemplateDimensions,
    TemplateDimensionDefinition,
    TemplateSubDimensionDefinition,
    calculateTotalScore,
} from "@/lib/templates";
import { getDefaultScoringGuidanceTemplate } from "@/lib/evaluation-template-reference";

interface TemplateEditorProps {
    initialTemplate?: EvaluationTemplate;
    onSave: (template: Partial<EvaluationTemplate>) => Promise<void>;
    onCancel: () => void;
}

function createDimensionId(): string {
    return `dim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createSubDimensionId(): string {
    return `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createEmptySubDimension(index: number): TemplateSubDimensionDefinition {
    return {
        id: createSubDimensionId(),
        name: `子维度 ${index + 1}`,
        description: "请描述这个子维度到底在评估什么，重点看哪些行为、结果或风险。",
        fullScore: 5,
        enabled: true,
        scoringGuidance: getDefaultScoringGuidanceTemplate(`子维度 ${index + 1}`),
    };
}

function createEmptyDimension(index: number): TemplateDimensionDefinition {
    return {
        id: createDimensionId(),
        name: `主维度 ${index + 1}`,
        description: "请描述这个主维度的总体目标，以及它为什么对当前评测场景重要。",
        weight: 1,
        enabled: true,
        subDimensions: [createEmptySubDimension(0)],
    };
}

export function TemplateEditor({ initialTemplate, onSave, onCancel }: TemplateEditorProps) {
    const [name, setName] = useState(initialTemplate?.name || "");
    const [description, setDescription] = useState(initialTemplate?.description || "");
    const [isPublic, setIsPublic] = useState(initialTemplate?.is_public || false);
    const [dimensionsConfig, setDimensionsConfig] = useState<FlexibleDimensionsConfig>(
        normalizeTemplateDimensions(initialTemplate?.dimensions || createDefaultFlexibleDimensions())
    );
    const [expandedDims, setExpandedDims] = useState<Record<string, boolean>>(() =>
        Object.fromEntries(dimensionsConfig.dimensions.map((dimension) => [dimension.id, true]))
    );
    const [saving, setSaving] = useState(false);

    const totalScore = useMemo(() => calculateTotalScore(dimensionsConfig), [dimensionsConfig]);

    const toggleDimension = (dimensionId: string) => {
        setExpandedDims((prev) => ({ ...prev, [dimensionId]: !prev[dimensionId] }));
    };

    const updateDimension = (dimensionId: string, updater: (dimension: TemplateDimensionDefinition) => TemplateDimensionDefinition) => {
        setDimensionsConfig((prev) => ({
            version: 2,
            dimensions: prev.dimensions.map((dimension) =>
                dimension.id === dimensionId ? updater(dimension) : dimension
            ),
        }));
    };

    const updateSubDimension = (
        dimensionId: string,
        subDimensionId: string,
        updater: (subDimension: TemplateSubDimensionDefinition) => TemplateSubDimensionDefinition
    ) => {
        updateDimension(dimensionId, (dimension) => ({
            ...dimension,
            subDimensions: dimension.subDimensions.map((subDimension) =>
                subDimension.id === subDimensionId ? updater(subDimension) : subDimension
            ),
        }));
    };

    const addDimension = () => {
        setDimensionsConfig((prev) => ({
            version: 2,
            dimensions: [...prev.dimensions, createEmptyDimension(prev.dimensions.length)],
        }));
    };

    const removeDimension = (dimensionId: string) => {
        setDimensionsConfig((prev) => ({
            version: 2,
            dimensions: prev.dimensions.filter((dimension) => dimension.id !== dimensionId),
        }));
    };

    const addSubDimension = (dimensionId: string) => {
        updateDimension(dimensionId, (dimension) => ({
            ...dimension,
            subDimensions: [...dimension.subDimensions, createEmptySubDimension(dimension.subDimensions.length)],
        }));
        setExpandedDims((prev) => ({ ...prev, [dimensionId]: true }));
    };

    const removeSubDimension = (dimensionId: string, subDimensionId: string) => {
        updateDimension(dimensionId, (dimension) => ({
            ...dimension,
            subDimensions: dimension.subDimensions.filter((subDimension) => subDimension.id !== subDimensionId),
        }));
    };

    const handleSave = async () => {
        if (!name.trim()) {
            toast.error("请输入模板名称");
            return;
        }

        const enabledDimensions = dimensionsConfig.dimensions.filter((dimension) => dimension.enabled);
        if (enabledDimensions.length === 0) {
            toast.error("至少保留一个启用的主维度");
            return;
        }

        for (const dimension of enabledDimensions) {
            if (!dimension.name.trim()) {
                toast.error("存在未命名的主维度");
                return;
            }

            const enabledSubDimensions = dimension.subDimensions.filter((subDimension) => subDimension.enabled);
            if (enabledSubDimensions.length === 0) {
                toast.error(`主维度「${dimension.name}」至少需要一个启用的子维度`);
                return;
            }

            for (const subDimension of enabledSubDimensions) {
                if (!subDimension.name.trim()) {
                    toast.error(`主维度「${dimension.name}」中存在未命名的子维度`);
                    return;
                }
                if (subDimension.fullScore <= 0) {
                    toast.error(`子维度「${subDimension.name}」的分值必须大于 0`);
                    return;
                }
            }
        }

        setSaving(true);
        try {
            await onSave({
                name,
                description,
                is_public: isPublic,
                dimensions: dimensionsConfig,
            });
            toast.success("模板已保存");
        } catch (error) {
            console.error(error);
            toast.error("保存失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="bg-white rounded-2xl shadow-xl border border-slate-100 overflow-hidden flex flex-col h-[85vh]">
            <div className="p-6 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                <div>
                    <h2 className="text-xl font-bold text-slate-800">
                        {initialTemplate ? "编辑评测模板" : "创建新模板"}
                    </h2>
                    <p className="text-sm text-slate-500 mt-1">
                        自定义主评分维度、子评分维度、定义描述、分值和评分规则
                    </p>
                </div>
                <div className="px-4 py-2 bg-indigo-50 rounded-lg border border-indigo-100">
                    <span className="text-sm text-indigo-600 font-medium">总分: </span>
                    <span className="text-xl font-bold text-indigo-700">{totalScore}</span>
                </div>
            </div>

            <div className="flex-1 overflow-hidden flex">
                <div className="w-1/3 p-6 border-r border-slate-100 overflow-y-auto bg-slate-50/30">
                    <div className="space-y-6">
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-2">模板名称</label>
                            <input
                                type="text"
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                placeholder="例如：强调追问深度的评测模板"
                                className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-2">描述说明</label>
                            <textarea
                                value={description}
                                onChange={(event) => setDescription(event.target.value)}
                                placeholder="简要描述模板的使用场景和目标..."
                                rows={4}
                                className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all resize-none"
                            />
                        </div>

                        <div className="flex items-center gap-3 p-4 bg-white rounded-xl border border-slate-200">
                            <input
                                type="checkbox"
                                id="isPublic"
                                checked={isPublic}
                                onChange={(event) => setIsPublic(event.target.checked)}
                                className="w-4 h-4 text-indigo-600 rounded focus:ring-indigo-500 border-gray-300"
                            />
                            <label htmlFor="isPublic" className="text-sm text-slate-700 font-medium cursor-pointer select-none">
                                设为公开模板
                                <span className="block text-xs text-slate-400 font-normal mt-0.5">
                                    允许其他用户查看和使用此模板
                                </span>
                            </label>
                        </div>

                        <div className="p-4 bg-yellow-50 rounded-xl border border-yellow-100 text-sm text-yellow-800">
                            <div className="flex items-center gap-2 font-bold mb-1">
                                <Info className="w-4 h-4" />
                                提示
                            </div>
                            系统内置模板会自动填入更完整的“定义描述”和“评分规则/打分说明”。如果你是新增维度，建议参考已有维度的写法，至少写清满分标准、分档规则、扣分点和证据要求。
                        </div>
                    </div>
                </div>

                <div className="w-2/3 p-6 overflow-y-auto bg-white">
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <h3 className="text-lg font-bold text-slate-800">维度结构</h3>
                            <p className="text-sm text-slate-500">评测和闭环优化都会按这里定义的维度执行</p>
                        </div>
                        <button
                            onClick={addDimension}
                            className="px-3 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 transition-colors inline-flex items-center gap-2"
                        >
                            <Plus className="w-4 h-4" />
                            新增主维度
                        </button>
                    </div>

                    <div className="mb-4 rounded-xl border border-indigo-100 bg-indigo-50/70 px-4 py-3 text-sm text-indigo-900">
                        <div className="font-semibold mb-1">评分规则推荐写法</div>
                        <div className="text-indigo-800 whitespace-pre-wrap">
                            {"1. 满分标准：什么表现才算完全达标\n2. 分档规则：良好/合格/不足分别对应什么情况\n3. 扣分点：哪些错误、遗漏、顺序问题或风险会扣分\n4. 证据要求：必须结合教师文档和对话轮次引用来评分"}
                        </div>
                    </div>

                    <div className="space-y-5">
                        {dimensionsConfig.dimensions.map((dimension, index) => (
                            <div key={dimension.id} className={`rounded-xl border ${dimension.enabled ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50 opacity-70"}`}>
                                <div className="flex items-start justify-between gap-4 p-4">
                                    <div className="flex items-start gap-3 flex-1">
                                        <button
                                            onClick={() => toggleDimension(dimension.id)}
                                            className="p-1 hover:bg-slate-100 rounded-md transition-colors mt-1"
                                        >
                                            {expandedDims[dimension.id] ? (
                                                <ChevronDown className="w-5 h-5 text-slate-400" />
                                            ) : (
                                                <ChevronRight className="w-5 h-5 text-slate-400" />
                                            )}
                                        </button>

                                        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-3">
                                            <div>
                                                <label className="text-xs text-slate-500 block mb-1">主维度名称</label>
                                                <input
                                                    type="text"
                                                    value={dimension.name}
                                                    onChange={(event) =>
                                                        updateDimension(dimension.id, (current) => ({ ...current, name: event.target.value }))
                                                    }
                                                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                                                />
                                            </div>
                                            <div className="grid grid-cols-[1fr_auto] gap-3">
                                                <div>
                                                    <label className="text-xs text-slate-500 block mb-1">权重</label>
                                                    <input
                                                        type="number"
                                                        min={0}
                                                        step={0.1}
                                                        value={dimension.weight}
                                                        onChange={(event) =>
                                                            updateDimension(dimension.id, (current) => ({
                                                                ...current,
                                                                weight: Math.max(0, Number(event.target.value) || 0),
                                                            }))
                                                        }
                                                        className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                                                    />
                                                </div>
                                                <label className="flex items-center gap-2 text-sm text-slate-600 mt-6">
                                                    <input
                                                        type="checkbox"
                                                        checked={dimension.enabled}
                                                        onChange={(event) =>
                                                            updateDimension(dimension.id, (current) => ({ ...current, enabled: event.target.checked }))
                                                        }
                                                        className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                                    />
                                                    启用
                                                </label>
                                            </div>
                                            <div className="md:col-span-2">
                                                <label className="text-xs text-slate-500 block mb-1">主维度定义描述</label>
                                                <textarea
                                                    value={dimension.description}
                                                    onChange={(event) =>
                                                        updateDimension(dimension.id, (current) => ({ ...current, description: event.target.value }))
                                                    }
                                                    rows={2}
                                                    placeholder="例如：评估智能体在这一大类目标下是否完成了完整覆盖、流程控制或教学引导。"
                                                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 resize-y"
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    <button
                                        onClick={() => removeDimension(dimension.id)}
                                        className="p-2 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                                        title="删除主维度"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>

                                {expandedDims[dimension.id] && (
                                    <div className="border-t border-slate-100 p-4 bg-slate-50/40 space-y-3">
                                        <div className="flex items-center justify-between">
                                            <p className="text-sm font-medium text-slate-700">子维度</p>
                                            <button
                                                onClick={() => addSubDimension(dimension.id)}
                                                className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-sm text-slate-700 hover:bg-slate-50 transition-colors inline-flex items-center gap-2"
                                            >
                                                <Plus className="w-4 h-4" />
                                                新增子维度
                                            </button>
                                        </div>

                                        {dimension.subDimensions.map((subDimension, subIndex) => (
                                            <div key={subDimension.id} className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
                                                <div className="flex items-start justify-between gap-3">
                                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1">
                                                        <div>
                                                            <label className="text-xs text-slate-500 block mb-1">子维度名称</label>
                                                            <input
                                                                type="text"
                                                                value={subDimension.name}
                                                                onChange={(event) =>
                                                                    updateSubDimension(dimension.id, subDimension.id, (current) => ({
                                                                        ...current,
                                                                        name: event.target.value,
                                                                    }))
                                                                }
                                                                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                                                            />
                                                        </div>
                                                        <div className="grid grid-cols-[1fr_auto] gap-3">
                                                            <div>
                                                                <label className="text-xs text-slate-500 block mb-1">分值</label>
                                                                <input
                                                                    type="number"
                                                                    min={1}
                                                                    step={1}
                                                                    value={subDimension.fullScore}
                                                                    onChange={(event) =>
                                                                        updateSubDimension(dimension.id, subDimension.id, (current) => ({
                                                                            ...current,
                                                                            fullScore: Math.max(1, Number(event.target.value) || 1),
                                                                        }))
                                                                    }
                                                                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                                                                />
                                                            </div>
                                                            <label className="flex items-center gap-2 text-sm text-slate-600 mt-6">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={subDimension.enabled}
                                                                    onChange={(event) =>
                                                                        updateSubDimension(dimension.id, subDimension.id, (current) => ({
                                                                            ...current,
                                                                            enabled: event.target.checked,
                                                                        }))
                                                                    }
                                                                    className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                                                />
                                                                启用
                                                            </label>
                                                        </div>
                                                        <div className="md:col-span-2">
                                                            <label className="text-xs text-slate-500 block mb-1">子维度定义描述</label>
                                                            <textarea
                                                                value={subDimension.description}
                                                                onChange={(event) =>
                                                                    updateSubDimension(dimension.id, subDimension.id, (current) => ({
                                                                        ...current,
                                                                        description: event.target.value,
                                                                    }))
                                                                }
                                                                rows={2}
                                                                placeholder="例如：评估学生回答后，智能体是否会继续追问原因、条件、机制或迁移场景。"
                                                                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 resize-y"
                                                            />
                                                        </div>
                                                        <div className="md:col-span-2">
                                                            <label className="text-xs text-slate-500 block mb-1">评分规则 / 打分说明</label>
                                                            <textarea
                                                                value={subDimension.scoringGuidance}
                                                                onChange={(event) =>
                                                                    updateSubDimension(dimension.id, subDimension.id, (current) => ({
                                                                        ...current,
                                                                        scoringGuidance: event.target.value,
                                                                    }))
                                                                }
                                                                rows={7}
                                                                placeholder="例如：满分要求、分档规则、扣分点、证据要求、关键错误情形等"
                                                                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 resize-y"
                                                            />
                                                            <p className="mt-1 text-xs text-slate-400">
                                                                推荐至少写清：满分标准、良好/合格/不足的判断边界、重点扣分点，以及评分时必须引用的证据类型。
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <button
                                                        onClick={() => removeSubDimension(dimension.id, subDimension.id)}
                                                        className="p-2 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                                                        title="删除子维度"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </button>
                                                </div>
                                                <div className="text-xs text-slate-400">
                                                    子维度 {subIndex + 1}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            <div className="p-4 border-t border-slate-100 bg-white flex justify-end gap-3">
                <button
                    onClick={onCancel}
                    className="px-6 py-2.5 rounded-xl text-slate-600 font-medium hover:bg-slate-50 transition-colors"
                >
                    取消
                </button>
                <button
                    onClick={handleSave}
                    disabled={saving}
                    className="px-6 py-2.5 rounded-xl bg-indigo-600 text-white font-bold hover:bg-indigo-700 shadow-lg shadow-indigo-100 transition-all flex items-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed"
                >
                    {saving ? "保存中..." : (
                        <>
                            <Save className="w-4 h-4" />
                            保存模板
                        </>
                    )}
                </button>
            </div>
        </div>
    );
}
