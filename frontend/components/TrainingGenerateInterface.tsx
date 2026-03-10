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
    Save,
    Globe,
    Lock,
    Sparkles,
} from "lucide-react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { TrainingSSEEvent, PromptTemplate } from "@/lib/training-generator/types";
import {
    streamTrainingGenerate,
    isApiConfigured,
    downloadMarkdown,
    copyToClipboard,
} from "@/lib/training-generator/client";
import { DEFAULT_SCRIPT_TEMPLATE, DEFAULT_RUBRIC_TEMPLATE, TEMPLATE_VERSION } from "@/lib/training-generator/prompts";
import { SettingsModal } from "./SettingsModal";
import { InjectConfigModal } from "./InjectConfigModal";

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
    const [showInjectModal, setShowInjectModal] = useState(false);
    const [showPromptEditor, setShowPromptEditor] = useState(false);
    const [activePromptTab, setActivePromptTab] = useState<"script" | "rubric">("script");

    // --- Prompt 模板（数据库 + localStorage fallback） ---
    const PROMPT_SETTINGS_KEY = "training-prompt-settings";
    const [scriptTemplate, setScriptTemplate] = useState<string>(() => {
        if (typeof window === "undefined") return DEFAULT_SCRIPT_TEMPLATE;
        try {
            const saved = localStorage.getItem(PROMPT_SETTINGS_KEY);
            if (!saved) return DEFAULT_SCRIPT_TEMPLATE;
            const parsed = JSON.parse(saved);
            // 版本不匹配 → 默认模板已更新，丢弃旧缓存
            if (parsed._v !== TEMPLATE_VERSION) return DEFAULT_SCRIPT_TEMPLATE;
            return parsed.scriptTemplate || DEFAULT_SCRIPT_TEMPLATE;
        } catch { return DEFAULT_SCRIPT_TEMPLATE; }
    });
    const [rubricTemplate, setRubricTemplate] = useState<string>(() => {
        if (typeof window === "undefined") return DEFAULT_RUBRIC_TEMPLATE;
        try {
            const saved = localStorage.getItem(PROMPT_SETTINGS_KEY);
            if (!saved) return DEFAULT_RUBRIC_TEMPLATE;
            const parsed = JSON.parse(saved);
            if (parsed._v !== TEMPLATE_VERSION) return DEFAULT_RUBRIC_TEMPLATE;
            return parsed.rubricTemplate || DEFAULT_RUBRIC_TEMPLATE;
        } catch { return DEFAULT_RUBRIC_TEMPLATE; }
    });

    // localStorage 持久化（附带版本号）
    useEffect(() => {
        localStorage.setItem(PROMPT_SETTINGS_KEY, JSON.stringify({ scriptTemplate, rubricTemplate, _v: TEMPLATE_VERSION }));
    }, [scriptTemplate, rubricTemplate]);

    // --- 数据库模板列表 ---
    const [dbTemplates, setDbTemplates] = useState<PromptTemplate[]>([]);
    const [selectedScriptTemplateId, setSelectedScriptTemplateId] = useState<string>("default");
    const [selectedRubricTemplateId, setSelectedRubricTemplateId] = useState<string>("default");
    const [templateLoading, setTemplateLoading] = useState(false);
    const [saveModalOpen, setSaveModalOpen] = useState(false);
    const [saveName, setSaveName] = useState("");
    const [saveDesc, setSaveDesc] = useState("");
    const [savePublic, setSavePublic] = useState(false);
    const [saveTags, setSaveTags] = useState("");
    const [saving, setSaving] = useState(false);

    // 加载数据库模板列表
    const loadTemplates = useCallback(async () => {
        setTemplateLoading(true);
        try {
            const res = await fetch("/api/prompt-templates");
            if (res.ok) {
                const data = await res.json();
                setDbTemplates(data.templates || []);
            }
        } catch {
            // 静默失败（Supabase 未配置时）
        } finally {
            setTemplateLoading(false);
        }
    }, []);

    useEffect(() => { loadTemplates(); }, [loadTemplates]);

    // 从模板市场跳转过来时，自动加载指定模板
    useEffect(() => {
        const raw = sessionStorage.getItem("use-prompt-template");
        if (!raw) return;
        sessionStorage.removeItem("use-prompt-template");
        try {
            const { id, type } = JSON.parse(raw) as { id: string; type: string };
            if (id && type && dbTemplates.length > 0) {
                handleSelectTemplate(id, type as "script" | "rubric");
                setActivePromptTab(type as "script" | "rubric");
                setShowPromptEditor(true);
            }
        } catch { /* ignore */ }
    }, [dbTemplates]); // eslint-disable-line react-hooks/exhaustive-deps

    // 选择模板时填充 textarea
    const handleSelectTemplate = (templateId: string, tab: "script" | "rubric") => {
        if (tab === "script") {
            setSelectedScriptTemplateId(templateId);
        } else {
            setSelectedRubricTemplateId(templateId);
        }

        if (templateId === "default") {
            if (tab === "script") setScriptTemplate(DEFAULT_SCRIPT_TEMPLATE);
            else setRubricTemplate(DEFAULT_RUBRIC_TEMPLATE);
            return;
        }

        const tpl = dbTemplates.find(t => t.id === templateId);
        if (tpl) {
            if (tab === "script") setScriptTemplate(tpl.prompt_template);
            else setRubricTemplate(tpl.prompt_template);
            // 递增使用计数（fire-and-forget）
            fetch(`/api/prompt-templates/${tpl.id}/use`, { method: "POST" }).catch(() => { });
        }
    };

    // 另存为我的模板
    const handleSaveTemplate = async () => {
        if (!saveName.trim()) return;
        setSaving(true);
        try {
            const type = activePromptTab;
            const template = type === "script" ? scriptTemplate : rubricTemplate;
            const res = await fetch("/api/prompt-templates", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: saveName.trim(),
                    description: saveDesc.trim() || undefined,
                    type,
                    prompt_template: template,
                    is_public: savePublic,
                    tags: saveTags.split(/[,，\s]+/).filter(Boolean),
                }),
            });
            if (res.ok) {
                setSaveModalOpen(false);
                setSaveName("");
                setSaveDesc("");
                setSavePublic(false);
                setSaveTags("");
                await loadTemplates();
            } else {
                const err = await res.json();
                alert(err.error || "保存失败");
            }
        } catch {
            alert("保存失败");
        } finally {
            setSaving(false);
        }
    };

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

        // 重置状态（只清除本次要生成的内容）
        setPhase("generating");
        if (generateScript) setScriptContent("");
        if (generateRubric) setRubricContent("");
        setErrorMessage("");
        if (generateScript) setTaskName(""); // 仅生成剧本时才重置任务名
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

    // --- 重新生成逻辑 ---
    const [regenContext, setRegenContext] = useState("");
    const [isRegenerating, setIsRegenerating] = useState(false);
    const [regenScript, setRegenScript] = useState(true);
    const [regenRubric, setRegenRubric] = useState(true);

    const handleRegenerate = async () => {
        if (!regenContext.trim()) return;
        if (!isApiConfigured()) {
            setShowSettings(true);
            return;
        }

        const shouldRegenScript = regenScript && generateScript;
        const shouldRegenRubric = regenRubric && generateRubric;
        if (!shouldRegenScript && !shouldRegenRubric) return;

        // 构建重新生成的文档内容：
        // 将已有的生成结果 + 用户的修改意见一起发给 LLM
        // 这样 LLM 可以在已有结果的基础上进行修改，而不是从头生成
        let regenDocContent = "";

        // 先获取原始文档内容作为基础上下文
        if (inputMode === "text" && textContent.trim()) {
            regenDocContent += textContent.trim();
        } else if (file) {
            // 文件模式：读取文件文本内容
            try {
                regenDocContent += await file.text();
            } catch {
                regenDocContent += `（原始文档：${file.name}）`;
            }
        }

        // 附加已生成的内容供 LLM 参考
        if (shouldRegenScript && scriptContent) {
            regenDocContent += `\n\n【以下是之前生成的训练剧本配置，请在此基础上根据用户要求进行修改】：\n${scriptContent}`;
        }
        if (shouldRegenRubric && rubricContent) {
            regenDocContent += `\n\n【以下是之前生成的评分标准配置，请在此基础上根据用户要求进行修改】：\n${rubricContent}`;
        }

        // 附加用户的修改意见
        regenDocContent += `\n\n【用户的修改要求，请严格按照以下指示修改上面的内容】：\n${regenContext}`;

        // 设置状态
        setPhase("generating");
        if (shouldRegenScript) setScriptContent("");
        if (shouldRegenRubric) setRubricContent("");
        setErrorMessage("");
        setStatusMessage("准备重新生成...");
        setCurrentGeneratingPhase(null);
        setIsRegenerating(true);

        const controller = new AbortController();
        abortRef.current = controller;

        let tempScript = shouldRegenScript ? "" : scriptContent;
        let tempRubric = shouldRegenRubric ? "" : rubricContent;

        try {
            // 始终使用文本模式发送（不再重新上传文件）
            await streamTrainingGenerate({
                teacherDocContent: regenDocContent,
                teacherDocName: taskName || "重新生成",
                generateScript: shouldRegenScript,
                generateRubric: shouldRegenRubric,
                scriptPromptTemplate: scriptTemplate !== DEFAULT_SCRIPT_TEMPLATE ? scriptTemplate : undefined,
                rubricPromptTemplate: rubricTemplate !== DEFAULT_RUBRIC_TEMPLATE ? rubricTemplate : undefined,
                signal: controller.signal,
                onEvent: (event: TrainingSSEEvent) => {
                    switch (event.type) {
                        case "start":
                            setCurrentGeneratingPhase(event.phase);
                            setStatusMessage(event.message || `正在重新生成${event.phase === "script" ? "训练剧本" : "评分标准"}...`);
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
                            setTaskName(event.taskName || taskName || "训练配置");
                            if (shouldRegenScript && !shouldRegenRubric) setActiveTab("script");
                            else if (shouldRegenRubric && !shouldRegenScript) setActiveTab("rubric");
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
                setErrorMessage(err instanceof Error ? err.message : "重新生成失败");
            }
        } finally {
            abortRef.current = null;
            setCurrentGeneratingPhase(null);
            setIsRegenerating(false);
            setRegenContext("");
        }
    };

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
                                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${inputMode === "file"
                                        ? "bg-white text-indigo-600 shadow-sm"
                                        : "text-slate-500 hover:text-slate-700"
                                        }`}
                                >
                                    <Upload className="w-3.5 h-3.5" />
                                    文件
                                </button>
                                <button
                                    onClick={() => setInputMode("text")}
                                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${inputMode === "text"
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
                                    className={`border-2 border-dashed rounded-xl p-8 text-center transition-all cursor-pointer ${isDragging
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
                                className={`flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer transition-all flex-1 ${generateScript
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
                                <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${generateScript ? "bg-violet-500 border-violet-500" : "border-slate-300"
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
                                className={`flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer transition-all flex-1 ${generateRubric
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
                                <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${generateRubric ? "bg-amber-500 border-amber-500" : "border-slate-300"
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
                                <Sparkles className="w-4 h-4 text-indigo-400" />
                                Prompt 模板
                                {(scriptTemplate !== DEFAULT_SCRIPT_TEMPLATE || rubricTemplate !== DEFAULT_RUBRIC_TEMPLATE) && (
                                    <span className="px-1.5 py-0.5 bg-violet-100 text-violet-600 text-xs rounded-full">已修改</span>
                                )}
                                {dbTemplates.length > 0 && (
                                    <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 text-xs rounded-full">{dbTemplates.length} 个可用</span>
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
                                        className={`flex-1 py-2.5 text-sm font-medium transition-colors ${activePromptTab === "script"
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
                                        className={`flex-1 py-2.5 text-sm font-medium transition-colors ${activePromptTab === "rubric"
                                            ? "text-amber-600 border-b-2 border-amber-500 bg-amber-50/50"
                                            : "text-slate-500 hover:text-slate-700"
                                            }`}
                                    >
                                        <ClipboardList className="w-3.5 h-3.5 inline mr-1.5" />
                                        评分标准 Prompt
                                    </button>
                                </div>

                                <div className="p-4 space-y-3">
                                    {/* 模板选择器 */}
                                    <div className="flex items-center gap-2">
                                        <select
                                            value={activePromptTab === "script" ? selectedScriptTemplateId : selectedRubricTemplateId}
                                            onChange={(e) => handleSelectTemplate(e.target.value, activePromptTab)}
                                            className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-xs text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                                            disabled={templateLoading}
                                        >
                                            <option value="default">内置默认模板</option>
                                            {dbTemplates
                                                .filter(t => t.type === activePromptTab)
                                                .map(t => (
                                                    <option key={t.id} value={t.id}>
                                                        {t.is_default ? "⭐ " : t.is_public ? "🌐 " : "🔒 "}
                                                        {t.name}
                                                        {t.creator_name ? ` — ${t.creator_name}` : t.is_default ? " — 系统内置" : ""}
                                                        {t.use_count > 0 ? ` (${t.use_count}次)` : ""}
                                                    </option>
                                                ))
                                            }
                                        </select>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setSaveName("");
                                                setSaveDesc("");
                                                setSavePublic(false);
                                                setSaveTags("");
                                                setSaveModalOpen(true);
                                            }}
                                            className="flex items-center gap-1 px-3 py-2 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors whitespace-nowrap"
                                            title="另存为我的模板"
                                        >
                                            <Save className="w-3.5 h-3.5" />
                                            另存
                                        </button>
                                    </div>

                                    <p className="text-xs text-slate-500">
                                        使用 <code className="bg-slate-100 px-1 py-0.5 rounded text-violet-600">{'{teacherDoc}'}</code> 作为文档内容占位符，生成时会自动替换
                                    </p>

                                    {activePromptTab === "script" ? (
                                        <>
                                            <textarea
                                                value={scriptTemplate}
                                                onChange={(e) => {
                                                    setScriptTemplate(e.target.value);
                                                    setSelectedScriptTemplateId("custom");
                                                }}
                                                rows={18}
                                                className="w-full p-3 border border-slate-200 rounded-xl text-xs font-mono text-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-300 resize-y transition-all"
                                                spellCheck={false}
                                            />
                                            <button
                                                type="button"
                                                onClick={() => { setScriptTemplate(DEFAULT_SCRIPT_TEMPLATE); setSelectedScriptTemplateId("default"); }}
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
                                                onChange={(e) => {
                                                    setRubricTemplate(e.target.value);
                                                    setSelectedRubricTemplateId("custom");
                                                }}
                                                rows={18}
                                                className="w-full p-3 border border-slate-200 rounded-xl text-xs font-mono text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-300 resize-y transition-all"
                                                spellCheck={false}
                                            />
                                            <button
                                                type="button"
                                                onClick={() => { setRubricTemplate(DEFAULT_RUBRIC_TEMPLATE); setSelectedRubricTemplateId("default"); }}
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

                    {/* 保存模板弹窗 */}
                    {saveModalOpen && (
                        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setSaveModalOpen(false)}>
                            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95" onClick={e => e.stopPropagation()}>
                                <div className="bg-gradient-to-r from-indigo-600 to-violet-600 p-4 text-white">
                                    <h3 className="font-bold text-lg flex items-center gap-2">
                                        <Save className="w-5 h-5" />
                                        保存为 Prompt 模板
                                    </h3>
                                    <p className="text-indigo-100 text-sm mt-1">
                                        当前编辑的 {activePromptTab === "script" ? "剧本配置" : "评分标准"} Prompt
                                    </p>
                                </div>
                                <div className="p-5 space-y-4">
                                    <div>
                                        <label className="text-sm font-medium text-slate-700 block mb-1">模板名称 *</label>
                                        <input
                                            type="text"
                                            value={saveName}
                                            onChange={e => setSaveName(e.target.value)}
                                            placeholder="例如：心理咨询场景专用模板"
                                            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-sm font-medium text-slate-700 block mb-1">简介</label>
                                        <input
                                            type="text"
                                            value={saveDesc}
                                            onChange={e => setSaveDesc(e.target.value)}
                                            placeholder="简短描述模板的适用场景"
                                            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-sm font-medium text-slate-700 block mb-1">标签（逗号分隔）</label>
                                        <input
                                            type="text"
                                            value={saveTags}
                                            onChange={e => setSaveTags(e.target.value)}
                                            placeholder="例如：心理咨询, 护理, 贸易"
                                            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                                        />
                                    </div>
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={savePublic}
                                            onChange={e => setSavePublic(e.target.checked)}
                                            className="sr-only"
                                        />
                                        <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${savePublic ? "bg-indigo-500 border-indigo-500" : "border-slate-300"
                                            }`}>
                                            {savePublic && <Check className="w-3.5 h-3.5 text-white" />}
                                        </div>
                                        <span className="text-sm text-slate-700 flex items-center gap-1.5">
                                            {savePublic ? <Globe className="w-3.5 h-3.5 text-emerald-500" /> : <Lock className="w-3.5 h-3.5 text-slate-400" />}
                                            {savePublic ? "公开（所有用户可见可用）" : "私有（仅自己可见）"}
                                        </span>
                                    </label>
                                </div>
                                <div className="flex gap-3 p-5 pt-0">
                                    <button
                                        onClick={() => setSaveModalOpen(false)}
                                        className="flex-1 px-4 py-2.5 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                                    >
                                        取消
                                    </button>
                                    <button
                                        onClick={handleSaveTemplate}
                                        disabled={!saveName.trim() || saving}
                                        className="flex-1 px-4 py-2.5 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-lg transition-colors flex items-center justify-center gap-1.5"
                                    >
                                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                                        {saving ? "保存中..." : "保存模板"}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
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
                    <div className="px-5 py-3 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4 overflow-x-auto">
                        <div className="flex gap-1.5 p-1 bg-slate-100/80 rounded-xl shrink-0">
                            {generateScript && (
                                <button
                                    onClick={() => setActiveTab("script")}
                                    className={`px-3 py-2 text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-1.5 whitespace-nowrap ${activeTab === "script"
                                        ? "bg-white text-violet-700 shadow-sm ring-1 ring-slate-200/50"
                                        : "text-slate-500 hover:text-slate-700 hover:bg-slate-200/50"
                                        }`}
                                >
                                    <BookOpen className="w-4 h-4 shrink-0" />
                                    <span>训练剧本</span>
                                    {scriptContent && phase === "completed" && (
                                        <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                                    )}
                                </button>
                            )}
                            {generateRubric && (
                                <button
                                    onClick={() => setActiveTab("rubric")}
                                    className={`flex-1 px-4 py-2.5 text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2 whitespace-nowrap ${activeTab === "rubric"
                                        ? "bg-white text-amber-700 shadow-sm ring-1 ring-slate-200/50"
                                        : "text-slate-500 hover:text-slate-700 hover:bg-slate-200/50"
                                        }`}
                                >
                                    <ClipboardList className="w-4 h-4 shrink-0" />
                                    <span>评分标准</span>
                                    {rubricContent && phase === "completed" && (
                                        <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                                    )}
                                </button>
                            )}
                        </div>

                        {/* 操作按钮 */}
                        {activeContent && phase === "completed" && (
                            <div className="flex items-center gap-1.5 shrink-0">
                                <button
                                    onClick={() => setShowInjectModal(true)}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 rounded-lg shadow-sm shadow-indigo-200 transition-all hover:-translate-y-0.5"
                                    title="一键注入到平台"
                                >
                                    🚀 一键注入
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
                                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:text-rose-600 bg-slate-50 hover:bg-rose-50 rounded-lg transition-colors"
                                    title="重新开始"
                                >
                                    <RefreshCw className="w-3.5 h-3.5" />
                                    重置
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
                                                <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${currentGeneratingPhase === "script"
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
                                                <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${currentGeneratingPhase === "rubric"
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

                    {/* 重新生成带有提示词输入的区域 */}
                    {phase === "completed" && activeContent && (
                        <div className="border-t border-slate-100 bg-slate-50/50 p-4">
                            <div className="flex flex-col gap-3">
                                <div className="flex items-center justify-between">
                                    <label className="text-xs font-medium text-slate-500 flex items-center gap-1.5">
                                        <Sparkles className="w-3 h-3 text-indigo-500" />
                                        对结果不满意？输入修改意见重新生成
                                    </label>
                                    <div className="flex items-center gap-3">
                                        {generateScript && (
                                            <label className="flex items-center gap-1.5 cursor-pointer text-xs">
                                                <input
                                                    type="checkbox"
                                                    checked={regenScript}
                                                    onChange={(e) => setRegenScript(e.target.checked)}
                                                    className="w-3.5 h-3.5 rounded border-slate-300 text-violet-600 focus:ring-violet-500"
                                                />
                                                <span className={regenScript ? "text-violet-600 font-medium" : "text-slate-400"}>训练剧本</span>
                                            </label>
                                        )}
                                        {generateRubric && (
                                            <label className="flex items-center gap-1.5 cursor-pointer text-xs">
                                                <input
                                                    type="checkbox"
                                                    checked={regenRubric}
                                                    onChange={(e) => setRegenRubric(e.target.checked)}
                                                    className="w-3.5 h-3.5 rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                                                />
                                                <span className={regenRubric ? "text-amber-600 font-medium" : "text-slate-400"}>评分标准</span>
                                            </label>
                                        )}
                                    </div>
                                </div>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        placeholder="例如：把打分标准变得更严格一些，或者添加几个更复杂的测试案例..."
                                        value={regenContext}
                                        onChange={(e) => setRegenContext(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter" && !e.shiftKey) {
                                                e.preventDefault();
                                                handleRegenerate();
                                            }
                                        }}
                                        disabled={isRegenerating}
                                        className="flex-1 px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all placeholder:text-slate-400 disabled:opacity-50"
                                    />
                                    <button
                                        onClick={handleRegenerate}
                                        disabled={isRegenerating || !regenContext.trim() || (!regenScript && !regenRubric)}
                                        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-slate-800 hover:bg-slate-900 rounded-lg transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                                    >
                                        {isRegenerating ? (
                                            <>
                                                <Loader2 className="w-4 h-4 animate-spin" />
                                                生成中...
                                            </>
                                        ) : (
                                            <>
                                                <RotateCcw className="w-4 h-4" />
                                                重新配置
                                            </>
                                        )}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* 设置弹窗 */}
            <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />

            {/* 一键注入配置弹窗 */}
            <InjectConfigModal
                isOpen={showInjectModal}
                onClose={() => setShowInjectModal(false)}
                scriptMarkdown={scriptContent}
                rubricMarkdown={rubricContent}
            />
        </div>
    );
}
