"use client";

import React, { useState, useEffect } from 'react';
import { Clock, FileText, Trash2, Eye, ArrowLeft } from 'lucide-react';
import clsx from 'clsx';
import { ReportView } from './ReportView';
import { EvaluationReport } from '@/lib/api';
import { getHistoryList, getHistoryItem, deleteHistoryItem, HistorySummary } from '@/lib/client-history';

interface HistoryViewProps {
    onBack: () => void;
}

export function HistoryView({ onBack }: HistoryViewProps) {
    const [history, setHistory] = useState<HistorySummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedReport, setSelectedReport] = useState<EvaluationReport | null>(null);

    useEffect(() => {
        fetchHistory();
    }, []);

    const fetchHistory = async () => {
        try {
            // 使用客户端 localStorage
            const data = getHistoryList();
            setHistory(data);
        } catch (error) {
            console.error('Failed to fetch history:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleViewReport = async (evalId: string) => {
        try {
            const item = getHistoryItem(evalId);
            if (item) {
                setSelectedReport(item.report);
            }
        } catch (error) {
            console.error('Failed to fetch report:', error);
        }
    };

    const handleDelete = async (evalId: string) => {
        if (!confirm('您确定要删除这条评估记录吗？')) return;

        try {
            deleteHistoryItem(evalId);
            fetchHistory(); // Refresh list
        } catch (error) {
            console.error('Failed to delete:', error);
        }
    };

    const formatDate = (isoString: string) => {
        const date = new Date(isoString);
        return date.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    };

    const getScoreColor = (score: number) => {
        if (score >= 90) return 'text-green-600 bg-green-50 border-green-200';
        if (score >= 75) return 'text-blue-600 bg-blue-50 border-blue-200';
        if (score >= 60) return 'text-yellow-600 bg-yellow-50 border-yellow-200';
        return 'text-red-600 bg-red-50 border-red-200';
    };

    // If viewing a specific report
    if (selectedReport) {
        return (
            <div className="w-full">
                <button
                    onClick={() => setSelectedReport(null)}
                    className="mb-6 flex items-center gap-2 px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-xl transition-colors font-medium border border-transparent hover:border-slate-200"
                >
                    <ArrowLeft className="w-4 h-4" />
                    返回历史列表
                </button>
                <ReportView report={selectedReport} onReset={() => setSelectedReport(null)} />
            </div>
        );
    }

    return (
        <div className="w-full max-w-5xl mx-auto animate-in fade-in duration-500">

            {/* Header */}
            <div className="mb-8 flex items-center justify-between">
                <div>
                    <h1 className="text-4xl font-black text-slate-900 mb-2">历史评估记录</h1>
                    <p className="text-slate-500">查看和管理过往的评估报告</p>
                </div>
                <button
                    onClick={onBack}
                    className="flex items-center gap-2 px-5 py-2.5 bg-white border border-slate-200 text-slate-700 rounded-xl hover:bg-slate-50 transition-colors font-medium"
                >
                    <ArrowLeft className="w-4 h-4" />
                    新建评估
                </button>
            </div>

            {/* History List */}
            {loading ? (
                <div className="text-center py-20">
                    <div className="inline-block w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                    <p className="text-slate-500 mt-4">正在加载历史记录...</p>
                </div>
            ) : history.length === 0 ? (
                <div className="text-center py-20 bg-white rounded-3xl border border-slate-200 shadow-sm">
                    <FileText className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                    <h3 className="text-xl font-bold text-slate-700 mb-2">暂无评估记录</h3>
                    <p className="text-slate-500">运行第一次评估后将在此显示</p>
                </div>
            ) : (
                <div className="space-y-4">
                    {history.map((item) => (
                        <div
                            key={item.id}
                            className="bg-white rounded-2xl border border-slate-200 hover:shadow-lg transition-all group overflow-hidden"
                        >
                            <div className="p-6 flex items-center gap-6">

                                {/* Score Badge */}
                                <div className={clsx(
                                    "flex-shrink-0 w-20 h-20 rounded-2xl border-2 flex flex-col items-center justify-center font-bold",
                                    getScoreColor(item.total_score)
                                )}>
                                    <div className="text-2xl">{item.total_score.toFixed(0)}</div>
                                    <div className="text-xs opacity-70">{item.final_level}</div>
                                </div>

                                {/* Info */}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-start gap-3 mb-2">
                                        <div className="flex-1">
                                            <h3 className="font-bold text-slate-800 truncate mb-1 text-lg">
                                                {item.teacher_doc_name}
                                            </h3>
                                            <p className="text-sm text-slate-500 truncate flex items-center gap-2">
                                                <span className="font-medium bg-slate-100 px-2 py-0.5 rounded text-slate-600 text-xs">对话记录</span>
                                                {item.dialogue_record_name}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-4 text-xs text-slate-400 mt-2">
                                        <span className="flex items-center gap-1 bg-slate-50 px-2 py-1 rounded-md border border-slate-100">
                                            <Clock className="w-3 h-3" />
                                            {formatDate(item.timestamp)}
                                        </span>
                                        <span className="px-2 py-1 bg-indigo-50 text-indigo-600 rounded-md font-medium border border-indigo-100">
                                            {item.model}
                                        </span>
                                    </div>
                                </div>

                                {/* Actions */}
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => handleViewReport(item.id)}
                                        className="p-3 text-indigo-600 hover:bg-indigo-50 rounded-xl transition-colors"
                                        title="查看报告"
                                    >
                                        <Eye className="w-5 h-5" />
                                    </button>
                                    <button
                                        onClick={() => handleDelete(item.id)}
                                        className="p-3 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition-colors"
                                        title="删除"
                                    >
                                        <Trash2 className="w-5 h-5" />
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
