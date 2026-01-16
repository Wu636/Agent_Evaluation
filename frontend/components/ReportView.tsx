"use client";

import React, { useState, useMemo } from 'react';
import {
    Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer
} from 'recharts';
import { Share2, Download, AlertTriangle, CheckCircle2, Sliders, FileText, ChevronDown, ChevronRight, X, Copy, Check, Sparkles, RotateCcw, Lightbulb, AlertCircle, Quote } from 'lucide-react';
import clsx from 'clsx';
import { EvaluationReport, DimensionScore, IssueItem, SubDimensionScore } from '@/lib/llm/types';
import { DocumentViewer } from '@/components/DocumentViewer';
import { CommentSection } from './CommentSection'; // Correct Import
import { DIMENSIONS } from '@/lib/config';
import { MarkdownRenderer } from './MarkdownRenderer';
import { exportReportAsMarkdown } from '@/lib/markdown-exporter';

// 维度名称映射：英文 key -> 中文显示名称
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
        <div
            id={`sub-dim-${subScore.sub_dimension}`}
            className={clsx("rounded-xl border p-4 space-y-3", isPass ? "bg-white border-slate-200" : "bg-red-50/30 border-red-100")}
        >
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
 * 严重问题列表组件 - 按维度分组并可折叠
 */
function HighSeverityIssuesList({ issues, dimensions }: { issues: IssueItem[], dimensions: any[] }) {
    if (!issues || issues.length === 0) return null;

    // 按维度分组问题
    const issuesByDimension = React.useMemo(() => {
        // 直接遍历 dimensions 来聚合严重问题
        return dimensions.reduce((acc, dim) => {
            // 找出该维度下所有的严重问题
            const dimIssues: IssueItem[] = dim.sub_scores?.flatMap((s: any) => s.issues || []).filter((i: any) => i.severity === 'high') || [];

            // 教学策略不计入严重问题
            if (dim.dimension === '教学策略') return acc;

            if (dimIssues.length > 0) {
                acc[dim.dimension] = dimIssues;
            }
            return acc;
        }, {} as Record<string, IssueItem[]>);
    }, [dimensions]);

    // 默认展开所有有问题的维度
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(Object.keys(issuesByDimension)));

    const toggleGroup = (dimName: string) => {
        const newSet = new Set(expandedGroups);
        if (newSet.has(dimName)) {
            newSet.delete(dimName);
        } else {
            newSet.add(dimName);
        }
        setExpandedGroups(newSet);
    };

    if (Object.keys(issuesByDimension).length === 0) return null;

    return (
        <div className="bg-red-50 rounded-3xl p-6 md:p-8 border border-red-100 shadow-sm mt-8">
            <h3 className="text-xl font-bold text-red-800 mb-6 flex items-center gap-2">
                <AlertCircle className="w-6 h-6" />
                严重问题汇总 ({issues.length})
            </h3>

            <div className="space-y-4">
                {(Object.entries(issuesByDimension) as [string, IssueItem[]][]).map(([dimName, dimIssues]) => {
                    const isExpanded = expandedGroups.has(dimName);
                    return (
                        <div key={dimName} className="bg-white rounded-xl border border-red-100 overflow-hidden shadow-sm">
                            <button
                                onClick={() => toggleGroup(dimName)}
                                className="w-full flex items-center justify-between p-4 bg-red-50/30 hover:bg-red-50/80 transition-colors"
                            >
                                <div className="flex items-center gap-2">
                                    <ChevronRight className={`w-5 h-5 text-red-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                                    <span className="font-bold text-slate-800">{dimName}</span>
                                    <span className="bg-red-100 text-red-700 text-xs px-2 py-0.5 rounded-full font-bold">
                                        {dimIssues.length}个问题
                                    </span>
                                </div>
                            </button>

                            {isExpanded && (
                                <div className="p-4 space-y-3 pt-0 mt-2">
                                    {dimIssues.map((issue, idx) => (
                                        <div key={idx} className="flex gap-3 text-sm text-slate-700 ml-2">
                                            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                                            <div className="space-y-1">
                                                <p className="font-medium">{issue.description}</p>
                                                {issue.quote && (
                                                    <div className="bg-slate-50 rounded p-2 text-xs text-slate-500 italic border border-slate-100 mt-1">
                                                        "{issue.quote}"
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// --- Main Component ---

interface ReportViewProps {
    report: EvaluationReport;
    onReset: () => void;
    isPublic?: boolean;
}

export function ReportView({ report, onReset, isPublic = false }: ReportViewProps) {
    const [expandedDim, setExpandedDim] = useState<string | null>(null);
    const [sidebarExpandedDims, setSidebarExpandedDims] = useState<Set<string>>(new Set());

    // Document Viewer State
    const [viewDoc, setViewDoc] = useState<{ isOpen: boolean; title: string; content: string; type: 'text' | 'json' } | null>(null);

    const handleViewTeacherDoc = () => {
        if (report.teacher_doc_content) {
            setViewDoc({
                isOpen: true,
                title: report.teacher_doc_name || '教师指导手册',
                content: report.teacher_doc_content,
                type: 'text'
            });
        }
    };

    const handleViewDialogue = () => {
        if (report.dialogue_doc_content) {
            setViewDoc({
                isOpen: true,
                title: report.dialogue_doc_name || '对话记录',
                content: report.dialogue_doc_content,
                // 如果内容看起来像JSON，就用json模式
                type: report.dialogue_doc_content.trim().startsWith('{') ? 'json' : 'text'
            });
        }
    };

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

    // Calculate dynamic full score
    const totalFullScore = dimensionsList.reduce((sum, dim) => sum + dim.full_score, 0);

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
        <div className="w-full space-y-6 animate-in slide-in-from-bottom-8 duration-700">

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
                                <span className={clsx("px-3 py-1 rounded-full text-sm font-bold border", getScoreColor(report.total_score, totalFullScore))}>
                                    {getScoreLabel(report.total_score, totalFullScore)}
                                </span>
                                <span className="text-slate-400 text-sm font-medium mt-1">/ {totalFullScore} 分</span>
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
                                id={`dim-card-${data.dimension}`}
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

                        {/* 子维度得分一览 - 可折叠列表 */}
                        <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
                            <h4 className="font-bold text-slate-700 mb-3">子维度得分一览</h4>
                            <div className="space-y-2">
                                {dimensionsList.map((dim, idx) => {
                                    const isExpanded = sidebarExpandedDims.has(dim.dimension);
                                    const toggleExpand = () => {
                                        const newSet = new Set(sidebarExpandedDims);
                                        if (isExpanded) {
                                            newSet.delete(dim.dimension);
                                        } else {
                                            newSet.add(dim.dimension);
                                        }
                                        setSidebarExpandedDims(newSet);
                                    };

                                    return (
                                        <div key={idx} className="border border-slate-100 rounded-xl overflow-hidden">
                                            {/* 主维度标题 */}
                                            <button
                                                onClick={toggleExpand}
                                                className={`w-full text-left px-3 py-2.5 flex items-center justify-between transition-colors ${isExpanded ? 'bg-slate-50' : 'hover:bg-slate-50'
                                                    }`}
                                            >
                                                <div className="flex items-center gap-2">
                                                    <ChevronRight className={`w-4 h-4 text-slate-400 transition-transform ${isExpanded ? 'rotate-90' : ''
                                                        }`} />
                                                    <span className="text-sm font-medium text-slate-700">{dim.dimension}</span>
                                                </div>
                                                <span className={`text-sm font-bold ${(dim.score / dim.full_score) >= 0.9 ? 'text-emerald-600' :
                                                    (dim.score / dim.full_score) >= 0.75 ? 'text-blue-600' :
                                                        (dim.score / dim.full_score) >= 0.6 ? 'text-amber-600' : 'text-red-600'
                                                    }`}>
                                                    {dim.score}/{dim.full_score}
                                                </span>
                                            </button>

                                            {/* 子维度列表 */}
                                            {isExpanded && dim.sub_scores && dim.sub_scores.length > 0 && (
                                                <div className="px-3 pb-2 pt-1 bg-slate-50/50 border-t border-slate-100">
                                                    {dim.sub_scores.map((sub, subIdx) => {
                                                        const subRatio = sub.score / sub.full_score;
                                                        return (
                                                            <button
                                                                key={subIdx}
                                                                onClick={() => {
                                                                    // 1. 展开左侧对应的主维度
                                                                    setExpandedDim(dim.dimension);
                                                                    // 2. 滚动到对应位置
                                                                    setTimeout(() => {
                                                                        // 优先尝试滚动到子维度
                                                                        const subEl = document.getElementById(`sub-dim-${sub.sub_dimension}`);
                                                                        const mainEl = document.getElementById(`dim-card-${dim.dimension}`);
                                                                        const targetEl = subEl || mainEl;

                                                                        if (targetEl) {
                                                                            // 计算 sticky header 的偏移量 (假设顶部有导航栏或 sticky sidebar 的间距)
                                                                            const offset = 80;
                                                                            const elementPosition = targetEl.getBoundingClientRect().top;
                                                                            const offsetPosition = elementPosition + window.pageYOffset - offset;

                                                                            window.scrollTo({
                                                                                top: offsetPosition,
                                                                                behavior: "smooth"
                                                                            });
                                                                        }
                                                                    }, 150); // 稍微增加延迟以确保展开动画完成或DOM已渲染
                                                                }}
                                                                className="w-full text-left py-1.5 pl-6 pr-2 flex items-center justify-between hover:bg-white rounded-lg transition-colors group"
                                                            >
                                                                <span className="text-xs text-slate-500 group-hover:text-slate-700 truncate">
                                                                    {sub.sub_dimension}
                                                                </span>
                                                                <span className={`text-xs font-semibold ml-2 flex-shrink-0 ${subRatio >= 0.9 ? 'text-emerald-600' :
                                                                    subRatio >= 0.75 ? 'text-blue-600' :
                                                                        subRatio >= 0.6 ? 'text-amber-600' : 'text-red-600'
                                                                    }`}>
                                                                    {sub.score}/{sub.full_score}
                                                                </span>
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>



                        {/* Action Buttons */}

                        {/* Action Buttons */}
                        <div className="space-y-3">
                            <button
                                onClick={() => exportReportAsMarkdown(report)}
                                className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-bold shadow-lg shadow-indigo-200 hover:shadow-indigo-300 transition-all flex items-center justify-center gap-2 group"
                            >
                                <Download className="w-5 h-5 group-hover:translate-y-0.5 transition-transform duration-300" />
                                导出完整报告 (MD)
                            </button>

                            {/* View Source Documents Buttons */}
                            {(report.teacher_doc_content || report.dialogue_doc_content) && (
                                <div className="grid grid-cols-2 gap-3">
                                    {report.teacher_doc_content && (
                                        <button
                                            onClick={handleViewTeacherDoc}
                                            className="py-3 bg-white border border-slate-200 hover:border-indigo-300 hover:text-indigo-600 text-slate-600 rounded-xl font-medium shadow-sm hover:shadow transition-all flex items-center justify-center gap-2"
                                        >
                                            <FileText className="w-4 h-4" />
                                            教师手册
                                        </button>
                                    )}
                                    {report.dialogue_doc_content && (
                                        <button
                                            onClick={handleViewDialogue}
                                            className="py-3 bg-white border border-slate-200 hover:border-indigo-300 hover:text-indigo-600 text-slate-600 rounded-xl font-medium shadow-sm hover:shadow transition-all flex items-center justify-center gap-2"
                                        >
                                            <FileText className="w-4 h-4" />
                                            对话记录
                                        </button>
                                    )}
                                </div>
                            )}

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

            {/* Document Viewer Modal */}
            {viewDoc && (
                <DocumentViewer
                    isOpen={viewDoc.isOpen}
                    onClose={() => setViewDoc(null)}
                    title={viewDoc.title}
                    content={viewDoc.content}
                    type={viewDoc.type}
                />
            )}

            {/* 评论区 - 仅当有有效ID时显示 */}
            {report.task_id && (
                <CommentSection
                    evaluationId={report.task_id}
                    isPublic={isPublic}
                />
            )}
        </div>
    );
}
