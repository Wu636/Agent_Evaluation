"use client";

import React, { useState, useEffect, useRef } from "react";
import { X, Save, Shield, Key, FilePlus, Loader2, CheckCircle2, AlertCircle, Play, Cpu } from "lucide-react";
import { PolymasCredentials, InjectProgressEvent, InjectSummary } from "@/lib/training-injector/types";
import { parsePolymasUrl } from "@/lib/training-injector/api";
import { AVAILABLE_MODELS } from "@/lib/config";

interface InjectConfigModalProps {
    isOpen: boolean;
    onClose: () => void;
    scriptMarkdown?: string;
    rubricMarkdown?: string;
}

const STORAGE_KEY = "training-injector-credentials";

export function InjectConfigModal({
    isOpen,
    onClose,
    scriptMarkdown,
    rubricMarkdown,
}: InjectConfigModalProps) {
    // --- 表单状态 ---
    const [authorization, setAuthorization] = useState("");
    const [cookie, setCookie] = useState("");
    const [taskId, setTaskId] = useState("");
    const [courseId, setCourseId] = useState("");
    const [libraryFolderId, setLibraryFolderId] = useState("");
    const [injectMode, setInjectMode] = useState<"replace" | "append">("replace");
    const [injectScript, setInjectScript] = useState(!!scriptMarkdown);
    const [injectRubric, setInjectRubric] = useState(!!rubricMarkdown);

    // --- 注入过程状态 ---
    const [injecting, setInjecting] = useState(false);
    const [progressLogs, setProgressLogs] = useState<InjectProgressEvent[]>([]);
    const [error, setError] = useState("");
    const [summary, setSummary] = useState<InjectSummary | null>(null);
    const [extractionMode, setExtractionMode] = useState<"hybrid" | "llm">("hybrid");
    const [llmModel, setLlmModel] = useState("");

    const logsEndRef = useRef<HTMLDivElement>(null);

    // 回填可用的数据开关
    useEffect(() => {
        setInjectScript(!!scriptMarkdown);
        setInjectRubric(!!rubricMarkdown);
    }, [scriptMarkdown, rubricMarkdown, isOpen]);

    // 加载凭证和 LLM 配置
    useEffect(() => {
        if (isOpen && typeof window !== "undefined") {
            try {
                const stored = localStorage.getItem(STORAGE_KEY);
                if (stored) {
                    const parsed = JSON.parse(stored) as PolymasCredentials;
                    setAuthorization(parsed.authorization || "");
                    setCookie(parsed.cookie || "");
                }
            } catch {
                // ignore
            }
            // 同步读取当前 LLM 模型设置
            try {
                const llmStored = localStorage.getItem("llm-eval-settings");
                if (llmStored) {
                    const llmParsed = JSON.parse(llmStored);
                    setLlmModel(llmParsed.model || "");
                }
            } catch {
                // ignore
            }
        } else {
            // 关闭时重置状态
            if (!injecting) {
                setProgressLogs([]);
                setError("");
                setSummary(null);
            }
        }
    }, [isOpen]);

    // 自动滚动日志
    useEffect(() => {
        if (logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [progressLogs]);

    const handleSaveCredentials = () => {
        if (!authorization.trim() || !cookie.trim()) {
            setError("请填写 Authorization 和 Cookie");
            return false;
        }
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
                authorization: authorization.trim(),
                cookie: cookie.trim(),
            })
        );
        return true;
    };

    const handleInject = async () => {
        if (!handleSaveCredentials()) return;

        let finalTaskId = taskId.trim();
        let finalCourseId = courseId.trim();

        // 尝试解析 URL
        if (finalTaskId.includes("http") || finalTaskId.includes("?")) {
            const parsed = parsePolymasUrl(finalTaskId);
            if (parsed) {
                finalTaskId = parsed.trainTaskId;
                finalCourseId = parsed.courseId;
                setTaskId(finalTaskId);
                setCourseId(finalCourseId);
                setLibraryFolderId(parsed.libraryFolderId || "");
            }
        }

        const finalLibraryFolderId = libraryFolderId || (() => {
            try {
                const parsed = parsePolymasUrl(taskId.trim().includes("http") ? taskId.trim() : `https://example.com?${taskId.trim()}`);
                return parsed?.libraryFolderId || "";
            } catch { return ""; }
        })();

        if (!finalTaskId) {
            setError("请填写目标训练任务 ID (TASK_ID) 或粘贴完整链接");
            return;
        }
        if (!injectScript && !injectRubric) {
            setError("请至少选择一项注入内容");
            return;
        }

        setInjecting(true);
        setError("");
        setSummary(null);
        setProgressLogs([]);

        // 获取 LLM 配置用于智能提取，使用用户在注入弹窗中选择的模型覆盖
        let llmSettings = undefined;
        try {
            const storedConfig = localStorage.getItem("llm-eval-settings");
            if (storedConfig) {
                llmSettings = JSON.parse(storedConfig);
                // 用弹窗中用户选择的模型覆盖
                if (llmModel) {
                    llmSettings.model = llmModel;
                }
                console.log("[InjectModal] LLM settings loaded:", {
                    hasApiKey: !!llmSettings?.apiKey,
                    apiUrl: llmSettings?.apiUrl,
                    model: llmSettings?.model,
                });
            } else {
                console.warn("[InjectModal] No LLM settings found in localStorage (key: llm-eval-settings)");
            }
        } catch {
            // ignore
        }

        try {
            const response = await fetch("/api/training-inject", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    trainTaskId: finalTaskId,
                    courseId: finalCourseId,
                    libraryFolderId: finalLibraryFolderId,
                    credentials: {
                        authorization: authorization.trim(),
                        cookie: cookie.trim(),
                    },
                    llmSettings,
                    extractionMode,
                    scriptMarkdown: injectScript ? scriptMarkdown : undefined,
                    rubricMarkdown: injectRubric ? rubricMarkdown : undefined,
                    injectMode,
                }),
            });

            if (!response.ok) {
                throw new Error(`API 请求失败: ${response.statusText}`);
            }

            const reader = response.body?.getReader();
            if (!reader) throw new Error("无法读取响应流");

            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith("data: ")) continue;

                    try {
                        const data = JSON.parse(trimmed.slice(6)) as InjectProgressEvent;
                        setProgressLogs((prev) => [...prev, data]);

                        if (data.type === "error") {
                            setError(data.message);
                            setInjecting(false);
                            return; // 遇到错误立刻停止处理日志
                        }
                        if (data.type === "complete") {
                            setSummary(data.summary);
                            setInjecting(false);
                            return;
                        }
                    } catch {
                        // 解析异常忽略
                    }
                }
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : "注入过程发生未知错误");
            setInjecting(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl flex flex-col max-h-[90vh] overflow-hidden animate-in zoom-in-95">

                {/* Header */}
                <div className="bg-gradient-to-r from-indigo-600 to-violet-600 px-6 py-4 flex items-center justify-between text-white shrink-0">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                            <Play className="w-5 h-5 fill-white" />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold">一键注入到智慧树平台</h2>
                            <p className="text-indigo-100 text-xs mt-0.5">将生成的配置自动创建为工作流节点</p>
                        </div>
                    </div>
                    {!injecting && (
                        <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-xl transition-colors">
                            <X className="w-5 h-5" />
                        </button>
                    )}
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    {/* 错误提示 */}
                    {error && (
                        <div className="p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3">
                            <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                            <div className="text-sm text-red-700 font-medium whitespace-pre-wrap">{error}</div>
                        </div>
                    )}

                    {/* 配置区域 (注入中隐藏) */}
                    {!injecting && !summary && (
                        <>
                            {/* 认证凭证 */}
                            <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 space-y-4">
                                <div className="flex items-center gap-2">
                                    <Shield className="w-4 h-4 text-slate-500" />
                                    <h3 className="font-semibold text-slate-700 text-sm">平台认证凭证 (polymas.com)</h3>
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label className="text-xs font-medium text-slate-600 block mb-1.5 flex justify-between">
                                            <span>Authorization</span>
                                        </label>
                                        <input
                                            type="password"
                                            value={authorization}
                                            onChange={(e) => setAuthorization(e.target.value)}
                                            placeholder="Bearer eyJhb..."
                                            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 font-mono"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs font-medium text-slate-600 block mb-1.5">Cookie</label>
                                        <input
                                            type="password"
                                            value={cookie}
                                            onChange={(e) => setCookie(e.target.value)}
                                            placeholder="SESSION=..."
                                            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 font-mono"
                                        />
                                    </div>
                                </div>
                                <p className="text-xs text-slate-400 flex items-center gap-1.5 mt-2">
                                    <Key className="w-3.5 h-3.5" />
                                    凭证仅保存在本地浏览器中，用于调用云端建课 API
                                </p>
                            </div>

                            {/* 注入目标 */}
                            <div className="bg-white border border-slate-200 shadow-sm rounded-xl p-5 space-y-4">
                                <div className="flex items-center gap-2">
                                    <FilePlus className="w-4 h-4 text-indigo-500" />
                                    <h3 className="font-semibold text-slate-700 text-sm">注入目标配置</h3>
                                </div>

                                <div>
                                    <label className="text-xs font-medium text-slate-700 block mb-1.5">
                                        目标任务链接或 ID <span className="text-red-500">*</span>
                                    </label>
                                    <input
                                        type="text"
                                        value={taskId}
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            setTaskId(val);
                                            // 边输入边解析
                                            if (val.includes("http") || val.includes("?")) {
                                                const parsed = parsePolymasUrl(val);
                                                if (parsed) {
                                                    setTaskId(parsed.trainTaskId);
                                                    setCourseId(parsed.courseId);
                                                    setLibraryFolderId(parsed.libraryFolderId || "");
                                                }
                                            }
                                        }}
                                        placeholder="请完整复制平台中该任务的 URL 链接并粘贴到此处"
                                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                                    />
                                    {courseId && (
                                        <p className="text-xs text-emerald-600 mt-1.5 ml-1">
                                            ✅ 已自动解析提取出双 ID (业务 ID: {courseId})
                                        </p>
                                    )}
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2 border-t border-slate-100">
                                    {/* 左侧：注入内容 */}
                                    <div className="space-y-3">
                                        <label className="text-xs font-medium text-slate-700 block">注入内容</label>
                                        <label className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors ${!scriptMarkdown ? 'opacity-50 cursor-not-allowed bg-slate-50' : 'hover:bg-slate-50'}`}>
                                            <input
                                                type="checkbox"
                                                checked={injectScript}
                                                onChange={(e) => setInjectScript(e.target.checked)}
                                                disabled={!scriptMarkdown}
                                                className="rounded text-indigo-600 focus:ring-indigo-500"
                                            />
                                            <span className="text-sm font-medium text-slate-700">训练剧本配置节点</span>
                                            {!scriptMarkdown && <span className="text-xs text-slate-400 ml-auto">未生成</span>}
                                        </label>
                                        <label className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors ${!rubricMarkdown ? 'opacity-50 cursor-not-allowed bg-slate-50' : 'hover:bg-slate-50'}`}>
                                            <input
                                                type="checkbox"
                                                checked={injectRubric}
                                                onChange={(e) => setInjectRubric(e.target.checked)}
                                                disabled={!rubricMarkdown}
                                                className="rounded text-indigo-600 focus:ring-indigo-500"
                                            />
                                            <span className="text-sm font-medium text-slate-700">任务评分标准</span>
                                            {!rubricMarkdown && <span className="text-xs text-slate-400 ml-auto">未生成</span>}
                                        </label>
                                    </div>

                                    {/* 右侧：注入模式 */}
                                    {injectScript && (
                                        <div className="space-y-3">
                                            <label className="text-xs font-medium text-slate-700 block">节点注入模式</label>
                                            <div className="flex flex-col gap-2">
                                                <label className={`p-2 border rounded-lg cursor-pointer transition-colors ${injectMode === 'replace' ? 'border-indigo-500 bg-indigo-50/50' : 'hover:bg-slate-50 border-slate-200'}`}>
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <input type="radio" checked={injectMode === 'replace'} onChange={() => setInjectMode('replace')} className="text-indigo-600 focus:ring-indigo-500" />
                                                        <span className="text-sm font-medium text-slate-800">全部清除后重建 (推荐)</span>
                                                    </div>
                                                    <p className="text-xs text-slate-500 pl-6">将会删除目标任务中所有旧的剧本节点和连线，然后完整创建新的流程。</p>
                                                </label>
                                                <label className={`p-2 border rounded-lg cursor-pointer transition-colors ${injectMode === 'append' ? 'border-indigo-500 bg-indigo-50/50' : 'hover:bg-slate-50 border-slate-200'}`}>
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <input type="radio" checked={injectMode === 'append'} onChange={() => setInjectMode('append')} className="text-indigo-600 focus:ring-indigo-500" />
                                                        <span className="text-sm font-medium text-slate-800">在现有节点后追加</span>
                                                    </div>
                                                    <p className="text-xs text-slate-500 pl-6">保留原有的节点，只是新增节点，请稍后手动调整连线。</p>
                                                </label>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* LLM 模型选择 */}
                                <div className="pt-3 border-t border-slate-100 space-y-2">
                                    <div className="flex items-center gap-2">
                                        <Cpu className="w-3.5 h-3.5 text-slate-500" />
                                        <label className="text-xs font-medium text-slate-700">AI 提取模型</label>
                                    </div>
                                    <select
                                        value={llmModel}
                                        onChange={(e) => setLlmModel(e.target.value)}
                                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white"
                                    >
                                        <option value="" disabled>请选择模型...</option>
                                        {AVAILABLE_MODELS.map((m) => (
                                            <option key={m.id} value={m.id}>{m.name} — {m.description}</option>
                                        ))}
                                    </select>
                                    {!llmModel && (
                                        <p className="text-xs text-amber-600">⚠ 未检测到模型配置，请先在全局设置中配置 API Key 和模型，或在此处选择</p>
                                    )}
                                </div>

                                {/* 提取模式选择 */}
                                <div className="pt-3 border-t border-slate-100 space-y-2">
                                    <label className="text-xs font-medium text-slate-700 block">提取模式</label>
                                    <div className="flex gap-2">
                                        <button
                                            type="button"
                                            onClick={() => setExtractionMode('hybrid')}
                                            className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${extractionMode === 'hybrid'
                                                ? 'bg-indigo-50 border-indigo-500 text-indigo-700'
                                                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                                                }`}
                                        >
                                            ⚡ 智能模式
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setExtractionMode('llm')}
                                            className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${extractionMode === 'llm'
                                                ? 'bg-indigo-50 border-indigo-500 text-indigo-700'
                                                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                                                }`}
                                        >
                                            🤖 纯 LLM
                                        </button>
                                    </div>
                                    <p className="text-xs text-slate-400">
                                        {extractionMode === 'hybrid'
                                            ? '正则解析剧本（快速），LLM 仅用于评分标准字段拆分'
                                            : '所有内容均使用 LLM 提取，适用于非标准格式文档（较慢）'
                                        }
                                    </p>
                                </div>
                            </div>
                        </>
                    )}

                    {/* 注入进度或结果 */}
                    {(injecting || progressLogs.length > 0) && (
                        <div className="bg-slate-900 rounded-xl overflow-hidden flex flex-col items-stretch border border-slate-800 shadow-inner">
                            <div className="bg-slate-800 px-4 py-2 border-b border-slate-700 flex justify-between items-center shrink-0">
                                <span className="text-xs font-mono text-emerald-400 flex items-center gap-2">
                                    {injecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Shield className="w-3.5 h-3.5" />}
                                    {injecting ? "执行注入任务中..." : "任务执行结束"}
                                </span>
                                {summary && <span className="text-xs text-slate-400 bg-slate-700/50 px-2 py-0.5 rounded">Process finished with exit code 0</span>}
                            </div>

                            <div className="p-4 font-mono text-sm overflow-y-auto max-h-[300px] min-h-[150px] space-y-1.5 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
                                {progressLogs.map((log, i) => (
                                    <div key={i} className={`flex gap-2 ${log.type === 'error' ? 'text-red-400' : log.type === 'complete' ? 'text-emerald-400 font-bold' : log.type === 'start' ? 'text-blue-300 font-semibold' : 'text-slate-300'}`}>
                                        <span className="text-slate-600 shrink-0">[{new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}]</span>
                                        <span className="break-all">{log.type === 'start' ? `>>> ${log.message}` : log.message}</span>
                                    </div>
                                ))}
                                <div ref={logsEndRef} className="h-1" />
                            </div>

                            {summary && (
                                <div className="bg-emerald-950/30 border-t border-emerald-900/50 p-4 shrink-0">
                                    <div className="flex items-center gap-2 text-emerald-400 font-semibold mb-2">
                                        <CheckCircle2 className="w-4 h-4" />
                                        注入操作盘点
                                    </div>
                                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                                        <div className="bg-black/20 rounded p-2 border border-white/5">
                                            <div className="text-slate-400 text-xs mb-0.5">新建阶段节点</div>
                                            <div className="text-emerald-300 font-mono text-lg">{summary.stepsCreated}</div>
                                        </div>
                                        <div className="bg-black/20 rounded p-2 border border-white/5">
                                            <div className="text-slate-400 text-xs mb-0.5">新建节点连线</div>
                                            <div className="text-emerald-300 font-mono text-lg">{summary.flowsCreated}</div>
                                        </div>
                                        <div className="bg-black/20 rounded p-2 border border-white/5">
                                            <div className="text-slate-400 text-xs mb-0.5">新建评分项</div>
                                            <div className="text-emerald-300 font-mono text-lg">{summary.scoreItemsCreated}</div>
                                        </div>
                                        <div className="bg-black/20 rounded p-2 border border-white/5">
                                            <div className="text-slate-400 text-xs mb-0.5">清理旧工作流</div>
                                            <div className="text-slate-300 font-mono text-lg">
                                                {summary.stepsDeleted + summary.flowsDeleted} <span className="text-xs">项</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex justify-end gap-3 shrink-0 rounded-b-2xl">
                    {!injecting && !summary && (
                        <button
                            onClick={onClose}
                            className="px-5 py-2 text-sm text-slate-600 hover:bg-slate-200 bg-slate-100 rounded-lg font-medium transition-colors"
                        >
                            取消
                        </button>
                    )}

                    {summary ? (
                        <button
                            onClick={onClose}
                            className="px-6 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-medium transition-colors shadow-sm"
                        >
                            完成并关闭
                        </button>
                    ) : (
                        <button
                            onClick={handleInject}
                            disabled={injecting || (!injectScript && !injectRubric)}
                            className="px-6 py-2 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 disabled:opacity-50 text-white rounded-lg font-medium flex items-center gap-2 shadow-md shadow-indigo-500/20 transition-all"
                        >
                            {injecting ? (
                                <>
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    注入中...
                                </>
                            ) : (
                                <>
                                    <Play className="w-4 h-4 fill-current" />
                                    执行注入
                                </>
                            )}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
