"use client";

import React, { useState, useEffect, useRef } from 'react';
import { Sparkles, Loader2, History, Settings, ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react';
import { FileUpload } from '@/components/FileUpload';
import { ReportView } from '@/components/ReportView';
import { SettingsModal } from '@/components/SettingsModal';
import { HistoryView } from '@/components/HistoryView';
import { EnhancedLoginModal } from '@/components/EnhancedLoginModal';
import { UserMenu } from '@/components/UserMenu';
import { useAuth } from '@/components/AuthProvider';
import { evaluateFilesStream, EvaluationReport, StreamProgress } from '@/lib/api';
import { saveToHistory } from '@/lib/client-history';
import { saveFile, loadFile, clearAllFiles, TEACHER_DOC_ID, DIALOGUE_RECORD_ID } from '@/lib/file-storage';
import { DIMENSIONS } from '@/lib/config';
import { supabase } from '@/lib/supabase';
import { EvaluationTemplate, DEFAULT_DIMENSIONS, getEnabledSubDimensions, calculateTotalScore } from '@/lib/templates';

// 添加工作流配置文件 ID
const WORKFLOW_CONFIG_ID = 'workflow_config';

interface EvaluationInterfaceProps {
    currentView?: 'main' | 'history';
    onViewChange?: (view: 'main' | 'history') => void;
}

export function EvaluationInterface({ currentView: externalView, onViewChange }: EvaluationInterfaceProps) {
    const { user, session } = useAuth();
    const [teacherDoc, setTeacherDoc] = useState<File | null>(null);
    const [referenceDoc, setReferenceDoc] = useState<File | null>(null);
    const [isRefDocExpanded, setIsRefDocExpanded] = useState(false);
    const [dialogueRecord, setDialogueRecord] = useState<File | null>(null);
    const [report, setReport] = useState<EvaluationReport | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [step, setStep] = useState<'upload' | 'processing' | 'results'>('upload');
    const [internalView, setInternalView] = useState<'main' | 'history'>('main');
    const [showSettings, setShowSettings] = useState(false);
    const [showLoginModal, setShowLoginModal] = useState(false);
    const [currentDimension, setCurrentDimension] = useState<string>('');
    const [templates, setTemplates] = useState<EvaluationTemplate[]>([]);
    const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');

    // 用于取消进行中的评估
    const abortControllerRef = useRef<AbortController | null>(null);
    // 用于标识当前评估会话，避免旧回调影响新评估
    const evaluationSessionRef = useRef<number>(0);

    // 加载模板列表
    useEffect(() => {
        const fetchTemplates = async () => {
            try {
                const res = await fetch('/api/templates');
                const data = await res.json();
                if (data.templates && data.templates.length > 0) {
                    setTemplates(data.templates);
                    // 自动选中系统默认模板
                    const defaultTemplate = data.templates.find((t: any) => t.is_default);
                    if (defaultTemplate) {
                        setSelectedTemplateId(defaultTemplate.id);
                    } else {
                        setSelectedTemplateId(data.templates[0].id);
                    }
                }
            } catch (error) {
                console.error('Failed to fetch templates:', error);
            }
        };
        fetchTemplates();
    }, []);

    // 从 IndexedDB 加载已保存的文件
    useEffect(() => {
        const loadSavedFiles = async () => {
            try {
                const savedTeacherDoc = await loadFile(TEACHER_DOC_ID);
                const savedDialogueRecord = await loadFile(DIALOGUE_RECORD_ID);
                if (savedTeacherDoc) setTeacherDoc(savedTeacherDoc);
                if (savedDialogueRecord) setDialogueRecord(savedDialogueRecord);
            } catch (error) {
                console.error('加载保存的文件失败:', error);
            }
        };
        loadSavedFiles();
    }, []);

    // 保存教师文档到 IndexedDB
    const handleTeacherDocChange = async (file: File | null) => {
        setTeacherDoc(file);
        if (file) {
            await saveFile(TEACHER_DOC_ID, file);
        }
    };

    // 保存对话记录到 IndexedDB
    const handleDialogueRecordChange = async (file: File | null) => {
        setDialogueRecord(file);
        if (file) {
            await saveFile(DIALOGUE_RECORD_ID, file);
        }
    };

    // Use external view if provided, otherwise use internal state
    const currentView = externalView ?? internalView;
    const setCurrentView = onViewChange ?? setInternalView;

    const handleStartEvaluation = async () => {
        if (!teacherDoc || !dialogueRecord) return;

        // 取消之前的评估（如果有）
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        abortControllerRef.current = new AbortController();
        const currentSession = ++evaluationSessionRef.current;

        setStep('processing');
        setLoading(true);
        setError(null);
        setProgress(0);
        setCurrentDimension('正在准备...');

        try {
            // Load API config from localStorage
            const savedSettings = localStorage.getItem('llm-eval-settings');
            const apiConfig = savedSettings ? JSON.parse(savedSettings) : {};
            const selectedModel = apiConfig.model || 'claude-sonnet-4.5';

            // 1. 调用解析 API
            setCurrentDimension("正在解析文档...");
            const formData = new FormData();
            formData.append("teacher_doc", teacherDoc);
            if (referenceDoc) {
                formData.append("reference_doc", referenceDoc);
            }
            formData.append("dialogue_record", dialogueRecord);

            const parseRes = await fetch("/api/evaluate/parse", {
                method: "POST",
                body: formData
            });

            if (!parseRes.ok) throw new Error("文件解析失败");

            const { teacherDoc: tDoc, dialogueRecord: dRec, workflowConfig: wCfg } = await parseRes.json();

            // 2. 准备评测任务
            const tasks: Array<{ dimKey: string, subKey: string, dimName: string, subName: string, fullScore: number }> = [];
            let totalSubDimensions = 0;

            // 获取选中的模板或使用默认配置
            // 注意: 如果没有选中模板，使用 DEFAULT_DIMENSIONS 构造一个临时的模板对象结构
            let currentTemplateDimensions = DEFAULT_DIMENSIONS;
            if (selectedTemplateId) {
                const selected = templates.find(t => t.id === selectedTemplateId);
                if (selected) {
                    currentTemplateDimensions = selected.dimensions;
                }
            }

            // 使用帮助函数获取所有启用的子维度
            const enabledSubs = getEnabledSubDimensions(currentTemplateDimensions);

            enabledSubs.forEach(sub => {
                // 从静态配置中获取显示名称 (因为 Template JSON 中不存储名称)
                const dimConfig = DIMENSIONS[sub.dimension];
                const subDimConfig = dimConfig?.subDimensions.find(s => s.key === sub.subDimension);

                if (dimConfig && subDimConfig) {
                    tasks.push({
                        dimKey: sub.dimension,
                        subKey: sub.subDimension,
                        dimName: dimConfig.name,
                        subName: subDimConfig.name,
                        fullScore: sub.fullScore
                    });
                    totalSubDimensions++;
                }
            });

            // 3. 并发评测 - 使用动态并发池优化性能
            const CONCURRENCY_LIMIT = 5;
            const results: Map<string, any> = new Map();
            let completed = 0;

            const executeTask = async (task: typeof tasks[0]) => {
                // 检查当前会话是否仍然有效
                const isCurrentSession = () => evaluationSessionRef.current === currentSession;

                const MAX_RETRIES = 2;
                let success = false;

                for (let attempt = 0; attempt <= MAX_RETRIES && !success; attempt++) {
                    try {
                        if (attempt > 0) {
                            const waitTime = Math.pow(2, attempt) * 1000;
                            await new Promise(r => setTimeout(r, waitTime));
                        }

                        const res = await fetch("/api/evaluate/dimension", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            signal: abortControllerRef.current?.signal,
                            body: JSON.stringify({
                                dimensionKey: task.dimKey,
                                subDimensionKey: task.subKey,
                                fullScore: task.fullScore, // 传递自定义满分
                                teacherDocContent: tDoc.content,
                                dialogueData: dRec.data,
                                workflowConfigContent: wCfg?.content,
                                apiConfig: {
                                    apiKey: apiConfig.apiKey,
                                    baseUrl: apiConfig.baseUrl,
                                    model: selectedModel
                                }
                            })
                        });

                        // 检查是否为流式响应
                        const contentType = res.headers.get("content-type") || "";

                        if (contentType.includes("text/event-stream")) {
                            // 处理 SSE 流式响应
                            const reader = res.body?.getReader();
                            if (!reader) throw new Error("无法读取响应流");

                            const decoder = new TextDecoder();
                            let buffer = "";

                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;

                                buffer += decoder.decode(value, { stream: true });
                                const lines = buffer.split("\n\n");
                                buffer = lines.pop() || "";

                                for (const line of lines) {
                                    if (line.startsWith("data: ")) {
                                        try {
                                            const data = JSON.parse(line.slice(6));
                                            if (data.done && data.result) {
                                                // 流结束，获取最终结果
                                                results.set(`${task.dimKey}-${task.subKey}`, data.result);
                                                success = true;
                                            } else if (data.error) {
                                                console.error(`流式评测错误: ${task.subName}`, data.error);
                                            }
                                            // data.chunk 是中间数据，可选择处理
                                        } catch {
                                            // 忽略解析错误
                                        }
                                    }
                                }
                            }
                            reader.releaseLock();
                        } else if (res.ok) {
                            // 后备：处理传统 JSON 响应
                            const data = await res.json();
                            if (data.error) {
                                console.error(`评测错误: ${task.subName}`, data.error);
                            } else {
                                results.set(`${task.dimKey}-${task.subKey}`, data);
                                success = true;
                            }
                        } else if ([500, 502, 503, 504].includes(res.status)) {
                            if (attempt === MAX_RETRIES) {
                                console.error(`评测失败: ${task.subName} (HTTP ${res.status})`);
                            }
                        } else {
                            console.error(`评测失败: ${task.subName} (HTTP ${res.status})`);
                            break;
                        }
                    } catch (e) {
                        // 如果是用户主动取消，静默退出
                        if (e instanceof Error && e.name === 'AbortError') {
                            return;
                        }
                        if (attempt === MAX_RETRIES) {
                            console.error(`请求异常: ${task.subName}`, e);
                        }
                    }
                }

                completed++;
                // 只有当前会话有效时才更新进度
                if (isCurrentSession()) {
                    const pct = (completed / totalSubDimensions) * 100;
                    setProgress(pct);
                    setCurrentDimension(`${task.dimName} - ${task.subName} (${completed}/${totalSubDimensions})`);
                }
            };

            // 手动实现动态并发控制 (Promise Pool)
            // 避免 Promise.all 的队头阻塞问题
            const executing: Promise<void>[] = [];

            for (const task of tasks) {
                // 创建一个 promise，执行完后要把自己从 executing 数组中移除
                const p = executeTask(task).then(() => {
                    // 移除逻辑：找到 promise 对象并移除
                    // 注意：这里需要确保 p 是被 push 进去的那个 promise
                    // 实际上 splice 需要 index，但数组在变动。
                    // 更稳健的方式是使用闭包引用或者 filter
                    // 这里由于 splice 是同步的，可能会有问题如果并发很高？实际上 JS 是单线程的。
                    // 简单实现：
                    const idx = executing.indexOf(p);
                    if (idx > -1) executing.splice(idx, 1);
                });

                executing.push(p);

                // 如果达到并发限制，等待最快的一个完成
                if (executing.length >= CONCURRENCY_LIMIT) {
                    await Promise.race(executing);
                }
            }

            // 等待剩余的任务完成
            await Promise.all(executing);

            // 检查会话是否仍然有效，如果用户已取消则退出
            if (evaluationSessionRef.current !== currentSession) {
                console.log('[Evaluation] Session cancelled, aborting report generation');
                return;
            }

            setCurrentDimension("正在生成最终报告...");

            // 4. 聚合结果
            const dimensionScores = Object.entries(DIMENSIONS).map(([dKey, dConfig]) => {
                // 检查该维度在当前模板中是否启用
                const templateDim = currentTemplateDimensions[dKey];
                if (!templateDim || !templateDim.enabled) return null;

                const subScores: any[] = [];
                dConfig.subDimensions.forEach(sub => {
                    // 检查子维度是否启用
                    const templateSub = templateDim.subDimensions[sub.key];
                    if (!templateSub || !templateSub.enabled) return;

                    const res = results.get(`${dKey}-${sub.key}`);
                    if (res) subScores.push(res);
                });

                const totalScore = subScores.reduce((sum, s) => sum + s.score, 0);

                // 聚合分析文本
                const analysis = subScores.map(s =>
                    `【${s.sub_dimension}】(${s.score}/${s.full_score}): ${s.judgment_basis}`
                ).join("\n\n");

                let level = "合格";
                if (totalScore >= dConfig.fullScore * 0.9) level = "优秀";
                else if (totalScore >= dConfig.fullScore * 0.75) level = "良好";
                else if (totalScore < dConfig.fullScore * 0.6) level = "不合格";

                // 根据模板中的满分计算 (其实 subScores 里的 score 已经是根据自定义满分打的了)
                // 这里我们要使用模板里定义的该维度的总权重(如果有)或者直接求和
                // 目前模板结构里: dimension 有 weight 和 fullScore (但 fullScore 需要从 subDimensions 累加)

                // templateDim.subDimensions has the scores configuration
                const currentFullScore = calculateTotalScore({ [dKey]: templateDim });

                return {
                    dimension: dConfig.name,
                    score: totalScore,
                    full_score: currentFullScore,
                    weight: dConfig.weight, // 暂时沿用静态配置的权重，如果模板支持自定义权重则需修改
                    level,
                    analysis,
                    sub_scores: subScores,
                    isVeto: dConfig.isVeto && dConfig.vetoThreshold !== undefined && totalScore < dConfig.vetoThreshold,
                    weighted_score: totalScore
                };
            }).filter((d): d is NonNullable<typeof d> => d !== null);

            // 计算总分
            const finalTotalScore = dimensionScores.reduce((sum, d) => sum + d.weighted_score, 0);

            // 计算总满分
            const totalPossibleScore = dimensionScores.reduce((sum, d) => sum + d.full_score, 0);

            // 确定否决和评级 (基于百分比)
            const vetoReasons: string[] = [];
            dimensionScores.forEach(d => {
                if (d.isVeto) vetoReasons.push(`${d.dimension}得分低于阈值`);
            });

            let finalLevel = "不合格";
            let passCriteriaMet = false;
            const scoreRatio = totalPossibleScore > 0 ? finalTotalScore / totalPossibleScore : 0;

            if (vetoReasons.length > 0) {
                finalLevel = "一票否决";
            } else if (scoreRatio >= 0.9) {
                finalLevel = "优秀";
                passCriteriaMet = true;
            } else if (scoreRatio >= 0.75) {
                finalLevel = "良好";
                passCriteriaMet = true;
            } else if (scoreRatio >= 0.6) {
                finalLevel = "合格";
                passCriteriaMet = true;
            }

            // 收集 Issues 和 Suggestions
            const allIssues: string[] = [];
            const allSuggestions: string[] = [];
            dimensionScores.forEach(d => {
                d.sub_scores.forEach((s: any) => {
                    if (s.issues) s.issues.forEach((i: any) => allIssues.push(`[${s.sub_dimension}] ${i.description}`));
                    if (s.rating === "不足" || s.rating === "较差") allSuggestions.push(`优化${s.sub_dimension}: ${s.judgment_basis}`);
                });
            });

            const finalReport: EvaluationReport & { history_id?: string } = {
                task_id: "",
                total_score: finalTotalScore,
                dimensions: dimensionScores,
                analysis: `评测完成。总分: ${finalTotalScore.toFixed(1)}`,
                issues: allIssues,
                suggestions: allSuggestions,
                final_level: finalLevel as any,
                pass_criteria_met: passCriteriaMet,
                veto_reasons: vetoReasons,
                history_id: "",

                // 注入源文档内容
                teacher_doc_name: tDoc.name,
                teacher_doc_content: tDoc.content,
                dialogue_doc_name: dRec.name,
                dialogue_doc_content: JSON.stringify(dRec.data, null, 2)
            };

            // 再次检查会话有效性（在保存历史前）
            if (evaluationSessionRef.current !== currentSession) {
                console.log('[Evaluation] Session cancelled before saving history');
                return;
            }

            // 5. 保存历史
            try {
                const saveRes = await fetch("/api/evaluate/history", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        report: finalReport,
                        teacherDocName: tDoc.name,
                        dialogueRecordName: dRec.name,
                        modelName: selectedModel
                    })
                });
                if (saveRes.ok) {
                    const histData = await saveRes.json();
                    finalReport.history_id = histData.history_id;
                }
            } catch (e) {
                console.warn("历史保存失败", e);
            }

            // 同时保存到客户端 localStorage（作为后备）
            try {
                saveToHistory(finalReport as any, tDoc.name, dRec.name, selectedModel);
            } catch (e) {
                console.warn("客户端历史保存失败", e);
            }

            // 如果用户已登录，保存到 Supabase
            console.log("[Supabase] 检查登录状态:", { hasSession: !!session, hasToken: !!session?.access_token });
            if (session?.access_token) {
                try {
                    const supabaseRes = await fetch("/api/evaluations", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${session.access_token}`
                        },
                        body: JSON.stringify({
                            teacherDocName: tDoc.name,
                            teacherDocContent: tDoc.content,
                            dialogueRecordName: dRec.name,
                            dialogueData: dRec.data,
                            report: finalReport,
                            modelUsed: selectedModel
                        })
                    });
                    if (supabaseRes.ok) {
                        console.log("[Supabase] 评测已保存到云端");
                    } else {
                        const errData = await supabaseRes.json();
                        console.warn("[Supabase] 保存失败:", errData);
                    }
                } catch (e) {
                    console.warn("Supabase 保存失败", e);
                }
            } else {
                console.log("[Supabase] 用户未登录，跳过云端保存");
            }

            // 最终检查会话有效性（在设置结果前）
            if (evaluationSessionRef.current !== currentSession) {
                console.log('[Evaluation] Session cancelled before showing results');
                return;
            }

            setReport(finalReport);
            setStep('results');
        } catch (err: any) {
            console.error("评测流程错误:", err);
            setError(err.message || "Evaluation failed");
            setStep('upload');
        } finally {
            setLoading(false);
        }
    };

    // 返回到上传界面（保留文件）
    const handleReset = () => {
        // 取消所有进行中的 API 请求
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        // 递增会话 ID，使旧回调失效
        evaluationSessionRef.current += 1;

        // 不清空文件，让用户可以用不同模型测试相同文件
        setReport(null);
        setStep('upload');
        setError(null);
        setLoading(false);  // 重置加载状态
        setProgress(0);     // 重置进度
        setCurrentDimension('');  // 清空当前维度显示
    };

    const handleClearFiles = async () => {
        setTeacherDoc(null);
        setReferenceDoc(null);
        setDialogueRecord(null);
        setReport(null);
        setStep('upload');
        setError(null);
        // 清空 IndexedDB 中的文件
        await clearAllFiles();
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

            {/* Login Modal */}
            <EnhancedLoginModal isOpen={showLoginModal} onClose={() => setShowLoginModal(false)} />

            {/* Action Bar (Only visible in upload step and main view) */}
            {step === 'upload' && (
                <div className="w-full flex justify-end gap-4 mb-4">
                    {/* 清空文件按钮 - 只在有文件时显示 */}
                    {(teacherDoc || dialogueRecord) && (
                        <button
                            onClick={handleClearFiles}
                            className="flex items-center gap-2 px-4 py-2 text-red-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors text-sm font-medium"
                        >
                            <span className="text-xl">×</span>
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

                                    {/* Teacher Doc (Primary) */}
                                    <div className="mb-4">
                                        <FileUpload
                                            label="上传教师手册"
                                            accept=".doc,.docx,.md"
                                            description="上传或直接粘贴教师指导文档内容"
                                            onChange={handleTeacherDocChange}
                                            currentFile={teacherDoc}
                                            stepNumber={1}
                                        />
                                    </div>

                                    {/* Reference File (Optional - Collapsible) */}
                                    <div className="rounded-xl overflow-hidden transition-all duration-300">
                                        <button
                                            onClick={() => setIsRefDocExpanded(!isRefDocExpanded)}
                                            className={`w-full flex items-center justify-between p-4 transition-all duration-300 group ${isRefDocExpanded
                                                ? 'bg-slate-50 border-b border-slate-100 rounded-t-xl'
                                                : 'bg-white border border-dashed border-slate-300 hover:border-indigo-400 hover:bg-indigo-50/10 rounded-xl'
                                                }`}
                                        >
                                            <div className="flex items-center gap-3 text-sm">
                                                <div className={`p-1 rounded-md transition-colors ${isRefDocExpanded ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-100 text-slate-500 group-hover:bg-indigo-50 group-hover:text-indigo-500'}`}>
                                                    {isRefDocExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                                                </div>
                                                <span className={`font-medium transition-colors ${isRefDocExpanded ? 'text-slate-900' : 'text-slate-500 group-hover:text-indigo-600'}`}>
                                                    参考文档 (可选)
                                                </span>
                                            </div>
                                            {referenceDoc && !isRefDocExpanded && (
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xs text-slate-500 max-w-[150px] truncate">
                                                        {referenceDoc.name}
                                                    </span>
                                                    <span className="text-[10px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-full">
                                                        已就绪
                                                    </span>
                                                </div>
                                            )}
                                        </button>

                                        {isRefDocExpanded && (
                                            <div className="p-4 bg-white border-x border-b border-slate-100 rounded-b-xl animate-in fade-in slide-in-from-top-1 duration-200">
                                                <FileUpload
                                                    label="上传参考资料"
                                                    accept=".doc,.docx,.md,.txt,.pdf"
                                                    description="上传额外的参考文档或能力训练资料"
                                                    onChange={(file) => setReferenceDoc(file)}
                                                    currentFile={referenceDoc}
                                                    stepNumber={0} // 0 means no number badge
                                                />
                                            </div>
                                        )}
                                    </div>
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
                                        onChange={handleDialogueRecordChange}
                                        currentFile={dialogueRecord}
                                        stepNumber={2}
                                    />
                                </div>

                                {/* Template Selector */}
                                <div>
                                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2 ml-1">评测模板</h4>
                                    <select
                                        value={selectedTemplateId}
                                        onChange={(e) => setSelectedTemplateId(e.target.value)}
                                        className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-500 transition-all appearance-none cursor-pointer hover:border-indigo-300"
                                    >
                                        {templates.map(t => (
                                            <option key={t.id} value={t.id}>
                                                {t.name}
                                            </option>
                                        ))}
                                    </select>
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
                <div className="flex flex-col items-center justify-center py-32 space-y-8 animate-in fade-in duration-700 relative w-full">
                    {/* 返回按钮 */}
                    <button
                        onClick={handleReset}
                        className="absolute left-0 top-0 flex items-center gap-2 px-4 py-2 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors"
                    >
                        <ArrowLeft className="w-5 h-5" />
                        <span className="font-medium">返回/取消</span>
                    </button>

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
                                {currentDimension}
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
