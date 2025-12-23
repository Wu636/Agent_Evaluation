import React, { useMemo } from 'react';
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { AlertTriangle, CheckCircle, Info, BookOpen, MessageSquare, Activity, Shield, Sparkles } from 'lucide-react';
import clsx from 'clsx';

export function ReportView({ report, onReset }) {
    if (!report) return null;

    const chartData = useMemo(() => {
        return report.dimensions.map(dim => ({
            subject: dim.dimension,
            A: dim.score,
            fullMark: 100, // Normalized to 100 in logic or handled below
        }));
    }, [report]);

    // Helper to map icons to dimensions loosely based on keywords
    const getIconForDimension = (dimName) => {
        if (dimName.includes('目标')) return <BookOpen className="w-5 h-5" />;
        if (dimName.includes('策略')) return <Sparkles className="w-5 h-5" />;
        if (dimName.includes('一致性')) return <Activity className="w-5 h-5" />;
        if (dimName.includes('语言')) return <MessageSquare className="w-5 h-5" />;
        if (dimName.includes('幻觉')) return <Shield className="w-5 h-5" />;
        return <Info className="w-5 h-5" />;
    };

    const getScoreColor = (score) => {
        if (score >= 90) return 'text-green-600';
        if (score >= 75) return 'text-blue-600';
        if (score >= 60) return 'text-yellow-600';
        return 'text-red-600';
    };

    const getScoreBadge = (level) => {
        switch (level) {
            case '优秀': return 'bg-green-100 text-green-700 border-green-200';
            case '良好': return 'bg-blue-100 text-blue-700 border-blue-200';
            case '合格': return 'bg-yellow-100 text-yellow-700 border-yellow-200';
            default: return 'bg-red-100 text-red-700 border-red-200';
        }
    };

    return (
        <div className="w-full max-w-5xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">

            {/* Header Section */}
            <div className="relative bg-white rounded-3xl shadow-xl overflow-hidden border border-gray-100">
                <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500" />
                <div className="p-8 md:p-10 flex flex-col md:flex-row justify-between items-center gap-6">
                    <div>
                        <h1 className="text-3xl font-bold text-gray-900 mb-2">Evaluation Report</h1>
                        <p className="text-gray-500 flex items-center gap-2">
                            Task ID: <span className="font-mono bg-gray-100 px-2 py-0.5 rounded text-sm">{report.task_id}</span>
                        </p>
                    </div>

                    <div className="flex items-center gap-6">
                        <div className="text-center">
                            <p className="text-sm text-gray-400 uppercase tracking-wider font-semibold mb-1">Total Score</p>
                            <div className={clsx("text-5xl font-black tabular-nums tracking-tighter", getScoreColor(report.total_score))}>
                                {report.total_score.toFixed(1)}
                            </div>
                        </div>
                        <div className={clsx("px-6 py-2 rounded-full border-2 font-bold text-lg", getScoreBadge(report.final_level))}>
                            {report.final_level}
                        </div>
                    </div>
                </div>
            </div>

            {/* Main Analysis Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                {/* Radar Chart */}
                <div className="bg-white rounded-3xl shadow-lg border border-gray-100 p-6 lg:col-span-1 flex flex-col items-center justify-center min-h-[400px]">
                    <h3 className="text-lg font-semibold text-gray-800 mb-4 w-full text-center">Dimension Overview</h3>
                    <div className="w-full h-[300px]">
                        <ResponsiveContainer width="100%" height="100%">
                            <RadarChart cx="50%" cy="50%" outerRadius="80%" data={chartData}>
                                <PolarGrid stroke="#e5e7eb" />
                                <PolarAngleAxis dataKey="subject" tick={{ fill: '#6b7280', fontSize: 10 }} />
                                <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />
                                <Radar
                                    name="Score"
                                    dataKey="A"
                                    stroke="#8b5cf6"
                                    strokeWidth={3}
                                    fill="#8b5cf6"
                                    fillOpacity={0.2}
                                />
                                <Tooltip />
                            </RadarChart>
                        </ResponsiveContainer>
                    </div>
                </div>

                {/* Detailed Dimensions List */}
                <div className="lg:col-span-2 space-y-4">
                    {report.dimensions.map((dim, idx) => (
                        <div key={idx} className="group bg-white rounded-2xl shadow-sm border border-gray-100 hover:shadow-md transition-shadow overflow-hidden">
                            <div className="p-5 flex items-start gap-4">
                                <div className={clsx("p-3 rounded-xl flex-shrink-0 mt-1",
                                    dim.score >= 80 ? "bg-green-50 text-green-600" :
                                        dim.score >= 60 ? "bg-yellow-50 text-yellow-600" : "bg-red-50 text-red-600"
                                )}>
                                    {getIconForDimension(dim.dimension)}
                                </div>

                                <div className="flex-1 min-w-0">
                                    <div className="flex justify-between items-start mb-2">
                                        <h3 className="font-bold text-gray-800 text-lg">{dim.dimension}</h3>
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-medium text-gray-400">{dim.score.toFixed(1)}/100</span>
                                            <div className={clsx("w-2 h-2 rounded-full", dim.score >= 60 ? "bg-green-500" : "bg-red-500")} />
                                        </div>
                                    </div>

                                    <p className="text-gray-600 text-sm leading-relaxed mb-4">
                                        {dim.analysis}
                                    </p>

                                    {/* Collapsible details could go here, for now simpler view */}
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                                        {dim.issues.length > 0 && (
                                            <div className="bg-red-50/50 rounded-lg p-3">
                                                <p className="font-semibold text-red-700 mb-2 flex items-center gap-1">
                                                    <AlertTriangle className="w-3 h-3" /> Issues
                                                </p>
                                                <ul className="space-y-1">
                                                    {dim.issues.slice(0, 3).map((issue, i) => (
                                                        <li key={i} className="text-red-600/80 pl-2 border-l-2 border-red-200">{issue}</li>
                                                    ))}
                                                </ul>
                                            </div>
                                        )}
                                        {dim.suggestions.length > 0 && (
                                            <div className="bg-blue-50/50 rounded-lg p-3">
                                                <p className="font-semibold text-blue-700 mb-2 flex items-center gap-1">
                                                    <CheckCircle className="w-3 h-3" /> Suggestions
                                                </p>
                                                <ul className="space-y-1">
                                                    {dim.suggestions.slice(0, 3).map((sugg, i) => (
                                                        <li key={i} className="text-blue-600/80 pl-2 border-l-2 border-blue-200">{sugg}</li>
                                                    ))}
                                                </ul>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Footer / Reset */}
            <div className="flex justify-center pt-8">
                <button
                    onClick={onReset}
                    className="px-8 py-3 bg-white text-gray-700 font-semibold rounded-full shadow hover:shadow-lg border border-gray-200 transition-all hover:-translate-y-1 active:scale-95"
                >
                    Run New Evaluation
                </button>
            </div>
        </div>
    );
}
