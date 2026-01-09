"use client";

import React, { useState } from 'react';
import {
    Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer
} from 'recharts';
import {
    AlertCircle, CheckCircle2, ChevronDown, ChevronRight,
    Lightbulb, RotateCcw, Sparkles, ChevronLeft, Download,
    Quote, AlertTriangle
} from 'lucide-react';
import clsx from 'clsx';
import { EvaluationReport, DimensionScore, SubDimensionScore, IssueItem } from '@/lib/llm/types';
import { exportReportAsMarkdown } from '@/lib/markdown-exporter';
import { DIMENSIONS } from '@/lib/config';
import { MarkdownRenderer } from './MarkdownRenderer';

// 维度名称映射：英文 key -> 中文显示名称
// 直接使用 config.ts 中的定义
const getDimensionName = (key: string): string => {
    return DIMENSIONS[key]?.name || key;
};

// --- Helper Components ---

/**
 * 问题引用展示组件
 */
function IssueQuote({ issue }: { issue: IssueItem }) {
    const severityColors = {
        high: "bg-red-100 text-red-700 border-red-200",
        medium: "bg-amber-100 text-amber-700 border-amber-200",
        low: "bg-blue-100 text-blue-700 border-blue-200"
    };

    const severityLabels = {
        high: "严重",
        medium: "一般",
        low: "轻微"
    };

    return (
        <div className="bg-slate-50 rounded-lg p-3 text-sm border border-slate-100 space-y-2">
            <div className="flex items-start justify-between gap-2">
                <span className="font-medium text-slate-800 flex-1">{issue.description}</span>
                <span className={clsx("text-xs px-2 py-0.5 rounded-full border whitespace-nowrap", severityColors[issue.severity])}>
                    {severityLabels[issue.severity]}
                </span>
            </div>

            <div className="flex items-start gap-2 text-slate-500 text-xs bg-white p-2 rounded border border-slate-100 italic">
                <Quote className="w-3 h-3 flex-shrink-0 mt-0.5 text-slate-400" />
                <div className="space-y-1">
                    <p className="font-semibold not-italic text-slate-600">{issue.location}</p>
                    <p>"{issue.quote}"</p>
                </div>
            </div>

            <p className="text-xs text-slate-500">
                <span className="font-semibold">影响:</span> {issue.impact}
            </p>
        </div>
    );
}

/**
 * 子维度评分卡片
 */
function SubDimensionCard({ subScore }: { subScore: SubDimensionScore }) {
    const isPass = ["优秀", "良好", "合格"].includes(subScore.rating);
    const scoreColor = isPass ? "text-emerald-700" : "text-red-700";
    const bgColor = isPass ? "bg-emerald-50" : "bg-red-50";
    const borderColor = isPass ? "border-emerald-100" : "border-red-100";

    return (
        <div className={clsx("rounded-xl border p-4 space-y-3", isPass ? "bg-white border-slate-200" : "bg-red-50/30 border-red-100")}>
            <div className="flex items-center justify-between">
                <h4 className="font-bold text-slate-700">{subScore.sub_dimension}</h4>
                <div className="flex items-center gap-3">
                    <span className="text-xs font-semibold text-slate-400">
                        {subScore.score_range}
                    </span>
                    <span className={clsx("px-2 py-1 rounded-md text-xs font-bold border", bgColor, borderColor, scoreColor)}>
                        {subScore.rating} ({subScore.score}/{subScore.full_score})
                    </span>
                </div>
            </div>

            <div className="text-sm text-slate-600 leading-relaxed">
                <MarkdownRenderer content={subScore.judgment_basis} />
            </div>

            {/* 显示问题列表 */}
            {subScore.issues && subScore.issues.length > 0 && (
                <div className="space-y-2 mt-2">
                    {subScore.issues.map((issue, idx) => (
                        <IssueQuote key={idx} issue={issue} />
                    ))}
                </div>
            )}
            {/* 显示亮点列表 */}
            {subScore.highlights && subScore.highlights.length > 0 && (
                <div className="space-y-2 mt-2">
                    <p className="text-xs font-bold text-emerald-600 mb-1">亮点表现：</p>
                    {subScore.highlights.map((highlight, idx) => (
                        <div key={idx} className="bg-emerald-50 rounded-lg p-3 text-sm border border-emerald-100 space-y-1">
                            <p className="font-medium text-emerald-800">{highlight.description}</p>
                            <p className="text-xs text-emerald-600 italic">"{highlight.quote}"</p>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * 严重问题列表组件
 */
function HighSeverityIssuesList({ issues }: { issues: IssueItem[], dimensions: any[] }) {
    if (!issues || issues.length === 0) return null;

    return (
        <div className="bg-red-50 rounded-3xl p-8 border border-red-100 shadow-sm mt-8">
            <h3 className="text-xl font-bold text-red-800 mb-6 flex items-center gap-2">
                <AlertCircle className="w-6 h-6" />
                严重问题汇总 ({issues.length})
            </h3>
            <div className="space-y-4">
                {issues.map((issue, idx) => (
                    <div key={idx} className="bg-white rounded-xl p-4 border border-red-100 shadow-sm flex gap-4">
                        <div className="flex-shrink-0 mt-1">
                            <AlertTriangle className="w-5 h-5 text-red-500" />
                        </div>
                        <div className="space-y-2 flex-1">
                            <p className="font-bold text-slate-800">{issue.description}</p>
                            <div className="bg-slate-50 rounded-lg p-3 text-sm text-slate-600 italic border border-slate-100 flex gap-2">
                                <Quote className="w-4 h-4 text-slate-400 flex-shrink-0" />
                                <div>
                                    <span className="font-semibold not-italic block mb-1 text-slate-500">
                                        {issue.location || "未知位置"}
                                    </span>
                                    "{issue.quote}"
                                </div>
                            </div>
                            <p className="text-xs text-red-600 font-medium">
                                <span className="text-slate-500">影响：</span>
                                {issue.impact}
                            </p>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

// --- Main Component ---

interface ReportViewProps {
    report: EvaluationReport;
    onReset: () => void;
}

export function ReportView({ report, onReset }: ReportViewProps) {
    const [expandedDim, setExpandedDim] = useState<string | null>(null);

    // 只有当 dimensions 是数组时才进行处理（兼容旧数据结构）
    const dimensionsList = Array.isArray(report.dimensions)
        ? report.dimensions
        : Object.entries(report.dimensions as any).map(([key, value]: any) => ({
            dimension: DIMENSIONS[key]?.name || key,
            score: value.score,
            sub_scores: [], // 旧数据可能没有子维度
            analysis: value.comment,
            weight: 0.2, // 默认权重
            full_score: 20, // 默认满分
            isVeto: false,
            weighted_score: value.score
        }));

    const radarData = dimensionsList.map((dim) => ({
        subject: dim.dimension,
        A: (dim.score / dim.full_score) * 100, // 转换为百分比用于雷达图
        fullMark: 100,
    }));

    const getScoreColor = (score: number, fullScore: number) => {
        const ratio = score / fullScore;
        if (ratio >= 0.9) return 'text-emerald-600 bg-emerald-50 border-emerald-200';
        if (ratio >= 0.75) return 'text-blue-600 bg-blue-50 border-blue-200';
        if (ratio >= 0.6) return 'text-amber-600 bg-amber-50 border-amber-200';
        return 'text-red-600 bg-red-50 border-red-200';
    };

    const getScoreLabel = (score: number, fullScore: number) => {
        const ratio = score / fullScore;
        if (ratio >= 0.9) return '优秀';
        if (ratio >= 0.75) return '良好';
        if (ratio >= 0.6) return '合格';
        return '需改进';
    };

    // 统计所有问题
    const allIssues = dimensionsList.flatMap(d => {
        // 教学策略是加分项，其问题不计入严重问题汇总
        if (d.dimension === '教学策略') return [];
        return d.sub_scores?.flatMap(s => s.issues || []) || [];
    });

    // 筛选严重问题
    const highSeverityIssues = allIssues.filter(i => i.severity === 'high');

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
                                <span className={clsx("px-3 py-1 rounded-full text-sm font-bold border", getScoreColor(report.total_score, 100))}>
                                    {getScoreLabel(report.total_score, 100)}
                                </span>
                                <span className="text-slate-400 text-sm font-medium mt-1">/ 100 分</span>
                            </div>
                        </div>
                        {report.veto_reasons && report.veto_reasons.length > 0 && (
                            <div className="mt-4 bg-red-50 border border-red-100 rounded-lg p-3 text-red-700 text-sm font-bold flex items-center gap-2">
                                <AlertTriangle className="w-4 h-4" />
                                触发一票否决：{report.veto_reasons[0]}
                            </div>
                        )}
                    </div>

                    {/* Radar Chart */}
                    <div className="h-[380px] w-full relative -my-4 px-8">
                        <ResponsiveContainer width="100%" height="100%">
                            <RadarChart cx="50%" cy="50%" outerRadius="70%" data={radarData}>
                                <defs>
                                    <linearGradient id="radarFill" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#6366f1" stopOpacity={0.6} />
                                        <stop offset="95%" stopColor="#818cf8" stopOpacity={0.1} />
                                    </linearGradient>
                                </defs>
                                <PolarGrid gridType="polygon" stroke="#e2e8f0" />
                                <PolarAngleAxis
                                    dataKey="subject"
                                    tick={(props) => {
                                        const { x, y, cx, cy, payload } = props;
                                        // 垂直偏移逻辑
                                        const isTop = y < cy;
                                        const isBottom = y > cy;
                                        let dy = 5;
                                        if (isTop) dy = -5;     // 上方标签微调上移
                                        if (isBottom) dy = 15;  // 下方标签微调下移
                                        return (
                                            <g transform={`translate(${x},${y})`}>
                                                <text x={0} y={0} dy={dy} textAnchor="middle" fill="#475569" fontSize={13} fontWeight={600}>
                                                    {payload.value}
                                                </text>
                                            </g>
                                        );
                                    }}
                                />
                                <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />
                                <Radar
                                    name="Score"
                                    dataKey="A"
                                    stroke="#4f46e5"
                                    strokeWidth={3}
                                    fill="url(#radarFill)"
                                    fillOpacity={1}
                                />
                            </RadarChart>
                        </ResponsiveContainer>
                    </div>

                    {/* Quick Stats Summary */}
                    <div className="space-y-4">
                        <div className="bg-red-50 rounded-2xl p-5 border border-red-100 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <AlertCircle className="w-5 h-5 text-red-500" />
                                <span className="font-bold text-red-900">严重问题</span>
                            </div>
                            <span className="text-2xl font-black text-red-800">{highSeverityIssues.length}</span>
                        </div>
                        <div className="bg-indigo-50 rounded-2xl p-5 border border-indigo-100 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <Lightbulb className="w-5 h-5 text-indigo-500" />
                                <span className="font-bold text-indigo-900">改进点</span>
                            </div>
                            <span className="text-2xl font-black text-indigo-900">{allIssues.length - highSeverityIssues.length}</span>
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
                        维度详情与证据支撑
                    </h3>

                    <div className="space-y-4">
                        {dimensionsList.map((data, idx) => (
                            <div
                                key={idx}
                                className={clsx(
                                    "bg-white rounded-2xl border transition-all duration-300 overflow-hidden",
                                    expandedDim === data.dimension ? "shadow-lg border-indigo-200 ring-2 ring-indigo-50" : "border-slate-200 hover:border-indigo-200"
                                )}
                            >
                                <button
                                    onClick={() => setExpandedDim(expandedDim === data.dimension ? null : data.dimension)}
                                    className="w-full p-6 flex items-center justify-between hover:bg-slate-50 transition-colors"
                                >
                                    <div className="flex items-center gap-4">
                                        <div className={clsx(
                                            "w-12 h-12 rounded-xl flex items-center justify-center text-lg font-bold border",
                                            getScoreColor(data.score, data.full_score)
                                        )}>
                                            {data.score}
                                        </div>
                                        <div className="text-left">
                                            <h4 className="font-bold text-slate-700 text-lg">{data.dimension}</h4>
                                            <div className="flex items-center gap-2 mt-1">
                                                <div className="h-1.5 w-24 bg-slate-100 rounded-full overflow-hidden">
                                                    <div className="h-full bg-indigo-500 rounded-full"
                                                        style={{ width: `${(data.score / data.full_score) * 100}%` }} />
                                                </div>
                                                <span className="text-xs text-slate-400">
                                                    {((data.score / data.full_score) * 100).toFixed(0)}%
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        {data.isVeto && <span className="text-xs bg-red-100 text-red-600 px-2 py-1 rounded font-bold">一票否决项</span>}
                                        {expandedDim === data.dimension ? <ChevronDown className="text-indigo-500" /> : <ChevronRight className="text-slate-400" />}
                                    </div>
                                </button>

                                {expandedDim === data.dimension && (
                                    <div className="px-6 pb-6 pt-0 animate-in slide-in-from-top-2 space-y-4">
                                        {/* 子维度列表 */}
                                        <div className="grid gap-4">
                                            {data.sub_scores?.map((subScore, subIdx) => (
                                                <SubDimensionCard key={subIdx} subScore={subScore} />
                                            ))}
                                            {(!data.sub_scores || data.sub_scores.length === 0) && (
                                                <div className="bg-slate-50 p-4 rounded-xl text-slate-600">
                                                    {data.analysis}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>

                    {/* High Severity Issues Section */}
                    {highSeverityIssues.length > 0 && (
                        <HighSeverityIssuesList issues={highSeverityIssues} dimensions={dimensionsList} />
                    )}

                    {/* 改进建议汇总 - 替代原综合分析 */}
                    <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-3xl p-8 border border-amber-200 shadow-sm mt-8">
                        <h3 className="text-xl font-bold text-amber-900 mb-4 flex items-center gap-2">
                            <Lightbulb className="w-6 h-6" />
                            优先改进建议
                        </h3>
                        <div className="space-y-3">
                            {(() => {
                                // 根据严重问题生成改进建议
                                const suggestions: string[] = [];

                                // 按维度聚合问题
                                dimensionsList.forEach(dim => {
                                    if (dim.dimension === '教学策略') return; // 跳过加分项
                                    const dimHighIssues = dim.sub_scores?.flatMap(s =>
                                        (s.issues || []).filter(i => i.severity === 'high')
                                    ) || [];
                                    if (dimHighIssues.length > 0) {
                                        suggestions.push(`**${dim.dimension}**: ${dimHighIssues[0]?.description || '存在严重问题需改进'}`);
                                    }
                                });

                                // 添加一般性建议
                                if (suggestions.length === 0) {
                                    suggestions.push('🎉 未发现严重问题，继续保持！');
                                }

                                return suggestions.slice(0, 5).map((s, i) => (
                                    <div key={i} className="flex items-start gap-3 bg-white/60 rounded-xl p-3 border border-amber-100">
                                        <span className="flex-shrink-0 w-6 h-6 bg-amber-500 text-white rounded-full flex items-center justify-center text-sm font-bold">
                                            {i + 1}
                                        </span>
                                        <span className="text-amber-900 text-sm leading-relaxed">
                                            <MarkdownRenderer content={s} />
                                        </span>
                                    </div>
                                ));
                            })()}
                        </div>
                    </div>
                </div>

                {/* Right Col: Sticky Sidebar */}
                <div className="lg:col-span-4">
                    <div className="sticky top-6 space-y-5">

                        {/* 维度得分一览 + 快速跳转 */}
                        <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
                            <h4 className="font-bold text-slate-700 mb-3">维度得分一览</h4>
                            <div className="space-y-3">
                                {dimensionsList.map((dim, idx) => (
                                    <button
                                        key={idx}
                                        onClick={() => setExpandedDim(dim.dimension === expandedDim ? null : dim.dimension)}
                                        className={`w-full text-left p-3 rounded-xl border transition-all hover:bg-slate-50 ${expandedDim === dim.dimension
                                            ? 'border-indigo-300 bg-indigo-50/50'
                                            : 'border-slate-100'
                                            }`}
                                    >
                                        <div className="flex items-center justify-between mb-1.5">
                                            <span className="text-sm font-medium text-slate-700">{dim.dimension}</span>
                                            <span className={`text-sm font-bold ${(dim.score / dim.full_score) >= 0.8 ? 'text-emerald-600' :
                                                (dim.score / dim.full_score) >= 0.6 ? 'text-amber-600' : 'text-red-600'
                                                }`}>
                                                {dim.score}/{dim.full_score}
                                            </span>
                                        </div>
                                        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                            <div
                                                className={`h-full rounded-full transition-all ${(dim.score / dim.full_score) >= 0.8 ? 'bg-emerald-500' :
                                                    (dim.score / dim.full_score) >= 0.6 ? 'bg-amber-500' : 'bg-red-500'
                                                    }`}
                                                style={{ width: `${(dim.score / dim.full_score) * 100}%` }}
                                            />
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* 评分标准说明 */}
                        <div className="bg-blue-50/50 rounded-2xl p-5 border border-blue-100 text-sm text-blue-800 leading-relaxed">
                            <h4 className="font-bold flex items-center gap-2 mb-2">
                                <Sparkles className="w-4 h-4" />
                                关于新版评分标准
                            </h4>
                            <p>本次评测采用分数段限定版标准，包含5个一级维度和21个二级维度。</p>
                        </div>

                        {/* Action Buttons */}
                        <button
                            onClick={() => exportReportAsMarkdown(report)}
                            className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-bold shadow-lg shadow-indigo-200 hover:shadow-indigo-300 transition-all flex items-center justify-center gap-2 group"
                        >
                            <Download className="w-5 h-5 group-hover:translate-y-0.5 transition-transform duration-300" />
                            导出完整报告 (MD)
                        </button>

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
        </div>
    );
}
