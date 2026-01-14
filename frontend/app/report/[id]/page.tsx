'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ReportView } from '@/components/ReportView';
import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';

interface Evaluation {
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
    created_at: string;
}

export default function SharedReportPage() {
    const params = useParams();
    const id = params.id as string;

    const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const fetchEvaluation = async () => {
            try {
                const res = await fetch(`/api/evaluations/${id}`);
                if (!res.ok) {
                    const data = await res.json();
                    throw new Error(data.error || '获取评测失败');
                }
                const data = await res.json();
                setEvaluation(data.evaluation);
            } catch (err) {
                setError(err instanceof Error ? err.message : '加载失败');
            } finally {
                setLoading(false);
            }
        };

        if (id) {
            fetchEvaluation();
        }
    }, [id]);

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-slate-50">
                <div className="text-center">
                    <Loader2 className="w-10 h-10 text-indigo-600 animate-spin mx-auto mb-4" />
                    <p className="text-slate-600">加载评测报告...</p>
                </div>
            </div>
        );
    }

    if (error || !evaluation) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-slate-50">
                <div className="text-center">
                    <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                        <span className="text-3xl">❌</span>
                    </div>
                    <h1 className="text-xl font-bold text-slate-900 mb-2">无法访问此报告</h1>
                    <p className="text-slate-500 mb-6">{error || '报告不存在或已被删除'}</p>
                    <Link
                        href="/"
                        className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
                    >
                        <ArrowLeft className="w-4 h-4" />
                        返回首页
                    </Link>
                </div>
            </div>
        );
    }

    // 转换为 ReportView 需要的格式
    const report = {
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

    return (
        <div className="min-h-screen bg-slate-50">
            {/* Header */}
            <div className="bg-white border-b border-slate-200 sticky top-0 z-40">
                <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
                    <Link
                        href="/"
                        className="flex items-center gap-2 text-slate-600 hover:text-indigo-600 transition-colors"
                    >
                        <ArrowLeft className="w-4 h-4" />
                        <span className="text-sm font-medium">返回首页</span>
                    </Link>

                    <div className="text-center">
                        <p className="text-xs text-slate-400">分享的评测报告</p>
                        <p className="text-sm font-medium text-slate-700">
                            {evaluation.teacher_doc_name || '未知文档'} · {evaluation.created_at ? new Date(evaluation.created_at).toLocaleDateString('zh-CN') : '未知日期'}
                        </p>
                        <p className="text-xs text-slate-500 font-mono mt-1">
                            ID: {evaluation.id.substring(0, 8)}
                        </p>
                    </div>

                    <div className="w-24" /> {/* Spacer for centering */}
                </div>
            </div>

            {/* Report Content */}
            <div className="max-w-7xl mx-auto px-4 py-6">
                <ReportView
                    report={report}
                    onReset={() => window.history.back()}
                />
            </div>
        </div>
    );
}
