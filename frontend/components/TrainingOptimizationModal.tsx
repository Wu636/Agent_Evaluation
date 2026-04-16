"use client";

import React, { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Sparkles, Upload, X } from "lucide-react";

import { TrainingScriptPlan } from "@/lib/training-generator/types";
import { parseTrainingScript } from "@/lib/training-injector/parser";
import { runTrainingOptimizationLoop } from "@/lib/training-optimizer/client";
import { OptimizationLoopResult, OptimizationProgressEvent } from "@/lib/training-optimizer/types";
import { EvaluationTemplate } from "@/lib/templates";

interface TeacherDocPayload {
    content?: string;
    file?: File;
    name: string;
}

interface OptimizationLogItem {
    id: string;
    type: OptimizationProgressEvent["type"];
    stage: string;
    message: string;
    current?: number;
    total?: number;
}

interface TrainingOptimizationModalProps {
    isOpen: boolean;
    onClose: () => void;
    getDocContent: () => Promise<TeacherDocPayload | null>;
    scriptMarkdown: string;
    rubricMarkdown?: string;
    modulePlan?: TrainingScriptPlan | null;
    onOptimizationApplied: (result: OptimizationLoopResult) => void;
}

export function TrainingOptimizationModal({
    isOpen,
    onClose,
    getDocContent,
    scriptMarkdown,
    rubricMarkdown,
    modulePlan,
    onOptimizationApplied,
}: TrainingOptimizationModalProps) {
    const [dialogueFile, setDialogueFile] = useState<File | null>(null);
    const [maxActions, setMaxActions] = useState(2);
    const [optimizationFeedback, setOptimizationFeedback] = useState("");
    const [running, setRunning] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");
    const [result, setResult] = useState<OptimizationLoopResult | null>(null);
    const [templates, setTemplates] = useState<EvaluationTemplate[]>([]);
    const [selectedTemplateId, setSelectedTemplateId] = useState("");
    const [progressLogs, setProgressLogs] = useState<OptimizationLogItem[]>([]);
    const [currentProgress, setCurrentProgress] = useState<OptimizationLogItem | null>(null);
    const [templatesLoading, setTemplatesLoading] = useState(false);
    const maxSelectableActions = useMemo(() => {
        const moduleCount = modulePlan?.modules.length || 0;
        if (moduleCount > 0) return moduleCount;
        return Math.max(1, parseTrainingScript(scriptMarkdown).length || 1);
    }, [modulePlan, scriptMarkdown]);
    const actionOptions = useMemo(
        () => Array.from({ length: maxSelectableActions }, (_, index) => index + 1),
        [maxSelectableActions]
    );

    const canRun = useMemo(
        () => Boolean(dialogueFile && scriptMarkdown.trim() && !running),
        [dialogueFile, running, scriptMarkdown]
    );

    useEffect(() => {
        setMaxActions((prev) => Math.max(1, Math.min(prev, maxSelectableActions)));
    }, [maxSelectableActions]);

    useEffect(() => {
        if (!isOpen) return;

        let cancelled = false;
        const fetchTemplates = async () => {
            setTemplatesLoading(true);
            try {
                const response = await fetch("/api/templates");
                const data = await response.json();
                if (cancelled) return;

                const nextTemplates = Array.isArray(data.templates) ? data.templates : [];
                setTemplates(nextTemplates);

                if (!selectedTemplateId && nextTemplates.length > 0) {
                    const defaultTemplate = nextTemplates.find((item: EvaluationTemplate) => item.is_default) || nextTemplates[0];
                    setSelectedTemplateId(defaultTemplate.id);
                }
            } catch (error) {
                console.error("加载评测模板失败:", error);
            } finally {
                if (!cancelled) setTemplatesLoading(false);
            }
        };

        void fetchTemplates();
        return () => {
            cancelled = true;
        };
    }, [isOpen]);

    const appendLog = (event: OptimizationProgressEvent) => {
        const nextLog: OptimizationLogItem = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            type: event.type,
            stage: event.stage,
            message: event.message,
            current: event.current,
            total: event.total,
        };

        setCurrentProgress(nextLog);
        setProgressLogs((prev) => [...prev.slice(-79), nextLog]);
    };

    const handleRun = async () => {
        if (!dialogueFile || !scriptMarkdown.trim()) return;

        const teacherDoc = await getDocContent();
        if (!teacherDoc) {
            setErrorMessage("请先提供教师任务文档，再执行闭环优化");
            return;
        }

        setRunning(true);
        setErrorMessage("");
        setResult(null);
        setProgressLogs([]);
        setCurrentProgress(null);

        try {
            const selectedTemplate = templates.find((item: EvaluationTemplate) => item.id === selectedTemplateId);
            const loopResult = await runTrainingOptimizationLoop({
                teacherDocFile: teacherDoc.file,
                teacherDocContent: teacherDoc.content,
                teacherDocName: teacherDoc.name,
                dialogueFile,
                dialogueRecordName: dialogueFile.name,
                scriptMarkdown,
                rubricMarkdown,
                modulePlan: modulePlan || undefined,
                maxActions,
                optimizationFeedback,
                evaluationTemplateId: selectedTemplate?.id,
                evaluationTemplateName: selectedTemplate?.name,
                evaluationTemplateDimensions: selectedTemplate?.dimensions,
                onProgress: appendLog,
            });

            setResult(loopResult);
            onOptimizationApplied(loopResult);
        } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : "闭环优化失败");
        } finally {
            setRunning(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => !running && onClose()}
        >
            <div
                className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[calc(100vh-2rem)] overflow-hidden animate-in zoom-in-95 flex flex-col"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="bg-gradient-to-r from-indigo-600 to-violet-600 p-4 text-white flex items-start justify-between gap-3">
                    <div>
                        <h3 className="font-bold text-lg flex items-center gap-2">
                            <Sparkles className="w-5 h-5" />
                            一键闭环优化
                        </h3>
                        <p className="text-indigo-100 text-sm mt-1">
                            自动完成“评测 → 归因 → 剧本修订”。修完后会直接替换当前页面的训练剧本。
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        disabled={running}
                        className="p-1 rounded-lg hover:bg-white/10 transition-colors disabled:opacity-50"
                        aria-label="关闭"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                        当前版本会自动修订训练剧本，但不会替你去智慧树平台重新跑一轮新对话。
                        优化完成后，请重新注入平台并获取新的对话记录，再发起下一轮闭环。
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-[1.2fr_0.8fr] gap-4">
                        <div>
                            <label className="text-sm font-medium text-slate-700 block mb-2">上传对话记录</label>
                            <label className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50/80 px-4 py-6 text-center cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/60 transition-colors">
                                <Upload className="w-5 h-5 text-slate-400" />
                                <span className="text-sm text-slate-700">
                                    {dialogueFile ? dialogueFile.name : "选择 .txt 或 .json 对话记录"}
                                </span>
                                <span className="text-xs text-slate-500">
                                    使用这份真实对话记录，自动判断剧本问题并修订
                                </span>
                                <input
                                    type="file"
                                    accept=".txt,.json"
                                    className="hidden"
                                    onChange={(event) => setDialogueFile(event.target.files?.[0] || null)}
                                />
                            </label>
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="text-sm font-medium text-slate-700 block mb-2">优化评测模板</label>
                                <select
                                    value={selectedTemplateId}
                                    onChange={(event) => setSelectedTemplateId(event.target.value)}
                                    disabled={running || templatesLoading || templates.length === 0}
                                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500"
                                >
                                    {templates.map((template) => (
                                        <option key={template.id} value={template.id}>
                                            {template.name}
                                        </option>
                                    ))}
                                </select>
                                <p className="text-xs text-slate-500 mt-2">
                                    可用你自定义的评测模板决定“评什么、优化什么”，不重要的维度可以直接舍去。
                                </p>
                            </div>

                            <div>
                                <label className="text-sm font-medium text-slate-700 block mb-2">自动修订模块上限</label>
                                <select
                                    value={maxActions}
                                    onChange={(event) => setMaxActions(Number(event.target.value) || 2)}
                                    disabled={running}
                                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500"
                                >
                                    {actionOptions.map((count) => (
                                        <option key={count} value={count}>
                                            {`最多 ${count} 个模块`}
                                        </option>
                                    ))}
                                </select>
                                <p className="text-xs text-slate-500 mt-2">
                                    当前剧本最多可选 {maxSelectableActions} 个模块。建议先从 1-2 个关键模块开始，避免一次性改太多造成风格漂移。
                                </p>
                            </div>
                        </div>
                    </div>

                    <div>
                        <label className="text-sm font-medium text-slate-700 block mb-2">剧本修订建议（可选）</label>
                        <textarea
                            value={optimizationFeedback}
                            onChange={(event) => setOptimizationFeedback(event.target.value)}
                            disabled={running}
                            rows={4}
                            placeholder="例如：希望减少开场白泄题、让追问更聚焦传热学分析、把第一阶段轮次控制在 2-3 轮内。"
                            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 resize-y"
                        />
                        <p className="text-xs text-slate-500 mt-2">
                            这段建议会和教师文档、对话记录、评测结果一起参与优化决策。
                        </p>
                    </div>

                    {errorMessage && (
                        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 flex items-start gap-2">
                            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                            <span>{errorMessage}</span>
                        </div>
                    )}

                    {(running || progressLogs.length > 0) && (
                        <div className="rounded-2xl border border-indigo-200 bg-indigo-50/60 p-4 space-y-3">
                            <div className="flex items-center gap-2 text-indigo-700">
                                {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                                <span className="font-semibold">优化进度</span>
                            </div>

                            {currentProgress && (
                                <div className="rounded-xl bg-white border border-indigo-100 px-3 py-2">
                                    <div className="text-sm font-medium text-slate-800">{currentProgress.message}</div>
                                    {typeof currentProgress.current === "number" && typeof currentProgress.total === "number" && currentProgress.total > 0 && (
                                        <>
                                            <div className="mt-2 h-2 rounded-full bg-slate-100 overflow-hidden">
                                                <div
                                                    className="h-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all"
                                                    style={{ width: `${Math.min(100, Math.max(0, (currentProgress.current / currentProgress.total) * 100))}%` }}
                                                />
                                            </div>
                                            <div className="mt-1 text-xs text-slate-500">
                                                {currentProgress.current} / {currentProgress.total}
                                            </div>
                                        </>
                                    )}
                                </div>
                            )}

                            <div className="rounded-xl bg-white border border-slate-200 max-h-56 overflow-y-auto">
                                <div className="px-3 py-2 border-b border-slate-100 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                                    进度日志
                                </div>
                                <div className="divide-y divide-slate-100">
                                    {progressLogs.length === 0 ? (
                                        <div className="px-3 py-3 text-sm text-slate-500">等待开始优化...</div>
                                    ) : progressLogs.map((log) => (
                                        <div key={log.id} className="px-3 py-2 text-sm">
                                            <div className="text-slate-800">{log.message}</div>
                                            <div className="mt-1 text-xs text-slate-500">
                                                {log.stage}
                                                {typeof log.current === "number" && typeof log.total === "number" ? ` · ${log.current}/${log.total}` : ""}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}

                    {result && (
                        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4 space-y-3">
                            <div className="flex items-center gap-2 text-emerald-700">
                                <CheckCircle2 className="w-5 h-5" />
                                <span className="font-semibold">优化结果已应用到当前训练剧本</span>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                                <div className="rounded-xl bg-white border border-emerald-100 px-3 py-2">
                                    <div className="text-slate-500 text-xs">当前基线分数</div>
                                    <div className="font-semibold text-slate-800">
                                        {result.baseline_report.total_score.toFixed(1)} / 100
                                    </div>
                                </div>
                                <div className="rounded-xl bg-white border border-emerald-100 px-3 py-2">
                                    <div className="text-slate-500 text-xs">已执行动作</div>
                                    <div className="font-semibold text-slate-800">{result.applied_actions.length} 条</div>
                                </div>
                                <div className="rounded-xl bg-white border border-emerald-100 px-3 py-2">
                                    <div className="text-slate-500 text-xs">待人工关注</div>
                                    <div className="font-semibold text-slate-800">{result.skipped_actions.length} 条</div>
                                </div>
                            </div>

                            <div className="text-sm text-slate-700 whitespace-pre-wrap">
                                {result.optimization_plan.summary}
                            </div>

                            {result.optimization_plan.root_causes.length > 0 && (
                                <div>
                                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">本轮聚焦问题</p>
                                    <div className="space-y-1">
                                        {result.optimization_plan.root_causes.map((cause, index) => (
                                            <div key={`${cause}-${index}`} className="text-sm text-slate-700">
                                                {index + 1}. {cause}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {result.applied_actions.length > 0 && (
                                <div>
                                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">本轮改动差异</p>
                                    <div className="space-y-2">
                                        {result.applied_actions.map((action) => (
                                            <div key={action.id} className="rounded-xl bg-white border border-emerald-100 px-3 py-2">
                                                <div className="font-medium text-slate-800">{action.title}</div>
                                                <div className="text-sm text-slate-600 mt-1 whitespace-pre-wrap">
                                                    {action.instruction}
                                                </div>
                                                <div className="text-xs text-slate-500 mt-2">
                                                    {action.module_title || action.target_module_id || "未指明模块"} · 预期改善：{action.expected_gain.join("、") || "待观察"}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {result.warnings.length > 0 && (
                                <div>
                                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">优化后仍建议检查</p>
                                    <div className="space-y-1">
                                        {result.warnings.slice(0, 4).map((warning, index) => (
                                            <div key={`${warning}-${index}`} className="text-xs text-slate-600">
                                                {index + 1}. {warning}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div className="rounded-xl bg-white border border-slate-200 px-3 py-2 text-sm text-slate-700">
                                {result.next_step}
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex gap-3 p-5 border-t border-slate-100 bg-white">
                    <button
                        onClick={onClose}
                        disabled={running}
                        className="flex-1 px-4 py-2.5 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors disabled:opacity-50"
                    >
                        关闭
                    </button>
                    <button
                        onClick={handleRun}
                        disabled={!canRun}
                        className="flex-1 px-4 py-2.5 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-lg transition-colors flex items-center justify-center gap-1.5"
                    >
                        {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                        {running ? "优化中..." : "开始一键优化"}
                    </button>
                </div>
            </div>
        </div>
    );
}
