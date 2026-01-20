"use client";

import React, { useState } from 'react';
import {
    DimensionsConfig,
    EvaluationTemplate,
    DEFAULT_DIMENSIONS,
    DIMENSION_META,
    calculateTotalScore,
} from '@/lib/templates';
import { DIMENSIONS as DIM_CONFIG } from '@/lib/config';
import { ChevronDown, ChevronRight, Info, Save, Trash2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

interface TemplateEditorProps {
    initialTemplate?: EvaluationTemplate;
    onSave: (template: Partial<EvaluationTemplate>) => Promise<void>;
    onCancel: () => void;
}

export function TemplateEditor({ initialTemplate, onSave, onCancel }: TemplateEditorProps) {
    const [name, setName] = useState(initialTemplate?.name || '');
    const [description, setDescription] = useState(initialTemplate?.description || '');
    const [isPublic, setIsPublic] = useState(initialTemplate?.is_public || false);
    const [dimensions, setDimensions] = useState<DimensionsConfig>(
        initialTemplate?.dimensions || JSON.parse(JSON.stringify(DEFAULT_DIMENSIONS))
    );
    const [expandedDims, setExpandedDims] = useState<Record<string, boolean>>({
        "goal_completion": true,
        "workflow_adherence": true
    });
    const [saving, setSaving] = useState(false);

    const totalScore = calculateTotalScore(dimensions);

    const toggleDimensionObj = (key: string) => {
        setExpandedDims(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const handleDimensionToggle = (dimKey: string, enabled: boolean) => {
        setDimensions(prev => ({
            ...prev,
            [dimKey]: {
                ...prev[dimKey],
                enabled
            }
        }));
    };

    const handleSubDimensionToggle = (dimKey: string, subKey: string, enabled: boolean) => {
        setDimensions(prev => ({
            ...prev,
            [dimKey]: {
                ...prev[dimKey],
                subDimensions: {
                    ...prev[dimKey].subDimensions,
                    [subKey]: {
                        ...prev[dimKey].subDimensions[subKey],
                        enabled
                    }
                }
            }
        }));
    };

    const handleScoreChange = (dimKey: string, subKey: string, score: number) => {
        setDimensions(prev => ({
            ...prev,
            [dimKey]: {
                ...prev[dimKey],
                subDimensions: {
                    ...prev[dimKey].subDimensions,
                    [subKey]: {
                        ...prev[dimKey].subDimensions[subKey],
                        fullScore: score
                    }
                }
            }
        }));
    };

    const handleSave = async () => {
        if (!name.trim()) {
            toast.error('请输入模板名称');
            return;
        }

        setSaving(true);
        try {
            await onSave({
                name,
                description,
                is_public: isPublic,
                dimensions
            });
            toast.success('模板已保存');
        } catch (error) {
            console.error(error);
            toast.error('保存失败');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="bg-white rounded-2xl shadow-xl border border-slate-100 overflow-hidden flex flex-col h-[85vh]">
            {/* Header */}
            <div className="p-6 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                <div>
                    <h2 className="text-xl font-bold text-slate-800">
                        {initialTemplate ? '编辑评测模板' : '创建新模板'}
                    </h2>
                    <p className="text-sm text-slate-500 mt-1">自定义评测维度和分值标准</p>
                </div>
                <div className="flex items-center gap-3">
                    <div className="px-4 py-2 bg-indigo-50 rounded-lg border border-indigo-100">
                        <span className="text-sm text-indigo-600 font-medium">总分: </span>
                        <span className="text-xl font-bold text-indigo-700">{totalScore}</span>
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-hidden flex">
                {/* Left: Basic Info */}
                <div className="w-1/3 p-6 border-r border-slate-100 overflow-y-auto bg-slate-50/30">
                    <div className="space-y-6">
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-2">模板名称</label>
                            <input
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="例如：简化版实训评测"
                                className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-2">描述说明</label>
                            <textarea
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                placeholder="简要描述该模板的适用场景..."
                                rows={4}
                                className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all resize-none"
                            />
                        </div>

                        <div className="flex items-center gap-3 p-4 bg-white rounded-xl border border-slate-200">
                            <input
                                type="checkbox"
                                id="isPublic"
                                checked={isPublic}
                                onChange={(e) => setIsPublic(e.target.checked)}
                                className="w-4 h-4 text-indigo-600 rounded focus:ring-indigo-500 border-gray-300"
                            />
                            <label htmlFor="isPublic" className="text-sm text-slate-700 font-medium cursor-pointer select-none">
                                设为公开模板
                                <span className="block text-xs text-slate-400 font-normal mt-0.5">允许其他用户查看和使用此模板</span>
                            </label>
                        </div>

                        <div className="pt-6 border-t border-slate-200">
                            <div className="p-4 bg-yellow-50 rounded-xl border border-yellow-100 text-sm text-yellow-800">
                                <div className="flex items-center gap-2 font-bold mb-1">
                                    <Info className="w-4 h-4" />
                                    提示
                                </div>
                                建议总分保持在 100 分以便于统计分析。当前总分: {totalScore}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Right: Dimension Editor */}
                <div className="w-2/3 p-6 overflow-y-auto bg-white">
                    <div className="space-y-6">
                        {Object.entries(dimensions).map(([dimKey, dimConfig]) => (
                            <div key={dimKey} className={`rounded-xl border transition-all duration-200 ${dimConfig.enabled ? 'border-slate-200 bg-white' : 'border-slate-100 bg-slate-50 opacity-60'
                                }`}>
                                {/* Dimension Header */}
                                <div className="flex items-center justify-between p-4">
                                    <div className="flex items-center gap-4">
                                        <button
                                            onClick={() => toggleDimensionObj(dimKey)}
                                            className="p-1 hover:bg-slate-100 rounded-md transition-colors"
                                        >
                                            {expandedDims[dimKey] ? <ChevronDown className="w-5 h-5 text-slate-400" /> : <ChevronRight className="w-5 h-5 text-slate-400" />}
                                        </button>

                                        <div className="flex items-center gap-3">
                                            <input
                                                type="checkbox"
                                                checked={dimConfig.enabled}
                                                onChange={(e) => handleDimensionToggle(dimKey, e.target.checked)}
                                                className="w-5 h-5 text-indigo-600 rounded focus:ring-indigo-500 border-gray-300"
                                            />
                                            <div>
                                                <h3 className="font-bold text-slate-800 flex items-center gap-2">
                                                    <span>{DIMENSION_META[dimKey]?.icon}</span>
                                                    {DIMENSION_META[dimKey]?.name || dimKey}
                                                </h3>
                                                <p className="text-xs text-slate-400">{DIMENSION_META[dimKey]?.description}</p>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-4">
                                        {/* 可以在这里加权重调节，暂时隐藏简化UI */}
                                        <span className="text-sm font-medium text-slate-500">
                                            {/* 自动计算当前维度的总分 */}
                                            {Object.values(dimConfig.subDimensions)
                                                .filter(sub => sub.enabled)
                                                .reduce((acc, sub) => acc + sub.fullScore, 0)} 分
                                        </span>
                                    </div>
                                </div>

                                {/* Sub Dimensions */}
                                {expandedDims[dimKey] && dimConfig.enabled && (
                                    <div className="border-t border-slate-100 p-4 space-y-3 bg-slate-50/30">
                                        {Object.entries(dimConfig.subDimensions).map(([subKey, subConfig]) => (
                                            <div key={subKey} className="flex items-center justify-between p-3 bg-white rounded-lg border border-slate-100 shadow-sm hover:shadow-md transition-shadow">
                                                <div className="flex items-center gap-3">
                                                    <input
                                                        type="checkbox"
                                                        checked={subConfig.enabled}
                                                        onChange={(e) => handleSubDimensionToggle(dimKey, subKey, e.target.checked)}
                                                        className="w-4 h-4 text-indigo-600 rounded focus:ring-indigo-500 border-gray-300"
                                                    />
                                                    <span className={`${subConfig.enabled ? 'text-slate-700' : 'text-slate-400'}`}>
                                                        {DIM_CONFIG[dimKey]?.subDimensions.find(s => s.key === subKey)?.name || subKey}
                                                    </span>
                                                </div>

                                                <div className="flex items-center gap-4">
                                                    {/* 分值显示 (已锁定，不可修改) */}
                                                    <div className="flex items-center gap-2" title="子维度分值固定，暂不支持自定义修改">
                                                        <span className="text-xs text-slate-400">分值</span>
                                                        <span className="w-16 px-2 py-1 text-center text-sm bg-slate-100 text-slate-600 border border-slate-200 rounded-md cursor-not-allowed">
                                                            {subConfig.fullScore}
                                                        </span>
                                                    </div>
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

            {/* Footer */}
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
                    {saving ? '保存中...' : (
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
