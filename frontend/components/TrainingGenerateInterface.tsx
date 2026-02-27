"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import {
    Upload,
    FileText,
    X,
    Check,
    Loader2,
    Download,
    Copy,
    RefreshCw,
    Wand2,
    AlertCircle,
    Settings,
    Type,
    CheckCircle2,
    BookOpen,
    ClipboardList,
    ChevronDown,
    RotateCcw,
} from "lucide-react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { TrainingSSEEvent } from "@/lib/training-generator/types";
import {
    streamTrainingGenerate,
    isApiConfigured,
    downloadMarkdown,
    copyToClipboard,
} from "@/lib/training-generator/client";
import { DEFAULT_SCRIPT_TEMPLATE, DEFAULT_RUBRIC_TEMPLATE } from "@/lib/training-generator/prompts";
import { SettingsModal } from "./SettingsModal";

type GeneratePhase = "idle" | "generating" | "completed" | "error";
type ResultTab = "script" | "rubric";

export function TrainingGenerateInterface() {
    // --- 输入状态 ---
    const [inputMode, setInputMode] = useState<"file" | "text">("file");
    const [file, setFile] = useState<File | null>(null);
    const [textContent, setTextContent] = useState("");
    const [isDragging, setIsDragging] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // --- 生成选项 ---
    const [generateScript, setGenerateScript] = useState(true);
    const [generateRubric, setGenerateRubric] = useState(true);

    // --- 生成状态 ---
    const [phase, setPhase] = useState<GeneratePhase>("idle");
    const [currentGeneratingPhase, setCurrentGeneratingPhase] = useState<"script" | "rubric" | null>(null);
    const [statusMessage, setStatusMessage] = useState("");
    const abortRef = useRef<AbortController | null>(null);

    // --- 结果（从 localStorage 恢复）---
    const CACHE_KEY = "training-generate-result";
    const loadCached = () => {
        try {
            const raw = typeof window !== "undefined" ? localStorage.getItem(CACHE_KEY) : null;
            if (!raw) return { script: "", rubric: "", name: "" };
            return JSON.parse(raw) as { script: string; rubric: string; name: string };
        } catch { return { script: "", rubric: "", name: "" }; }
    };
    const cached = loadCached();
    const [scriptContent, setScriptContent] = useState(cached.script);
    const [rubricContent, setRubricContent] = useState(cached.rubric);
    const [activeTab, setActiveTab] = useState<ResultTab>("script");
    const [taskName, setTaskName] = useState(cached.name);
    const [errorMessage, setErrorMessage] = useState("");

    // 生成完成后自动持久化
    useEffect(() => {
        if (phase === "completed" && (scriptContent || rubricContent)) {
            localStorage.setItem(CACHE_KEY, JSON.stringify({ script: scriptContent, rubric: rubricContent, name: taskName }));
        }
    }, [phase, scriptContent, rubricContent, taskName]);

    // 有缓存内容时显示 completed 状态
    useEffect(() => {
        if (phase === "idle" && (cached.script || cached.rubric)) {
            setPhase("completed");
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // --- UI ---
    const [copySuccess, setCopySuccess] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [showPromptEditor, setShowPromptEditor] = useState(false);
    const [activePromptTab, setActivePromptTab] = useState<"script" | "rubric">("script");

    // --- Prompt 模板（从 localStorage 加载）---
    const PROMPT_SETTINGS_KEY = "training-prompt-settings";
    const [scriptTemplate, setScriptTemplate] = useState<string>(() => {
        if (typeof window === "undefined") return DEFAULT_SCRIPT_TEMPLATE;
        try {
            const saved = localStorage.getItem("training-prompt-settings");
            return saved ? (JSON.parse(saved).scriptTemplate || DEFAULT_SCRIPT_TEMPLATE) : DEFAULT_SCRIPT_TEMPLATE;
        } catch { return DEFAULT_SCRIPT_TEMPLATE; }
    });
    const [rubricTemplate, setRubricTemplate] = useState<string>(() => {
        if (typeof window === "undefined") return DEFAULT_RUBRIC_TEMPLATE;
        try {
            const saved = localStorage.getItem("training-prompt-settings");
            return saved ? (JSON.parse(saved).rubricTemplate || DEFAULT_RUBRIC_TEMPLATE) : DEFAULT_RUBRIC_TEMPLATE;
        } catch { return DEFAULT_RUBRIC_TEMPLATE; }
    });

    // 自动保存 Prompt 模板到 localStorage
    useEffect(() => {
        localStorage.setItem(PROMPT_SETTINGS_KEY, JSON.stringify({ scriptTemplate, rubricTemplate }));
    }, [scriptTemplate, rubricTemplate]);

    // 获取文档内容（文本模式）或文件对象（文件模式）
    const getDocContent = useCallback(async (): Promise<{ content?: string; file?: File; name: string } | null> => {
        if (inputMode === "text") {
            if (!textContent.trim()) return null;
            return { content: textContent.trim(), name: "粘贴文档" };
        }
        if (!file) return null;
        // 文件模式：直接返回 File 对象，让服务端解析
        return { file, name: file.name };
    }, [inputMode, textContent, file]);

    const hasInput = inputMode === "text" ? textContent.trim().length > 0 : file !== null;
    const hasSelection = generateScript || generateRubric;
    const canGenerate = hasInput && hasSelection && phase !== "generating";

    // --- 开始生成 ---
    const handleGenerate = useCallback(async () => {
        if (!canGenerate) return;
        if (!isApiConfigured()) {
            setShowSettings(true);
            return;
        }

        const doc = await getDocContent();
        if (!doc) return;

        // 重置状态
        setPhase("generating");
        setScriptContent("");
        setRubricContent("");
        setErrorMessage("");
        setTaskName("");
        setStatusMessage("准备中...");
        setCurrentGeneratingPhase(null);

        const controller = new AbortController();
        abortRef.current = controller;

        // 流式临时变量
        let tempScript = "";
        let tempRubric = "";

        try {
            await streamTrainingGenerate({
                teacherDocContent: doc.content || "",
                file: doc.file,
                teacherDocName: doc.name,
                generateScript,
                generateRubric,
                scriptPromptTemplate: scriptTemplate !== DEFAULT_SCRIPT_TEMPLATE ? scriptTemplate : undefined,
                rubricPromptTemplate: rubricTemplate !== DEFAULT_RUBRIC_TEMPLATE ? rubricTemplate : undefined,
                signal: controller.signal,
                onEvent: (event: TrainingSSEEvent) => {
                    switch (event.type) {
                        case "start":
                            setCurrentGeneratingPhase(event.phase);
                            setStatusMessage(event.message || `正在生成${event.phase === "script" ? "训练剧本" : "评分标准"}...`);
                            break;

                        case "chunk":
                            if (event.phase === "script") {
                                tempScript += event.content;
                                setScriptContent(tempScript);
                            } else {
                                tempRubric += event.content;
                                setRubricContent(tempRubric);
                            }
                            break;

                        case "phase_complete":
                            if (event.phase === "script") {
                                tempScript = event.fullContent;
                                setScriptContent(event.fullContent);
                            } else {
                                tempRubric = event.fullContent;
                                setRubricContent(event.fullContent);
                            }
                            break;

                        case "complete":
                            setPhase("completed");
                            setCurrentGeneratingPhase(null);
                            setStatusMessage("");
                            setTaskName(event.taskName || "训练配置");
                            // 自动切换到有内容的 tab
                            if (event.script && !event.rubric) setActiveTab("script");
                            else if (event.rubric && !event.script) setActiveTab("rubric");
                            else setActiveTab("script");
                            break;

                        case "error":
                            setPhase("error");
                            setErrorMessage(event.message);
                            setCurrentGeneratingPhase(null);
                            setStatusMessage("");
                            break;
                    }
                },
            });
        } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") {
                setPhase(tempScript || tempRubric ? "completed" : "idle");
                setStatusMessage("");
            } else {
                setPhase("error");
                setErrorMessage(err instanceof Error ? err.message : "生成失败");
            }
        } finally {
            abortRef.current = null;
            setCurrentGeneratingPhase(null);
        }
    }, [canGenerate, getDocContent, generateScript, generateRubric]);

    const handleCancel = useCallback(() => {
        abortRef.current?.abort();
    }, []);

    const handleReset = useCallback(() => {
        setPhase("idle");
        setScriptContent("");
        setRubricContent("");
        setErrorMessage("");
        setTaskName("");
        setStatusMessage("");
        localStorage.removeItem(CACHE_KEY);
    }, []);

    // --- 文件操作 ---
    const handleFileDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        const f = e.dataTransfer.files?.[0];
        if (f) validateAndSetFile(f);
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0];
        if (f) validateAndSetFile(f);
    };

    const validateAndSetFile = (f: File) => {
        const ext = f.name.split(".").pop()?.toLowerCase();
        if (!["txt", "md", "doc", "docx"].includes(ext || "")) {
            setErrorMessage("请上传 .txt、.md、.doc 或 .docx 文件");
            return;
        }
        setFile(f);
        setErrorMessage("");
    };

    const clearFile = () => {
        setFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    // --- 复制 & 下载 ---
    const handleCopy = async () => {
        const content = activeTab === "script" ? scriptContent : rubricContent;
        if (!content) return;
        const ok = await copyToClipboard(content);
        if (ok) {
            setCopySuccess(true);
            setTimeout(() => setCopySuccess(false), 2000);
        }
    };

    const handleDownload = () => {
        const content = activeTab === "script" ? scriptContent : rubricContent;
        if (!content) return;
        const suffix = activeTab === "script" ? "训练剧本配置" : "评价标准";
        downloadMarkdown(content, `${taskName || "训练配置"}_${suffix}.md`);
    };

    // --- 渲染 ---

    const activeContent = activeTab === "script" ? scriptContent : rubricContent;

    return (
        <div className="max-w-6xl mx-auto px-4 py-8">
            {/* Header */}
            <div className="mb-8">
                <div className="flex items-center gap-3 mb-2">
                    <div className="p-2 bg-gradient-to-br from-violet-100 to-indigo-100 rounded-xl">
                        <Wand2 className="w-6 h-6 text-indigo-600" />
                    </div>
                    <h1 className="text-2xl font-bold text-slate-800">训练配置生成</h1>
                </div>
                <p className="text-slate-500 ml-[52px]">
                    上传教师文档，自动生成能力训练剧本配置和评分标准
                </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* ====== 左侧：输入区 ====== */}
                <div className="space-y-5">
                    {/* 文档输入 */}
                    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <FileText className="w-4 h-4 text-indigo-500" />
                                <span className="font-semibold text-slate-700 text-sm">教师任务文档</span>
                            </div>
                            {/* 模式切换 */}
                            <div className="flex bg-slate-100 rounded-lg p-0.5">
                                <button
                                    onClick={() => setInputMode("file")}
                                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${
                                        inputMode === "file"
                                            ? "bg-white text-indigo-600 shadow-sm"
                                            : "text-slate-500 hover:text-slate-700"
                                    }`}
                                >
                                    <Upload className="w-3.5 h-3.5" />
                                    文件
                                </button>
                                <button
                                    onClick={() => setInputMode("text")}
                                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${
                                        inputMode === "text"
                                            ? "bg-white text-indigo-600 shadow-sm"
                                            : "text-slate-500 hover:text-slate-700"
                                    }`}
                                >
                                    <Type className="w-3.5 h-3.5" />
                                    粘贴
                                </button>
                            </div>
                        </div>

                        <div className="p-5">
                            {inputMode === "file" ? (
                                /* 文件上传区 */
                                <div
                                    className={`border-2 border-dashed rounded-xl p-8 text-center transition-all cursor-pointer ${
                                        isDragging
                                            ? "border-indigo-400 bg-indigo-50"
                                            : file
                                            ? "border-emerald-300 bg-emerald-50"
                                            : "border-slate-200 hover:border-indigo-300 hover:bg-slate-50"
                                    }`}
                                    onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                                    onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
                                    onDrop={handleFileDrop}
                                    onClick={() => !file && fileInputRef.current?.click()}
                                >
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept=".txt,.md,.doc,.docx"
                                        onChange={handleFileChange}
                                        className="hidden"
                                    />
                                    {file ? (
                                        <div className="space-y-2">
                                            <div className="w-12 h-12 bg-emerald-100 rounded-xl flex items-center justify-center mx-auto">
                                                <Check className="w-6 h-6 text-emerald-600" />
                                            </div>
                                            <p className="font-semibold text-slate-700">{file.name}</p>
                                            <p className="text-xs text-emerald-600 font-medium">文件已就绪</p>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); clearFile(); }}
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-500 hover:text-red-500 bg-white border border-slate-200 hover:border-red-200 rounded-lg transition-colors"
                                            >
                                                <X className="w-3.5 h-3.5" />
                                                移除
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            <div className="w-12 h-12 bg-slate-100 rounded-xl flex items-center justify-center mx-auto">
                                                <Upload className="w-6 h-6 text-slate-400" />
                                            </div>
                                            <p className="text-sm text-slate-600">
                                                拖放文件到此处，或 <span className="text-indigo-600 font-medium">点击选择</span>
                                            </p>
                                            <p className="text-xs text-slate-400">支持 .txt / .md / .doc / .docx</p>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                /* 文本粘贴区 */
                                <textarea
                                    value={textContent}
                                    onChange={(e) => setTextContent(e.target.value)}
                                    placeholder="将教师任务文档内容粘贴到此处..."
                                    className="w-full h-48 p-4 border border-slate-200 rounded-xl text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300 resize-none transition-all"
                                />
                            )}
                        </div>
                    </div>

                    {/* 生成选项 */}
                    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
                        <p className="text-sm font-semibold text-slate-700 mb-3">生成内容</p>
                        <div className="flex flex-col sm:flex-row gap-3">
                            <label
                                className={`flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer transition-all flex-1 ${
                                    generateScript
                                        ? "border-violet-300 bg-violet-50"
                                        : "border-slate-200 hover:border-slate-300"
                                }`}
                            >
                                <input
                                    type="checkbox"
                                    checked={generateScript}
                                    onChange={(e) => setGenerateScript(e.target.checked)}
                                    className="sr-only"
                                />
                                <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${
                                    generateScript ? "bg-violet-500 border-violet-500" : "border-slate-300"
                                }`}>
                                    {generateScript && <Check className="w-3.5 h-3.5 text-white" />}
                                </div>
                                <div>
                                    <div className="flex items-center gap-1.5">
                                        <BookOpen className="w-4 h-4 text-violet-500" />
                                        <span className="text-sm font-medium text-slate-700">训练剧本配置</span>
                                    </div>
                                    <p className="text-xs text-slate-400 mt-0.5">阶段划分、提示词、状态机逻辑</p>
                                </div>
                            </label>

                            <label
                                className={`flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer transition-all flex-1 ${
                                    generateRubric
                                        ? "border-amber-300 bg-amber-50"
                                        : "border-slate-200 hover:border-slate-300"
                                }`}
                            >
                                <input
                                    type="checkbox"
                                    checked={generateRubric}
                                    onChange={(e) => setGenerateRubric(e.target.checked)}
                                    className="sr-only"
                                />
                                <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${
                                    generateRubric ? "bg-amber-500 border-amber-500" : "border-slate-300"
                                }`}>
                                    {generateRubric && <Check className="w-3.5 h-3.5 text-white" />}
                                </div>
                                <div>
                                    <div className="flex items-center gap-1.5">
                                        <ClipboardList className="w-4 h-4 text-amber-500" />
                                        <span className="text-sm font-medium text-slate-700">评分标准</span>
                                    </div>
                                    <p className="text-xs text-slate-400 mt-0.5">层级化得分点、评判标准</p>
                                </div>
                            </label>
                        </div>
                    </div>
                    {/* 自定义 Prompt 编辑区 */}
                    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                        <button
                            type="button"
                            onClick={() => setShowPromptEditor(v => !v)}
                            className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-slate-50 transition-colors"
                        >
                            <span className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                                <Settings className="w-4 h-4 text-slate-400" />
                                自定义 Prompt 模板
                                {(scriptTemplate !== DEFAULT_SCRIPT_TEMPLATE || rubricTemplate !== DEFAULT_RUBRIC_TEMPLATE) && (
                                    <span className="px-1.5 py-0.5 bg-violet-100 text-violet-600 text-xs rounded-full">已修改</span>
                                )}
                            </span>
                            <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${showPromptEditor ? "rotate-180" : ""}`} />
                        </button>

                        {showPromptEditor && (
                            <div className="border-t border-slate-100">
                                {/* Tab 切换 */}
                                <div className="flex border-b border-slate-100">
                                    <button
                                        type="button"
                                        onClick={() => setActivePromptTab("script")}
                                        className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                                            activePromptTab === "script"
                                                ? "text-violet-600 border-b-2 border-violet-500 bg-violet-50/50"
                                                : "text-slate-500 hover:text-slate-700"
                                        }`}
                                    >
                                        <BookOpen className="w-3.5 h-3.5 inline mr-1.5" />
                                        剧本配置 Prompt
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setActivePromptTab("rubric")}
                                        className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                                            activePromptTab === "rubric"
                                                ? "text-amber-600 border-b-2 border-amber-500 bg-amber-50/50"
                                                : "text-slate-500 hover:text-slate-700"
                                        }`}
                                    >
                                        <ClipboardList className="w-3.5 h-3.5 inline mr-1.5" />
                                        评分标准 Prompt
                                    </button>
                                </div>

                                <div className="p-4 space-y-3">
                                    <p className="text-xs text-slate-500">
                                        使用 <code className="bg-slate-100 px-1 py-0.5 rounded text-violet-600">{'{teacherDoc}'}</code> 作为文档内容占位符，生成时会自动替换
                                    </p>
                                    {activePromptTab === "script" ? (
                                        <>
                                            <textarea
                                                value={scriptTemplate}
                                                onChange={(e) => setScriptTemplate(e.target.value)}
                                                rows={18}
                                                className="w-full p-3 border border-slate-200 rounded-xl text-xs font-mono text-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-300 resize-y transition-all"
                                                spellCheck={false}
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setScriptTemplate(DEFAULT_SCRIPT_TEMPLATE)}
                                                className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 transition-colors"
                                            >
                                                <RotateCcw className="w-3 h-3" />
                                                恢复默认
                                            </button>
                                        </>
                                    ) : (
                                        <>
                                            <textarea
                                                value={rubricTemplate}
                                                onChange={(e) => setRubricTemplate(e.target.value)}
                                                rows={18}
                                                className="w-full p-3 border border-slate-200 rounded-xl text-xs font-mono text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-300 resize-y transition-all"
                                                spellCheck={false}
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setRubricTemplate(DEFAULT_RUBRIC_TEMPLATE)}
                                                className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 transition-colors"
                                            >
                                                <RotateCcw className="w-3 h-3" />
                                                恢复默认
                                            </button>
                                        </>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                    {/* 操作按钮 */}
                    <div className="flex gap-3">
                        {phase === "generating" ? (
                            <button
                                onClick={handleCancel}
                                className="flex-1 inline-flex items-center justify-center gap-2 px-6 py-3 bg-red-50 text-red-600 font-semibold rounded-xl border border-red-200 hover:bg-red-100 transition-all"
                            >
                                <X className="w-4 h-4" />
                                取消生成
                            </button>
                        ) : (
                            <button
                                onClick={handleGenerate}
                                disabled={!canGenerate}
                                className="flex-1 inline-flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-indigo-600 to-violet-600 text-white font-semibold rounded-xl hover:from-indigo-700 hover:to-violet-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-indigo-200/50 disabled:shadow-none"
                            >
                                <Wand2 className="w-4 h-4" />
                                开始生成
                            </button>
                        )}

                        <button
                            onClick={() => setShowSettings(true)}
                            className="px-4 py-3 bg-white text-slate-600 font-medium rounded-xl border border-slate-200 hover:bg-slate-50 hover:text-indigo-600 transition-all"
                            title="API 设置"
                        >
                            <Settings className="w-4 h-4" />
                        </button>
                    </div>

                    {/* 未配置 API 提示 */}
                    {!isApiConfigured() && (
                        <div className="flex items-start gap-2.5 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                            <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                            <p className="text-xs text-amber-700">
                                请先点击右侧设置按钮配置 API Key 和 API 地址，才能使用生成功能。
                            </p>
                        </div>
                    )}
                </div>

                {/* ====== 右侧：结果展示区 ====== */}
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col min-h-[500px]">
                    {/* Tab 切换头 */}
                    <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                        <div className="flex gap-1 bg-slate-100 rounded-lg p-0.5">
                            {generateScript && (
                                <button
                                    onClick={() => setActiveTab("script")}
                                    className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${
                                        activeTab === "script"
                                            ? "bg-white text-violet-600 shadow-sm"
                                            : "text-slate-500 hover:text-slate-700"
                                    }`}
                                >
                                    <BookOpen className="w-3.5 h-3.5" />
                                    训练剧本
                                    {scriptContent && phase === "completed" && (
                                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                                    )}
                                </button>
                            )}
                            {generateRubric && (
                                <button
                                    onClick={() => setActiveTab("rubric")}
                                    className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${
                                        activeTab === "rubric"
                                            ? "bg-white text-amber-600 shadow-sm"
                                            : "text-slate-500 hover:text-slate-700"
                                    }`}
                                >
                                    <ClipboardList className="w-3.5 h-3.5" />
                                    评分标准
                                    {rubricContent && phase === "completed" && (
                                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                                    )}
                                </button>
                            )}
                        </div>

                        {/* 操作按钮 */}
                        {activeContent && phase === "completed" && (
                            <div className="flex items-center gap-1.5">
                                <button
                                    onClick={handleCopy}
                                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:text-indigo-600 bg-slate-50 hover:bg-indigo-50 rounded-lg transition-colors"
                                    title="复制内容"
                                >
                                    {copySuccess ? (
                                        <>
                                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                                            <span className="text-emerald-600">已复制</span>
                                        </>
                                    ) : (
                                        <>
                                            <Copy className="w-3.5 h-3.5" />
                                            复制
                                        </>
                                    )}
                                </button>
                                <button
                                    onClick={handleDownload}
                                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:text-indigo-600 bg-slate-50 hover:bg-indigo-50 rounded-lg transition-colors"
                                    title="下载 .md 文件"
                                >
                                    <Download className="w-3.5 h-3.5" />
                                    下载
                                </button>
                                <button
                                    onClick={handleReset}
                                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:text-indigo-600 bg-slate-50 hover:bg-indigo-50 rounded-lg transition-colors"
                                    title="重新生成"
                                >
                                    <RefreshCw className="w-3.5 h-3.5" />
                                    重新生成
                                </button>
                            </div>
                        )}
                    </div>

                    {/* 内容区 */}
                    <div className="flex-1 overflow-y-auto p-5">
                        {phase === "idle" && !activeContent && (
                            <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-3">
                                <div className="w-16 h-16 bg-slate-50 rounded-2xl flex items-center justify-center">
                                    <Wand2 className="w-8 h-8 text-slate-300" />
                                </div>
                                <p className="text-sm">上传文档后点击「开始生成」</p>
                                <p className="text-xs">生成结果将在此处实时展示</p>
                            </div>
                        )}

                        {phase === "generating" && (
                            <div className="space-y-4">
                                {/* 进度指示 */}
                                <div className="flex items-center gap-3 p-3 bg-indigo-50 border border-indigo-100 rounded-xl">
                                    <Loader2 className="w-4 h-4 text-indigo-500 animate-spin flex-shrink-0" />
                                    <div>
                                        <p className="text-sm font-medium text-indigo-700">{statusMessage}</p>
                                        <div className="flex items-center gap-2 mt-1">
                                            {generateScript && (
                                                <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${
                                                    currentGeneratingPhase === "script"
                                                        ? "bg-violet-100 text-violet-600"
                                                        : scriptContent
                                                        ? "bg-emerald-100 text-emerald-600"
                                                        : "bg-slate-100 text-slate-400"
                                                }`}>
                                                    {currentGeneratingPhase === "script" ? (
                                                        <Loader2 className="w-3 h-3 animate-spin" />
                                                    ) : scriptContent ? (
                                                        <Check className="w-3 h-3" />
                                                    ) : null}
                                                    剧本
                                                </span>
                                            )}
                                            {generateRubric && (
                                                <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${
                                                    currentGeneratingPhase === "rubric"
                                                        ? "bg-amber-100 text-amber-600"
                                                        : rubricContent
                                                        ? "bg-emerald-100 text-emerald-600"
                                                        : "bg-slate-100 text-slate-400"
                                                }`}>
                                                    {currentGeneratingPhase === "rubric" ? (
                                                        <Loader2 className="w-3 h-3 animate-spin" />
                                                    ) : rubricContent ? (
                                                        <Check className="w-3 h-3" />
                                                    ) : null}
                                                    评分
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {/* 流式内容 */}
                                {activeContent && (
                                    <MarkdownRenderer content={activeContent} className="animate-in fade-in" />
                                )}
                            </div>
                        )}

                        {phase === "completed" && activeContent && (
                            <MarkdownRenderer content={activeContent} />
                        )}

                        {phase === "completed" && !activeContent && (
                            <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-2">
                                <p className="text-sm">当前选项卡无内容</p>
                                <p className="text-xs">请切换到另一个选项卡查看</p>
                            </div>
                        )}

                        {phase === "error" && (
                            <div className="flex flex-col items-center justify-center h-full gap-4">
                                <div className="w-16 h-16 bg-red-50 rounded-2xl flex items-center justify-center">
                                    <AlertCircle className="w-8 h-8 text-red-400" />
                                </div>
                                <div className="text-center">
                                    <p className="text-sm font-medium text-red-600 mb-1">生成失败</p>
                                    <p className="text-xs text-red-400">{errorMessage}</p>
                                </div>
                                <button
                                    onClick={handleReset}
                                    className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors"
                                >
                                    <RefreshCw className="w-4 h-4" />
                                    重试
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* 设置弹窗 */}
            <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
        </div>
    );
}
