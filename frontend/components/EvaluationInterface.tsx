"use client";

import React, { useState } from 'react';
import { Sparkles, Loader2, History, Settings } from 'lucide-react';
import { FileUpload } from '@/components/FileUpload';
import { ReportView } from '@/components/ReportView';
import { SettingsModal } from '@/components/SettingsModal';
import { HistoryView } from '@/components/HistoryView';
import { evaluateFilesStream, EvaluationReport, StreamProgress } from '@/lib/api';
import { saveToHistory } from '@/lib/client-history';

interface EvaluationInterfaceProps {
    currentView?: 'main' | 'history';
    onViewChange?: (view: 'main' | 'history') => void;
}

export function EvaluationInterface({ currentView: externalView, onViewChange }: EvaluationInterfaceProps) {
    const [teacherDoc, setTeacherDoc] = useState<File | null>(null);
    const [dialogueRecord, setDialogueRecord] = useState<File | null>(null);
    const [report, setReport] = useState<EvaluationReport | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [step, setStep] = useState<'upload' | 'processing' | 'results'>('upload');
    const [internalView, setInternalView] = useState<'main' | 'history'>('main');
    const [showSettings, setShowSettings] = useState(false);
    const [currentDimension, setCurrentDimension] = useState<string>('');

    // Use external view if provided, otherwise use internal state
    const currentView = externalView ?? internalView;
    const setCurrentView = onViewChange ?? setInternalView;

    const handleStartEvaluation = async () => {
        if (!teacherDoc || !dialogueRecord) return;

        setStep('processing');
        setLoading(true);
        setError(null);
        setProgress(0);
        setCurrentDimension('');

        try {
            // Load API config from localStorage
            const savedSettings = localStorage.getItem('llm-eval-settings');
            const apiConfig = savedSettings ? JSON.parse(savedSettings) : {};

            const result = await evaluateFilesStream(
                teacherDoc,
                dialogueRecord,
                apiConfig,
                (progressEvent: StreamProgress) => {
                    if (progressEvent.type === 'progress' && progressEvent.dimension) {
                        setCurrentDimension(progressEvent.dimension);
                    } else if (progressEvent.type === 'dimension_complete') {
                        if (progressEvent.current && progressEvent.total) {
                            setProgress((progressEvent.current / progressEvent.total) * 100);
                        }
                    }
                }
            );

            // 保存到客户端历史记录
            try {
                const model = apiConfig.model || 'gpt-4o';
                saveToHistory(result, teacherDoc.name, dialogueRecord.name, model);
            } catch (historyError) {
                console.warn('保存历史记录失败:', historyError);
            }

            setReport(result);
            setStep('results');
        } catch (err: any) {
            setError(err.message || "Evaluation failed");
            setStep('upload');
        } finally {
            setLoading(false);
        }
    };

    // 返回到上传界面（保留文件）
    const handleReset = () => {
        // 不清空文件，让用户可以用不同模型测试相同文件
        setReport(null);
        setStep('upload');
        setError(null);
    };

    // 清空所有文件（用户主动清空时调用）
    const handleClearFiles = () => {
        setTeacherDoc(null);
        setDialogueRecord(null);
        setReport(null);
        setStep('upload');
        setError(null);
    };

    const [progress, setProgress] = useState(0);

    // Update progress to 100 when results are ready
    React.useEffect(() => {
        if (step === 'results') {
            setProgress(100);
        }
    }, [step]);

    // Render History View
    if (currentView === 'history') {
        return (
            <div className="w-full max-w-7xl mx-auto px-4 py-8">
                <HistoryView onBack={() => setCurrentView('main')} />
            </div>
        );
    }


    // Render Main View
    return (
        <div className="w-full max-w-7xl mx-auto px-4 py-8 flex flex-col items-center">

            {/* Settings Modal */}
            <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />

            {/* Action Bar (Only visible in upload step and main view) */}
            {step === 'upload' && (
                <div className="w-full flex justify-end gap-4 mb-4">
                    {/* 清空文件按钮 - 只在有文件时显示 */}
                    {(teacherDoc || dialogueRecord) && (
                        <button
                            onClick={handleClearFiles}
                            className="flex items-center gap-2 px-4 py-2 text-red-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors text-sm font-medium"
                        >
                            清空文件
                        </button>
                    )}
                    <button
                        onClick={() => setCurrentView('history')}
                        className="flex items-center gap-2 px-4 py-2 text-slate-600 hover:text-indigo-600 hover:bg-slate-50 rounded-lg transition-colors text-sm font-medium"
                    >
                        <History className="w-4 h-4" />
                        历史记录
                    </button>
                    <button
                        onClick={() => setShowSettings(true)}
                        className="flex items-center gap-2 px-4 py-2 text-slate-600 hover:text-indigo-600 hover:bg-slate-50 rounded-lg transition-colors text-sm font-medium"
                    >
                        <Settings className="w-4 h-4" />
                        设置
                    </button>
                </div>
            )}

            {step === 'upload' && (
                <div className="w-full grid lg:grid-cols-2 gap-16 items-center animate-in fade-in slide-in-from-bottom-8 duration-700 mt-8">

                    {/* Left Column: Headline & Info */}
                    <div className="space-y-8 text-center lg:text-left">
                        <div className="space-y-4">
                            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-indigo-50 border border-indigo-100 text-indigo-700 font-semibold text-sm">
                                <Sparkles className="w-4 h-4" />
                                <span>AI 驱动的智能评估引擎</span>
                            </div>
                            <h1 className="text-5xl md:text-6xl font-black text-slate-900 leading-[1.1] tracking-tight">
                                评估您的 <br />
                                <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-violet-600">
                                    智能体 (Agent)
                                </span>
                            </h1>
                            <p className="text-xl text-slate-500 leading-relaxed max-w-xl mx-auto lg:mx-0">
                                上传您的教师指导手册和对话记录，即可在几秒钟内获得全面、多维度的性能分析。
                            </p>
                        </div>

                        {/* Features Grid */}
                        <div className="grid sm:grid-cols-3 gap-6 pt-4 text-left">
                            {[
                                { label: '结构分析', desc: '检查工作流合规性' },
                                { label: '质量评分', desc: '6维度评估' },
                                { label: '即时反馈', desc: '可操作的改进建议' },
                            ].map((feature, i) => (
                                <div key={i} className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm hover:shadow-lg transition-shadow">
                                    <div className="w-10 h-10 rounded-full bg-indigo-50 flex items-center justify-center mb-3">
                                        {i === 0 && <span className="text-xl">📐</span>}
                                        {i === 1 && <span className="text-xl">🏅</span>}
                                        {i === 2 && <span className="text-xl">⚡</span>}
                                    </div>
                                    <h3 className="font-bold text-slate-900 text-sm mb-1">{feature.label}</h3>
                                    <p className="text-xs text-slate-500">{feature.desc}</p>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Right Column: Upload Card */}
                    <div className="relative group">
                        <div className="absolute -inset-1 bg-gradient-to-r from-indigo-500 to-purple-600 rounded-[2.5rem] blur opacity-25 group-hover:opacity-50 transition duration-1000"></div>
                        <div className="relative bg-white rounded-[2rem] shadow-2xl p-8 border border-slate-100 space-y-8">

                            <div className="space-y-6">
                                <div>
                                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4 ml-1">教师指导文档</h4>
                                    <FileUpload
                                        label="上传教师手册"
                                        accept=".docx,.md"
                                        description="上传 .docx 或 .md 格式的指导文档"
                                        onChange={setTeacherDoc}
                                        stepNumber={1}
                                    />
                                </div>

                                <div className="flex items-center justify-center">
                                    <span className="text-slate-300 text-xs font-bold bg-white px-2 z-10">和</span>
                                    <div className="absolute w-full h-px bg-slate-100 left-0"></div>
                                </div>

                                <div>
                                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4 ml-1">对话记录</h4>
                                    <FileUpload
                                        label="上传对话记录"
                                        accept=".json,.txt"
                                        description="上传 .json 或 .txt 格式的对话日志"
                                        onChange={setDialogueRecord}
                                        stepNumber={2}
                                    />
                                </div>
                            </div>

                            {error && (
                                <div className="p-4 bg-red-50 text-red-600 rounded-xl text-sm font-medium text-center border border-red-100">
                                    {error}
                                </div>
                            )}

                            <button
                                onClick={handleStartEvaluation}
                                disabled={!teacherDoc || !dialogueRecord || loading}
                                className={
                                    "w-full py-5 rounded-xl font-bold text-lg shadow-xl hover:shadow-2xl hover:-translate-y-1 transition-all duration-300 flex items-center justify-center gap-2 " +
                                    (teacherDoc && dialogueRecord && !loading
                                        ? "bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-indigo-200"
                                        : "bg-slate-100 text-slate-400 cursor-not-allowed")
                                }
                            >
                                {loading ? (
                                    <>
                                        正在分析文件...
                                        <Loader2 className="w-5 h-5 animate-spin" />
                                    </>
                                ) : (
                                    <>
                                        开始评估
                                        <span className="text-xl">→</span>
                                    </>
                                )}
                            </button>

                        </div>
                    </div>

                </div>
            )}

            {step === 'processing' && (
                <div className="flex flex-col items-center justify-center py-32 space-y-8 animate-in fade-in duration-700">
                    <div className="relative w-32 h-32">
                        {/* Circular Progress Bar */}
                        <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
                            {/* Background Circle */}
                            <circle
                                cx="50"
                                cy="50"
                                r="40"
                                fill="none"
                                stroke="#e2e8f0"
                                strokeWidth="8"
                            />
                            {/* Progress Circle */}
                            <circle
                                cx="50"
                                cy="50"
                                r="40"
                                fill="none"
                                stroke="url(#progressGradient)"
                                strokeWidth="8"
                                strokeLinecap="round"
                                strokeDasharray={251.2} // 2 * PI * 40
                                strokeDashoffset={251.2 - (251.2 * progress) / 100}
                                className="transition-all duration-300 ease-linear"
                            />
                            <defs>
                                <linearGradient id="progressGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                                    <stop offset="0%" stopColor="#4f46e5" />
                                    <stop offset="100%" stopColor="#7c3aed" />
                                </linearGradient>
                            </defs>
                        </svg>

                        <div className="absolute inset-0 flex flex-col items-center justify-center">
                            <span className="text-2xl font-black text-indigo-600">
                                {Math.round(progress)}<span className="text-sm">%</span>
                            </span>
                        </div>
                    </div>

                    <div className="text-center space-y-2">
                        <h2 className="text-2xl font-bold text-slate-800">正在进行评估</h2>
                        {currentDimension ? (
                            <p className="text-indigo-600 font-medium text-lg">
                                正在评估: {currentDimension}
                            </p>
                        ) : (
                            <p className="text-slate-500 text-lg">
                                准备开始评估...
                            </p>
                        )}
                    </div>
                </div>
            )}

            {step === 'results' && report && (
                <ReportView report={report} onReset={handleReset} />
            )}

        </div>
    );
}
