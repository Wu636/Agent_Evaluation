"use client";

import React, { useState, useEffect } from 'react';
import { Clock, FileText, Trash2, Eye, ArrowLeft, Share2, Lock, Unlock, Copy, Check, Edit2, X as CloseIcon, Save as SaveIcon } from 'lucide-react';
import clsx from 'clsx';
import { ReportView } from './ReportView';
import { EvaluationReport } from '@/lib/api';
import { useAuth } from './AuthProvider';

interface CloudEvaluation {
    id: string;
    teacher_doc_name: string;
    teacher_doc_content?: string;
    dialogue_record_name: string;
    dialogue_data?: any;
    total_score: number;
    final_level: string;
    model_used: string;
    dimensions: any[];
    veto_reasons: string[];
    is_public: boolean;
    share_token: string | null;
    created_at: string;
}

interface HistoryViewProps {
    onBack: () => void;
}

export function HistoryView({ onBack }: HistoryViewProps) {
    const { session, isGuest } = useAuth();
    const [history, setHistory] = useState<CloudEvaluation[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedReport, setSelectedReport] = useState<EvaluationReport | null>(null);
    const [selectedEvaluation, setSelectedEvaluation] = useState<CloudEvaluation | null>(null);
    const [copiedId, setCopiedId] = useState<string | null>(null);

    // Rename state
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState('');

    useEffect(() => {
        fetchHistory();
    }, [session]);

    const fetchHistory = async () => {
        if (!session?.access_token && !isGuest) {
            setLoading(false);
            return;
        }

        try {
            if (isGuest) {
                // 游客模式：从localStorage加载本地历史
                const localHistory = localStorage.getItem('evaluation_history');
                if (localHistory) {
                    const historyItems = JSON.parse(localHistory);
                    const formattedHistory = historyItems.map((item: any, index: number) => ({
                        id: item.id || `local_${index}`,
                        teacher_doc_name: item.teacherDocName || item.teacher_doc_name || 'unknown',
                        teacher_doc_content: item.report?.teacher_doc_content, // 尝试从报告中恢复
                        dialogue_record_name: item.dialogueRecordName || item.dialogue_record_name || 'unknown',
                        dialogue_data: item.report?.dialogue_doc_content, // 游客模式下可能直接存了内容
                        total_score: item.report?.total_score || item.totalScore || 0,
                        final_level: item.report?.final_level || item.finalLevel || '',
                        model_used: item.modelName || item.model_used || '',
                        dimensions: item.report?.dimensions || [],
                        veto_reasons: item.report?.veto_reasons || [],
                        is_public: false,
                        share_token: null,
                        created_at: item.timestamp || item.created_at || new Date().toISOString(),
                    }));
                    setHistory(formattedHistory);
                }
            } else {
                // 正常登录用户：从云端获取
                if (!session?.access_token) {
                    console.error('No valid session found');
                    return;
                }

                const res = await fetch('/api/evaluations', {
                    headers: {
                        'Authorization': `Bearer ${session.access_token}`
                    }
                });

                if (res.ok) {
                    const data = await res.json();
                    setHistory(data.evaluations || []);
                }
            }
        } catch (error) {
            console.error('Failed to fetch history:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleViewReport = (evaluation: CloudEvaluation) => {
        const report: EvaluationReport = {
            task_id: evaluation.id,
            total_score: evaluation.total_score,
            dimensions: evaluation.dimensions,
            analysis: '',
            issues: [],
            suggestions: [],
            final_level: evaluation.final_level as any,
            pass_criteria_met: evaluation.total_score >= 60,
            veto_reasons: evaluation.veto_reasons || [],
            // 注入源文档内容
            teacher_doc_name: evaluation.teacher_doc_name,
            teacher_doc_content: evaluation.teacher_doc_content,
            dialogue_doc_name: evaluation.dialogue_record_name,
            dialogue_doc_content: typeof evaluation.dialogue_data === 'string'
                ? evaluation.dialogue_data
                : JSON.stringify(evaluation.dialogue_data, null, 2)
        };
        setSelectedReport(report);
        setSelectedEvaluation(evaluation);
    };

    const handleStartRename = (item: CloudEvaluation) => {
        setEditingId(item.id);
        setEditName(item.teacher_doc_name);
    };

    const handleSaveRename = async () => {
        if (!editingId || !editName.trim() || !session?.access_token) return;

        try {
            const res = await fetch(`/api/evaluations/${editingId}`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({ teacher_doc_name: editName.trim() })
            });

            if (res.ok) {
                // Optimistic update
                setHistory(prev => prev.map(item =>
                    item.id === editingId
                        ? { ...item, teacher_doc_name: editName.trim() }
                        : item
                ));
                setEditingId(null);
            } else {
                alert('重命名失败，请重试');
            }
        } catch (error) {
            console.error('Failed to rename:', error);
            alert('重命名失败');
        }
    };

    const handleDelete = async (evalId: string) => {
        if (!confirm('您确定要删除这条评估记录吗？')) return;
        if (!session?.access_token) return;

        try {
            const res = await fetch(`/api/evaluations/${evalId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${session.access_token}`
                }
            });

            if (res.ok) {
                fetchHistory(); // Refresh list
            }
        } catch (error) {
            console.error('Failed to delete:', error);
        }
    };

    const handleTogglePublic = async (evalId: string, currentPublic: boolean) => {
        if (!session?.access_token) return;

        try {
            const res = await fetch(`/api/evaluations/${evalId}`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({ is_public: !currentPublic })
            });

            if (res.ok) {
                fetchHistory(); // Refresh list
            }
        } catch (error) {
            console.error('Failed to toggle public:', error);
        }
    };

    const handleGenerateShare = async (evalId: string) => {
        if (!session?.access_token) return;

        try {
            const res = await fetch(`/api/evaluations/${evalId}/share`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${session.access_token}`
                }
            });

            if (res.ok) {
                const data = await res.json();
                // Copy to clipboard
                await navigator.clipboard.writeText(data.share_url);
                setCopiedId(evalId);
                setTimeout(() => setCopiedId(null), 2000);

                fetchHistory(); // Refresh to show share token
            }
        } catch (error) {
            console.error('Failed to generate share link:', error);
        }
    };

    const handleCopyShareLink = async (shareToken: string, evalId: string) => {
        const shareUrl = `${window.location.origin}/report/${shareToken}`;
        await navigator.clipboard.writeText(shareUrl);
        setCopiedId(evalId);
        setTimeout(() => setCopiedId(null), 2000);
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
                <ReportView report={selectedReport} onReset={() => {
                    setSelectedReport(null);
                    setSelectedEvaluation(null);
                }} />
            </div>
        );
    }

    // Not logged in and not guest
    if (!session && !isGuest) {
        return (
            <div className="w-full max-w-5xl mx-auto">
                <div className="text-center py-20 bg-white rounded-3xl border border-slate-200 shadow-sm">
                    <Lock className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                    <h3 className="text-xl font-bold text-slate-700 mb-2">请先登录</h3>
                    <p className="text-slate-500">登录后可查看云端保存的评测记录</p>
                </div>
            </div>
        );
    }

    return (
        <div className="w-full max-w-5xl mx-auto animate-in fade-in duration-500">

            {/* Header */}
            <div className="mb-8 flex items-center justify-between">
                <div>
                    <h1 className="text-4xl font-black text-slate-900 mb-2">
                        历史评估记录
                        {isGuest && (
                            <span className="ml-3 text-sm font-normal text-slate-500 bg-slate-100 px-3 py-1 rounded-lg">
                                游客模式 - 本地数据
                            </span>
                        )}
                    </h1>
                    <p className="text-slate-500">
                        {isGuest ? '查看本地保存的评估记录（游客模式）' : '查看和管理过往的评估报告'}
                    </p>
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
                                    "flex-shrink-0 w-16 h-16 rounded-2xl border-2 flex items-center justify-center font-bold text-xl",
                                    getScoreColor(item.total_score)
                                )}>
                                    {item.total_score.toFixed(0)}
                                </div>

                                {/* Info */}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-start gap-3 mb-2">
                                        <div className="flex-1">
                                            {editingId === item.id ? (
                                                <div className="flex items-center gap-2 mb-1">
                                                    <input
                                                        type="text"
                                                        value={editName}
                                                        onChange={(e) => setEditName(e.target.value)}
                                                        className="flex-1 px-2 py-1 text-lg font-bold border border-indigo-300 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                                        autoFocus
                                                    />
                                                    <button
                                                        onClick={handleSaveRename}
                                                        className="p-1 text-green-600 hover:bg-green-50 rounded"
                                                        title="保存"
                                                    >
                                                        <SaveIcon className="w-5 h-5" />
                                                    </button>
                                                    <button
                                                        onClick={() => setEditingId(null)}
                                                        className="p-1 text-slate-400 hover:bg-slate-50 rounded"
                                                        title="取消"
                                                    >
                                                        <CloseIcon className="w-5 h-5" />
                                                    </button>
                                                </div>
                                            ) : (
                                                <div className="flex items-center gap-2 group/title">
                                                    <h3 className="font-bold text-slate-800 truncate mb-1 text-lg">
                                                        {item.teacher_doc_name}
                                                    </h3>
                                                    {!isGuest && (
                                                        <button
                                                            onClick={() => handleStartRename(item)}
                                                            className="opacity-0 group-hover/title:opacity-100 p-1 text-slate-400 hover:text-indigo-600 transition-opacity"
                                                            title="重命名"
                                                        >
                                                            <Edit2 className="w-4 h-4" />
                                                        </button>
                                                    )}
                                                </div>
                                            )}

                                            <p className="text-sm text-slate-500 truncate flex items-center gap-2">
                                                <span className="font-medium bg-slate-100 px-2 py-0.5 rounded text-slate-600 text-xs">对话记录</span>
                                                {item.dialogue_record_name}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="space-y-2 mt-2">
                                        <div className="flex items-center justify-between">
                                            <span className="flex items-center gap-2 text-xs text-slate-400">
                                                <span className="flex items-center gap-1 bg-slate-50 px-2 py-1 rounded-md border border-slate-100">
                                                    <Clock className="w-3 h-3" />
                                                    {formatDate(item.created_at)}
                                                </span>
                                            </span>
                                            <div className="flex items-center gap-2 text-xs">
                                                <span className="flex items-center gap-1 px-2 py-1 bg-indigo-50 text-indigo-600 rounded-md font-mono border border-indigo-100">
                                                    ID: {item.id.substring(0, 8)}
                                                </span>
                                                <span className="px-2 py-1 bg-indigo-50 text-indigo-600 rounded-md font-medium border border-indigo-100">
                                                    {item.model_used}
                                                </span>
                                                {item.is_public && <span className="px-2 py-1 bg-green-50 text-green-600 rounded-md font-medium border border-green-100">公开</span>}
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* Actions */}
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => handleViewReport(item)}
                                        className="p-3 text-indigo-600 hover:bg-indigo-50 rounded-xl transition-colors"
                                        title="查看报告"
                                    >
                                        <Eye className="w-5 h-5" />
                                    </button>

                                    {!isGuest && (
                                        <>
                                            <button
                                                onClick={() => handleTogglePublic(item.id, item.is_public)}
                                                className={`p-3 rounded-xl transition-colors ${item.is_public ? 'text-green-600 hover:bg-green-50' : 'text-slate-400 hover:bg-slate-50'}`}
                                                title={item.is_public ? "设为私有" : "设为公开"}
                                            >
                                                {item.is_public ? <Unlock className="w-5 h-5" /> : <Lock className="w-5 h-5" />}
                                            </button>

                                            {item.share_token ? (
                                                <button
                                                    onClick={() => handleCopyShareLink(item.share_token!, item.id)}
                                                    className="p-3 text-blue-600 hover:bg-blue-50 rounded-xl transition-colors"
                                                    title="复制分享链接"
                                                >
                                                    {copiedId === item.id ? <Check className="w-5 h-5" /> : <Copy className="w-5 h-5" />}
                                                </button>
                                            ) : (
                                                <button
                                                    onClick={() => handleGenerateShare(item.id)}
                                                    className="p-3 text-blue-600 hover:bg-blue-50 rounded-xl transition-colors"
                                                    title="生成分享链接"
                                                >
                                                    <Share2 className="w-5 h-5" />
                                                </button>
                                            )}

                                            <button
                                                onClick={() => handleDelete(item.id)}
                                                className="p-3 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition-colors"
                                                title="删除"
                                            >
                                                <Trash2 className="w-5 h-5" />
                                            </button>
                                        </>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
