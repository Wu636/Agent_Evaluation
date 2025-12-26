"use client";

import React, { useState } from 'react';
import {
    Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer
} from 'recharts';
import {
    AlertCircle, CheckCircle2, ChevronDown, ChevronRight,
    Lightbulb, RotateCcw, Download, Sparkles, ChevronLeft
} from 'lucide-react';
import clsx from 'clsx';
import { EvaluationReport } from '@/lib/api';

// 维度名称映射：英文 key -> 中文显示名称
const DIMENSION_NAMES: Record<string, string> = {
    teaching_goal_completion: '目标达成度',
    teaching_strategy: '策略引导力',
    workflow_consistency: '流程遵循度',
    interaction_experience: '交互体验感',
    hallucination_control: '幻觉控制力',
    robustness: '异常处理力',
};

// 获取维度中文名称
const getDimensionName = (key: string): string => {
    return DIMENSION_NAMES[key] || key;
};

// --- Helper Functions & Components ---

/**
 * 分组解析函数：将 "【维度】内容" 格式的字符串数组，
 * 解析为 { "维度": ["内容1", "内容2"], "其他": [...] }
 */
function groupItemsByDimension(items: string[]): Record<string, string[]> {
    const groups: Record<string, string[]> = {};
    const defaultKey = '通用';

    items.forEach(item => {
        // 尝试匹配 【维度】内容
        // 也可以适应带有优先级的旧格式，因为后端已经清理过格式了，这里再做一次防御
        const match = item.match(/^【(.*?)】(.*)/);
        if (match) {
            const dimName = match[1].trim();
            const content = match[2].trim();
            if (!groups[dimName]) {
                groups[dimName] = [];
            }
            if (content) {
                groups[dimName].push(content);
            }
        } else {
            if (!groups[defaultKey]) {
                groups[defaultKey] = [];
            }
            groups[defaultKey].push(item);
        }
    });

    return groups;
}

/**
 * 分页卡片组件
 */
interface PagedCardViewProps {
    title: string;
    icon: React.ReactNode;
    items: string[];
    colorTheme: 'red' | 'emerald';
}

function PagedCardView({ title, icon, items, colorTheme }: PagedCardViewProps) {
    const [currentIndex, setCurrentIndex] = useState(0);

    // 分组数据
    const grouped = groupItemsByDimension(items);
    const dimensions = Object.keys(grouped);

    if (dimensions.length === 0) {
        return (
            <div className={clsx(
                "rounded-3xl border shadow-sm overflow-hidden",
                colorTheme === 'red' ? "border-red-100 bg-white" : "border-emerald-100 bg-white"
            )}>
                <div className={clsx(
                    "p-4 border-b flex items-center gap-3",
                    colorTheme === 'red' ? "bg-red-50 border-red-100" : "bg-emerald-50 border-emerald-100"
                )}>
                    {icon}
                    <h3 className={clsx("font-bold", colorTheme === 'red' ? "text-red-900" : "text-emerald-900")}>
                        {title}
                    </h3>
                </div>
                <div className="p-8 text-center text-slate-400 text-sm">
                    暂无相关内容
                </div>
            </div>
        );
    }

    // 当前显示的维度
    const currentDim = dimensions[currentIndex];
    const currentItems = grouped[currentDim] || [];

    const handlePrev = () => {
        setCurrentIndex(prev => (prev === 0 ? dimensions.length - 1 : prev - 1));
    };

    const handleNext = () => {
        setCurrentIndex(prev => (prev === dimensions.length - 1 ? 0 : prev + 1));
    };

    const isRed = colorTheme === 'red';

    return (
        <div className={clsx(
            "rounded-3xl border shadow-sm overflow-hidden flex flex-col h-[400px]", // 固定高度以保持对齐
            isRed ? "border-red-100 bg-white" : "border-emerald-100 bg-white"
        )}>
            {/* Header */}
            <div className={clsx(
                "p-4 border-b flex items-center justify-between flex-shrink-0",
                isRed ? "bg-red-50 border-red-100" : "bg-emerald-50 border-emerald-100"
            )}>
                <div className="flex items-center gap-3">
                    {icon}
                    <h3 className={clsx("font-bold", isRed ? "text-red-900" : "text-emerald-900")}>
                        {title}
                    </h3>
                </div>
                <div className="flex items-center gap-2">
                    <span className={clsx("text-xs font-bold px-2 py-1 rounded-full", isRed ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700")}>
                        {currentIndex + 1} / {dimensions.length}
                    </span>
                    <div className="flex gap-1">
                        <button
                            onClick={handlePrev}
                            className={clsx("p-1 rounded-full transition-colors", isRed ? "hover:bg-red-100 text-red-400 hover:text-red-700" : "hover:bg-emerald-100 text-emerald-400 hover:text-emerald-700")}
                        >
                            <ChevronLeft className="w-5 h-5" />
                        </button>
                        <button
                            onClick={handleNext}
                            className={clsx("p-1 rounded-full transition-colors", isRed ? "hover:bg-red-100 text-red-400 hover:text-red-700" : "hover:bg-emerald-100 text-emerald-400 hover:text-emerald-700")}
                        >
                            <ChevronRight className="w-5 h-5" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                <div className="mb-3">
                    <span className={clsx(
                        "inline-block px-3 py-1 rounded-lg text-xs font-bold mb-2",
                        isRed ? "bg-red-50 text-red-600 border border-red-100" : "bg-emerald-50 text-emerald-600 border border-emerald-100"
                    )}>
                        {getDimensionName(currentDim)}
                    </span>
                </div>
                <div className="space-y-3">
                    {currentItems.map((item, idx) => (
                        <div key={idx} className={clsx(
                            "flex gap-3 text-slate-600 text-sm p-3 rounded-xl border transition-all",
                            isRed
                                ? "bg-red-50/30 border-red-50 hover:border-red-100 hover:shadow-sm"
                                : "bg-emerald-50/30 border-emerald-50 hover:border-emerald-100 hover:shadow-sm"
                        )}>
                            <span className={clsx(
                                "flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold mt-0.5",
                                isRed ? "bg-red-100 text-red-600" : "bg-emerald-100 text-emerald-600"
                            )}>
                                {isRed ? idx + 1 : <CheckCircle2 className="w-3.5 h-3.5" />}
                            </span>
                            <span className="leading-relaxed">{item}</span>
                        </div>
                    ))}
                </div>
            </div>

            {/* Dots Indicator */}
            <div className="p-3 flex justify-center gap-1.5 flex-shrink-0">
                {dimensions.map((_, idx) => (
                    <button
                        key={idx}
                        onClick={() => setCurrentIndex(idx)}
                        className={clsx(
                            "w-1.5 h-1.5 rounded-full transition-all",
                            idx === currentIndex
                                ? (isRed ? "bg-red-400 w-3" : "bg-emerald-400 w-3")
                                : (isRed ? "bg-red-100" : "bg-emerald-100")
                        )}
                    />
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

    const radarData = Object.entries(report.dimensions).map(([key, value]) => ({
        subject: getDimensionName(key), // 使用中文名称
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
        if (score >= 90) return '优秀';
        if (score >= 75) return '良好';
        if (score >= 60) return '合格';
        return '需改进';
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
                                                <text
                                                    x={0}
                                                    y={0}
                                                    dy={dy}
                                                    textAnchor="middle"
                                                    fill="#475569"
                                                    fontSize={13}
                                                    fontWeight={600}
                                                >
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

                    {/* Quick Stats Summary (Count Only) */}
                    <div className="space-y-4">
                        <div className="bg-slate-50 rounded-2xl p-5 border border-slate-100 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <AlertCircle className="w-5 h-5 text-amber-500" />
                                <span className="font-bold text-slate-700">发现的问题</span>
                            </div>
                            <span className="text-2xl font-black text-slate-800">{report.issues?.length || 0}</span>
                        </div>
                        <div className="bg-indigo-50 rounded-2xl p-5 border border-indigo-100 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <Lightbulb className="w-5 h-5 text-indigo-500" />
                                <span className="font-bold text-indigo-900">改进建议</span>
                            </div>
                            <span className="text-2xl font-black text-indigo-900">{report.suggestions?.length || 0}</span>
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
                                            <h4 className="font-bold text-slate-700 text-lg">{getDimensionName(dim)}</h4>
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

                {/* Right Col: Action Items (Paged Cards) */}
                <div className="lg:col-span-4 space-y-8">

                    {/* Issues Card */}
                    <PagedCardView
                        title="关键问题"
                        icon={<AlertCircle className="w-5 h-5 text-red-500" />}
                        items={report.issues || []}
                        colorTheme="red"
                    />

                    {/* Suggestions Card */}
                    <PagedCardView
                        title="优化建议"
                        icon={<Lightbulb className="w-5 h-5 text-emerald-600" />}
                        items={report.suggestions || []}
                        colorTheme="emerald"
                    />

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
