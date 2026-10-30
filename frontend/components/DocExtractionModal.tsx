"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
    AlertCircle,
    CheckCircle2,
    Loader2,
    Pencil,
    RefreshCw,
    RotateCcw,
    Save,
    Sparkles,
    X,
} from "lucide-react";

import { MarkdownRenderer } from "./MarkdownRenderer";
import { reauditExtractionResult } from "@/lib/training-generator/doc-extraction/pipeline";
import type {
    DocExtractionProgress,
    DocExtractionResult,
    ExtractionMode,
} from "@/lib/training-generator/doc-extraction/types";
import { EXTRACTION_MODE_LABELS } from "@/lib/training-generator/doc-extraction/types";

type ExtractionTab = "document" | "rationale" | "removed";

interface DocExtractionModalProps {
    isOpen: boolean;
    result: DocExtractionResult | null;
    mode: ExtractionMode;
    extracting: boolean;
    progress: DocExtractionProgress | null;
    errorMessage: string;
    isExtractedActive: boolean;
    onClose: () => void;
    onCancelExtraction: () => void;
    onAdopt: (result: DocExtractionResult) => void;
    onReextract: (feedback: string) => void;
    onRestoreOriginal: () => void;
    onResultEdited: (result: DocExtractionResult) => void;
}

const STAGE_LABEL: Record<DocExtractionProgress["stage"], string> = {
    parse: "解析文档",
    chunk: "分块提取",
    merge: "合并章节",
    audit: "保真检查",
};

const STATUS_LABEL: Record<string, string> = {
    kept: "保留",
    merged: "合并",
    omitted: "省略",
};

const STATUS_STYLE: Record<string, string> = {
    kept: "bg-emerald-50 text-emerald-700 border-emerald-200",
    merged: "bg-sky-50 text-sky-700 border-sky-200",
    omitted: "bg-slate-100 text-slate-600 border-slate-200",
};

export function DocExtractionModal({
    isOpen,
    result,
    mode,
    extracting,
    progress,
    errorMessage,
    isExtractedActive,
    onClose,
    onCancelExtraction,
    onAdopt,
    onReextract,
    onRestoreOriginal,
    onResultEdited,
}: DocExtractionModalProps) {
    const [activeTab, setActiveTab] = useState<ExtractionTab>("document");
    const [isEditing, setIsEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const [editError, setEditError] = useState("");
    const [showFeedback, setShowFeedback] = useState(false);
    const [feedback, setFeedback] = useState("");

    useEffect(() => {
        if (!isOpen) return;
        setActiveTab("document");
        setIsEditing(false);
        setDraft(result?.extractedMarkdown || "");
        setEditError("");
        setShowFeedback(false);
        setFeedback("");
    }, [isOpen, result?.id]);

    const errorChecks = useMemo(
        () => (result?.checks || []).filter((check) => check.level === "error"),
        [result],
    );
    const warningChecks = useMemo(
        () => (result?.checks || []).filter((check) => check.level === "warning"),
        [result],
    );
    const removedSections = useMemo(
        () => (result?.sections || []).filter((section) => section.status !== "kept"),
        [result],
    );

    if (!isOpen) return null;

    const ratioText = result ? `${Math.round(result.stats.compressionRatio * 100)}%` : "—";
    const adoptBlocked = !result || extracting || !result.extractedMarkdown.trim();
    const modeLabel = `${EXTRACTION_MODE_LABELS[result?.mode || mode]}档`;

    const handleSaveEdit = () => {
        if (!result) return;
        if (!draft.trim()) {
            setEditError("提取结果不能为空");
            return;
        }
        const next = reauditExtractionResult(result, draft);
        onResultEdited(next);
        setDraft(next.extractedMarkdown);
        setIsEditing(false);
        setEditError("");
    };

    const handleReextract = () => {
        onReextract(feedback.trim());
    };

    const handleAdopt = () => {
        if (!result || adoptBlocked) return;
        onAdopt(result);
    };

    return (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-900/50 p-4">
            <div
                role="dialog"
                aria-modal="true"
                aria-label="长文档重点提取审阅"
                className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
            >
                <div className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-100 px-6 py-4">
                    <div>
                        <div className="flex items-center gap-2">
                            <Sparkles className="h-4 w-4 text-indigo-500" />
                            <h2 className="text-base font-semibold text-slate-800">长文档重点提取审阅</h2>
                            <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-600">
                                {modeLabel}
                            </span>
                            {result?.edited && (
                                <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-600">
                                    手动修改过
                                </span>
                            )}
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                            提取结果会作为规划、剧本与评分标准生成的教师文档；请确认关键信息完整后再采纳。
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
                        aria-label="关闭"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {extracting ? (
                    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-16">
                        <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
                        <div className="text-center">
                            <p className="text-sm font-medium text-slate-700">
                                {progress ? STAGE_LABEL[progress.stage] : "准备提取"}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">{progress?.message || "正在解析文档..."}</p>
                            {progress && progress.total > 1 && (
                                <p className="mt-1 text-xs text-slate-400">
                                    {progress.current}/{progress.total}
                                </p>
                            )}
                        </div>
                        <button
                            type="button"
                            onClick={onCancelExtraction}
                            className="rounded-lg border border-slate-200 px-4 py-2 text-xs text-slate-600 transition-colors hover:bg-slate-50"
                        >
                            取消提取
                        </button>
                    </div>
                ) : !result ? (
                    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16">
                        <AlertCircle className="h-8 w-8 text-red-400" />
                        <p className="max-w-xl text-center text-sm text-slate-700">{errorMessage || "提取失败，请重试。"}</p>
                        <button
                            type="button"
                            onClick={onClose}
                            className="rounded-lg border border-slate-200 px-4 py-2 text-xs text-slate-600 transition-colors hover:bg-slate-50"
                        >
                            关闭
                        </button>
                    </div>
                ) : (
                    <>
                        <div className="shrink-0 border-b border-slate-100 px-6 py-3">
                            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-500">
                                <span>
                                    评分项 <b className="text-slate-700">{result.stats.rubricKept}/{result.stats.rubricTotal}</b>
                                </span>
                                <span>
                                    数字 <b className="text-slate-700">{result.stats.numberKept}/{result.stats.numberTotal}</b>
                                </span>
                                <span>
                                    章节 <b className="text-slate-700">{result.sections.length}</b>
                                </span>
                                <span>
                                    字数 <b className="text-slate-700">{result.extractedChars}</b> / {result.originalChars}
                                </span>
                                <span>
                                    压缩率 <b className="text-slate-700">{ratioText}</b>
                                </span>
                                {errorChecks.length > 0 && (
                                    <span className="text-red-600">{errorChecks.length} 项需确认</span>
                                )}
                                {errorChecks.length === 0 && warningChecks.length > 0 && (
                                    <span className="text-amber-600">{warningChecks.length} 项提醒</span>
                                )}
                            </div>

                            {(errorChecks.length > 0 || warningChecks.length > 0) && (
                                <div className="mt-2 max-h-24 space-y-1 overflow-y-auto">
                                    {[...errorChecks, ...warningChecks].slice(0, 8).map((check, index) => (
                                        <div
                                            key={`${check.code}-${index}`}
                                            className={`flex items-start gap-1.5 text-xs ${check.level === "error" ? "text-red-600" : "text-amber-600"}`}
                                        >
                                            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                                            <span>{check.message}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {errorMessage && (
                            <div className="border-b border-red-100 bg-red-50 px-6 py-2 text-xs text-red-600">
                                {errorMessage}
                            </div>
                        )}

                        <div className="flex shrink-0 items-center gap-1 border-b border-slate-100 px-6 pt-3">
                            {([
                                ["document", "提取后文档"],
                                ["rationale", "提取思路"],
                                ["removed", `合并与省去 (${removedSections.length})`],
                            ] as Array<[ExtractionTab, string]>).map(([tab, label]) => (
                                <button
                                    key={tab}
                                    type="button"
                                    onClick={() => setActiveTab(tab)}
                                    className={`rounded-t-lg border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
                                        activeTab === tab
                                            ? "border-indigo-500 text-indigo-600"
                                            : "border-transparent text-slate-500 hover:text-slate-700"
                                    }`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>

                        <div className="min-h-0 flex-auto overflow-y-auto overscroll-contain px-6 py-4">
                            {activeTab === "document" && (
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between gap-2">
                                        <p className="text-xs text-slate-500">
                                            可直接编辑提取结果；保存后会重新核对数字、评分项与约束。
                                        </p>
                                        {isEditing ? (
                                            <div className="flex items-center gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setDraft(result.extractedMarkdown);
                                                        setIsEditing(false);
                                                        setEditError("");
                                                    }}
                                                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                                                >
                                                    取消
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={handleSaveEdit}
                                                    className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
                                                >
                                                    <Save className="h-3.5 w-3.5" />
                                                    保存并重新审计
                                                </button>
                                            </div>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setDraft(result.extractedMarkdown);
                                                    setIsEditing(true);
                                                }}
                                                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                                            >
                                                <Pencil className="h-3.5 w-3.5" />
                                                编辑
                                            </button>
                                        )}
                                    </div>
                                    {editError && <p className="text-xs text-red-600">{editError}</p>}
                                    {isEditing ? (
                                        <textarea
                                            value={draft}
                                            onChange={(event) => setDraft(event.target.value)}
                                            className="h-[46vh] w-full resize-none rounded-xl border border-slate-200 p-4 font-mono text-xs leading-relaxed text-slate-700 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                                        />
                                    ) : (
                                        <div className="rounded-xl border border-slate-200 p-4">
                                            <MarkdownRenderer content={result.extractedMarkdown} />
                                        </div>
                                    )}
                                </div>
                            )}

                            {activeTab === "rationale" && (
                                <div className="space-y-4">
                                    <div className="rounded-xl bg-slate-50 p-4 text-xs leading-relaxed text-slate-600 whitespace-pre-wrap">
                                        {result.rationale}
                                    </div>
                                    <div className="overflow-x-auto rounded-xl border border-slate-200">
                                        <table className="w-full text-left text-xs">
                                            <thead className="bg-slate-50 text-slate-500">
                                                <tr>
                                                    <th className="px-3 py-2 font-medium">章节</th>
                                                    <th className="px-3 py-2 font-medium">处理</th>
                                                    <th className="px-3 py-2 font-medium">原文字数</th>
                                                    <th className="px-3 py-2 font-medium">提取后</th>
                                                    <th className="px-3 py-2 font-medium">说明</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {result.sections.map((section) => (
                                                    <tr key={section.id} className="border-t border-slate-100 align-top">
                                                        <td className="max-w-[220px] px-3 py-2 text-slate-700">
                                                            {section.path || section.title}
                                                            {section.excerpt && (
                                                                <details className="mt-1 text-[11px] text-slate-500">
                                                                    <summary className="cursor-pointer text-indigo-600">查看原文片段</summary>
                                                                    <p className="mt-1 whitespace-pre-wrap">{section.excerpt}</p>
                                                                </details>
                                                            )}
                                                        </td>
                                                        <td className="px-3 py-2">
                                                            <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] ${STATUS_STYLE[section.status] || STATUS_STYLE.kept}`}>
                                                                {STATUS_LABEL[section.status] || section.status}
                                                                {section.mergedInto ? ` → ${section.mergedInto}` : ""}
                                                            </span>
                                                        </td>
                                                        <td className="px-3 py-2 text-slate-500">{section.originalChars}</td>
                                                        <td className="px-3 py-2 text-slate-500">{section.keptChars}</td>
                                                        <td className="max-w-[260px] px-3 py-2 text-slate-500">{section.reason || "—"}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            )}

                            {activeTab === "removed" && (
                                <div className="space-y-3">
                                    {removedSections.length === 0 ? (
                                        <p className="text-xs text-slate-500">本次提取没有合并或省略任何章节。</p>
                                    ) : (
                                        removedSections.map((section) => (
                                            <div key={section.id} className="rounded-xl border border-slate-200 p-3">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span className="text-xs font-medium text-slate-700">{section.path || section.title}</span>
                                                    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] ${STATUS_STYLE[section.status]}`}>
                                                        {STATUS_LABEL[section.status]}
                                                        {section.mergedInto ? ` → ${section.mergedInto}` : ""}
                                                    </span>
                                                </div>
                                                {section.excerpt ? (
                                                    <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-slate-500">
                                                        {section.excerpt}
                                                    </p>
                                                ) : (
                                                    <p className="mt-2 text-xs text-slate-400">模型未提供原文摘录。</p>
                                                )}
                                                <p className="mt-1 text-xs text-slate-600">原因：{section.reason || "未说明"}</p>
                                            </div>
                                        ))
                                    )}
                                </div>
                            )}
                        </div>

                        <div className="shrink-0 space-y-3 border-t border-slate-100 px-6 py-4">
                            {showFeedback && (
                                <div className="space-y-1">
                                    <p className="text-xs text-slate-500">
                                        修改建议（选填）：可说明哪里提取不合理；留空则直接重新提取。
                                    </p>
                                    <textarea
                                        value={feedback}
                                        onChange={(event) => setFeedback(event.target.value)}
                                        placeholder="例如：保留第二章的评分细则；恢复 2.4 节的考核点；不要省略示例对话。"
                                        className="h-20 w-full resize-none rounded-xl border border-slate-200 p-3 text-xs text-slate-700 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                                    />
                                </div>
                            )}
                            {errorChecks.length > 0 && (
                                <p className="text-xs text-red-600">存在需确认的检查项，可直接采纳，也可编辑或重新提取后再采纳。</p>
                            )}
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <button
                                    type="button"
                                    onClick={onRestoreOriginal}
                                    disabled={!isExtractedActive}
                                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    <RotateCcw className="h-3.5 w-3.5" />
                                    切回原文
                                </button>
                                <div className="flex items-center gap-2">
                                    {showFeedback ? (
                                        <button
                                            type="button"
                                            onClick={handleReextract}
                                            className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-medium text-indigo-600 transition-colors hover:bg-indigo-100"
                                        >
                                            <RefreshCw className="h-3.5 w-3.5" />
                                            确认重新提取
                                        </button>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() => setShowFeedback(true)}
                                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600 transition-colors hover:bg-slate-50"
                                        >
                                            <RefreshCw className="h-3.5 w-3.5" />
                                            重新提取
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={handleAdopt}
                                        disabled={adoptBlocked}
                                        className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        <CheckCircle2 className="h-3.5 w-3.5" />
                                        采纳并用于生成
                                    </button>
                                </div>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
