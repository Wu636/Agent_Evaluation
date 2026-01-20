'use client';

import { useEffect, useState } from 'react';
import { Search, Clock, Star, ArrowLeft, Loader2, Bookmark } from 'lucide-react';
import Link from 'next/link';
import { SaveReportButton } from '@/components/SaveReportButton';

interface SavedEvaluation {
    id: string;
    teacher_doc_name: string;
    dialogue_record_name: string;
    total_score: number;
    final_level: string;
    model_used: string;
    created_at: string; // Evaluation creation time
    saved_at: string;   // Bookmark time
    share_token: string | null;
}

export default function SavedReportsPage() {
    const [savedReports, setSavedReports] = useState<SavedEvaluation[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');

    useEffect(() => {
        const fetchSavedReports = async () => {
            try {
                const res = await fetch('/api/evaluations/saved');
                if (res.ok) {
                    const data = await res.json();
                    setSavedReports(data.savedReports || []);
                }
            } catch (err) {
                console.error('获取收藏列表失败:', err);
            } finally {
                setLoading(false);
            }
        };

        fetchSavedReports();
    }, []);

    const filteredReports = savedReports.filter(e =>
        e.teacher_doc_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        e.model_used.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const getScoreColor = (score: number) => {
        if (score >= 90) return 'text-emerald-600 bg-emerald-50';
        if (score >= 75) return 'text-blue-600 bg-blue-50';
        if (score >= 60) return 'text-amber-600 bg-amber-50';
        return 'text-red-600 bg-red-50';
    };

    return (
        <div className="min-h-screen bg-slate-50">
            {/* Header */}
            <div className="bg-white border-b border-slate-200 sticky top-0 z-40">
                <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
                    <Link
                        href="/"
                        className="flex items-center gap-2 text-slate-600 hover:text-indigo-600 transition-colors"
                    >
                        <ArrowLeft className="w-4 h-4" />
                        <span className="text-sm font-medium">返回首页</span>
                    </Link>

                    <h1 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                        <Bookmark className="w-5 h-5 text-yellow-500" />
                        我的收藏
                    </h1>

                    <div className="w-24" />
                </div>
            </div>

            {/* Search */}
            <div className="max-w-6xl mx-auto px-4 py-6">
                <div className="relative mb-8">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                    <input
                        type="text"
                        placeholder="搜索收藏的报告..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-12 pr-4 py-3 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                    />
                </div>

                {/* Results */}
                {loading ? (
                    <div className="text-center py-20">
                        <Loader2 className="w-10 h-10 text-indigo-600 animate-spin mx-auto mb-4" />
                        <p className="text-slate-500">加载中...</p>
                    </div>
                ) : filteredReports.length === 0 ? (
                    <div className="text-center py-20 bg-white rounded-2xl border border-slate-200">
                        <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
                            <Bookmark className="w-8 h-8 text-slate-400" />
                        </div>
                        <h3 className="text-lg font-medium text-slate-900 mb-2">
                            {searchQuery ? '没有找到匹配的收藏' : '暂无收藏'}
                        </h3>
                        <p className="text-slate-500">
                            {searchQuery ? '试试其他关键词' : '去探索广场或评测记录中收藏你喜欢的报告吧'}
                        </p>
                        {!searchQuery && (
                            <Link href="/explore" className="inline-block mt-4 text-indigo-600 font-medium hover:underline">
                                去探索广场看看 &rarr;
                            </Link>
                        )}
                    </div>
                ) : (
                    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {filteredReports.map((evaluation) => (
                            <div
                                key={evaluation.id}
                                className="bg-white rounded-xl border border-slate-200 hover:shadow-lg hover:border-indigo-200 transition-all group relative overflow-hidden"
                            >
                                <div className="absolute top-4 right-4 z-10">
                                    <SaveReportButton
                                        evaluationId={evaluation.id}
                                        initialIsSaved={true}
                                        className="bg-white/80 backdrop-blur shadow-sm border border-slate-200 hover:border-indigo-300"
                                    />
                                </div>

                                <Link
                                    href={`/report/${evaluation.share_token || evaluation.id}`}
                                    className="block p-5 h-full"
                                >
                                    <div className="flex items-start justify-between mb-3 pr-8">
                                        <div className="flex-1 min-w-0">
                                            <h3 className="font-medium text-slate-900 truncate group-hover:text-indigo-600 transition-colors">
                                                {evaluation.teacher_doc_name}
                                            </h3>
                                            <p className="text-xs text-slate-500 mt-1">
                                                {evaluation.dialogue_record_name}
                                            </p>
                                        </div>
                                        <div className={`px-2.5 py-1 rounded-lg text-sm font-bold ${getScoreColor(evaluation.total_score)}`}>
                                            {evaluation.total_score.toFixed(0)}
                                        </div>
                                    </div>

                                    <div className="space-y-2">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-3 text-xs text-slate-500">
                                                <div className="flex items-center gap-1">
                                                    <Clock className="w-3.5 h-3.5" />
                                                    {new Date(evaluation.created_at).toLocaleDateString('zh-CN')}
                                                </div>
                                                <div className="flex items-center gap-1 px-2 py-0.5 bg-yellow-50 rounded text-yellow-700 font-mono text-xs">
                                                    收藏于 {new Date(evaluation.saved_at).toLocaleDateString('zh-CN')}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex justify-end">
                                            <div className="px-2 py-0.5 bg-slate-100 rounded text-slate-600 text-xs">
                                                {evaluation.model_used}
                                            </div>
                                        </div>
                                    </div>
                                </Link>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
