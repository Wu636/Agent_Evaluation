"use client";

import React, { useState } from 'react';
import {
    Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer
} from 'recharts';
import {
    AlertCircle, CheckCircle2, ChevronDown, ChevronRight,
    Lightbulb, RotateCcw, Download, Sparkles
} from 'lucide-react';
import clsx from 'clsx';
import { EvaluationReport } from '@/lib/api';

interface ReportViewProps {
    report: EvaluationReport;
    onReset: () => void;
}

export function ReportView({ report, onReset }: ReportViewProps) {
    const [expandedDim, setExpandedDim] = useState<string | null>(null);

    const radarData = Object.entries(report.dimensions).map(([key, value]) => ({
        subject: key,
        A: value.score,
        fullMark: 100,
    }));

    const getScoreColor = (score: number) => {
        if (score >= 90) return 'text-emerald-600 bg-emerald-50 border-emerald-200';
        if (score >= 75) return 'text-blue-600 bg-blue-50 border-blue-200';
        if (score >= 60) return 'text-amber-600 bg-amber-50 border-amber-200';
        return 'text-red-600 bg-red-50 border-red-200';
    };

    const getScoreLabel = (score: number) => {
        if (score >= 90) return 'Excellent';
        if (score >= 75) return 'Good';
        if (score >= 60) return 'Fair';
        return 'Needs Improvement';
    };

    return (
        <div className="w-full space-y-8 animate-in slide-in-from-bottom-8 duration-700">

            {/* Header / Score Card */}
            <div className="bg-white rounded-[2rem] shadow-xl border border-slate-100 overflow-hidden relative">
                <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500" />

                <div className="p-8 md:p-10 grid lg:grid-cols-3 gap-10 items-center">

                    {/* Total Score */}
                    <div className="text-center lg:text-left space-y-2">
                        <h2 className="text-slate-500 font-medium tracking-wide uppercase text-sm">整体评估表现</h2>
                        <div className="flex items-baseline justify-center lg:justify-start gap-4">
                            <span className="text-7xl lg:text-8xl font-black text-slate-800 tracking-tighter">
                                {report.total_score.toFixed(0)}
                            </span>
                            <div className="flex flex-col items-start">
                                <span className={clsx("px-3 py-1 rounded-full text-sm font-bold border", getScoreColor(report.total_score))}>
                                    {getScoreLabel(report.total_score)}
                                </span>
                                <span className="text-slate-400 text-sm font-medium mt-1">/ 100 分</span>
                            </div>
                        </div>
                    </div>

                    {/* Radar Chart */}
                    <div className="h-[300px] w-full relative">
                        <ResponsiveContainer width="100%" height="100%">
                            <RadarChart cx="50%" cy="50%" outerRadius="70%" data={radarData}>
                                <PolarGrid stroke="#e2e8f0" strokeDasharray="3 3" />
                                <PolarAngleAxis dataKey="subject" tick={{ fill: '#64748b', fontSize: 12, fontWeight: 600 }} />
                                <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />
                                <Radar
                                    name="Score"
                                    dataKey="A"
                                    stroke="#4f46e5"
                                    strokeWidth={3}
                                    fill="#6366f1"
                                    fillOpacity={0.2}
                                />
                            </RadarChart>
                        </ResponsiveContainer>
                    </div>

                    {/* Quick Stats */}
                    <div className="space-y-4">
                        <div className="bg-slate-50 rounded-2xl p-5 border border-slate-100">
                            <div className="flex items-center gap-3 mb-2">
                                <AlertCircle className="w-5 h-5 text-amber-500" />
                                <span className="font-bold text-slate-700">发现的问题</span>
                            </div>
                            <span className="text-3xl font-black text-slate-800">{report.issues?.length || 0}</span>
                        </div>
                        <div className="bg-indigo-50 rounded-2xl p-5 border border-indigo-100">
                            <div className="flex items-center gap-3 mb-2">
                                <Lightbulb className="w-5 h-5 text-indigo-500" />
                                <span className="font-bold text-indigo-900">改进建议</span>
                            </div>
                            <span className="text-3xl font-black text-indigo-900">{report.suggestions?.length || 0}</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Detailed Analysis Grid */}
            <div className="grid lg:grid-cols-12 gap-8">

                {/* Left Col: Dimensions */}
                <div className="lg:col-span-8 space-y-6">
                    <h3 className="text-xl font-bold text-slate-800 px-2 flex items-center gap-2">
                        <Sparkles className="w-5 h-5 text-indigo-500" />
                        维度详情
                    </h3>

                    <div className="space-y-4">
                        {Object.entries(report.dimensions).map(([dim, data]) => (
                            <div
                                key={dim}
                                className={clsx(
                                    "bg-white rounded-2xl border transition-all duration-300 overflow-hidden",
                                    expandedDim === dim ? "shadow-lg border-indigo-200 ring-2 ring-indigo-50" : "border-slate-200 hover:border-indigo-200"
                                )}
                            >
                                <button
                                    onClick={() => setExpandedDim(expandedDim === dim ? null : dim)}
                                    className="w-full p-6 flex items-center justify-between hover:bg-slate-50 transition-colors"
                                >
                                    <div className="flex items-center gap-4">
                                        <div className={clsx(
                                            "w-12 h-12 rounded-xl flex items-center justify-center text-lg font-bold border",
                                            getScoreColor(data.score)
                                        )}>
                                            {data.score}
                                        </div>
                                        <div className="text-left">
                                            <h4 className="font-bold text-slate-700 text-lg">{dim}</h4>
                                            <div className="flex items-center gap-2 mt-1">
                                                <div className="h-1.5 w-24 bg-slate-100 rounded-full overflow-hidden">
                                                    <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${data.score}%` }} />
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    {expandedDim === dim ? <ChevronDown className="text-indigo-500" /> : <ChevronRight className="text-slate-400" />}
                                </button>

                                {expandedDim === dim && (
                                    <div className="px-6 pb-6 pt-0 animate-in slide-in-from-top-2">
                                        <div className="bg-slate-50 p-4 rounded-xl text-slate-600 leading-relaxed border border-slate-100">
                                            {data.comment}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>

                    <div className="bg-white rounded-3xl p-8 border border-slate-200 shadow-sm mt-8">
                        <h3 className="text-xl font-bold text-slate-800 mb-4">详细分析</h3>
                        <p className="text-slate-600 leading-8 whitespace-pre-wrap">{report.analysis}</p>
                    </div>
                </div>

                {/* Right Col: Action Items */}
                <div className="lg:col-span-4 space-y-8">

                    {/* Issues */}
                    <div className="bg-white rounded-3xl border border-red-100 shadow-sm overflow-hidden">
                        <div className="bg-red-50 p-4 border-b border-red-100 flex items-center gap-3">
                            <AlertCircle className="w-5 h-5 text-red-500" />
                            <h3 className="font-bold text-red-900">关键问题</h3>
                        </div>
                        <div className="p-4 space-y-3">
                            {(report.issues || []).map((issue, idx) => (
                                <div key={idx} className="flex gap-3 text-slate-600 text-sm p-3 bg-white rounded-xl border border-slate-100 hover:border-red-100 hover:shadow-sm transition-all">
                                    <span className="flex-shrink-0 w-6 h-6 bg-red-100 text-red-600 rounded-full flex items-center justify-center text-xs font-bold">
                                        {idx + 1}
                                    </span>
                                    {issue}
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Suggestions */}
                    <div className="bg-white rounded-3xl border border-emerald-100 shadow-sm overflow-hidden">
                        <div className="bg-emerald-50 p-4 border-b border-emerald-100 flex items-center gap-3">
                            <Lightbulb className="w-5 h-5 text-emerald-600" />
                            <h3 className="font-bold text-emerald-900">优化建议</h3>
                        </div>
                        <div className="p-4 space-y-3">
                            {(report.suggestions || []).map((suggestion, idx) => (
                                <div key={idx} className="flex gap-3 text-slate-600 text-sm p-3 bg-white rounded-xl border border-slate-100 hover:border-emerald-100 hover:shadow-sm transition-all">
                                    <CheckCircle2 className="flex-shrink-0 w-5 h-5 text-emerald-500 mt-0.5" />
                                    {suggestion}
                                </div>
                            ))}
                        </div>
                    </div>

                    <button
                        onClick={onReset}
                        className="w-full py-4 bg-slate-900 hover:bg-indigo-600 text-white rounded-2xl font-bold shadow-lg shadow-slate-200 hover:shadow-indigo-200 transition-all flex items-center justify-center gap-2 group"
                    >
                        <RotateCcw className="w-5 h-5 group-hover:-rotate-180 transition-transform duration-500" />
                        开始新的评估
                    </button>

                </div>
            </div>
        </div>
    );
}
