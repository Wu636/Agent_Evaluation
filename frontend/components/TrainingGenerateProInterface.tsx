"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  Upload,
  FileText,
  X,
  Loader2,
  Download,
  Copy,
  RefreshCw,
  Wand2,
  AlertCircle,
  CheckCircle2,
  Check,
  Sparkles,
  BookOpen,
  Type,
  Lightbulb,
  ChevronDown,
  RotateCcw,
  Save,
  Globe,
  Lock,
} from "lucide-react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ProTrainingSSEEvent } from "@/lib/training-generator-pro/types";
import {
  streamProTrainingGenerate,
  isProApiConfigured,
  downloadProMarkdown,
} from "@/lib/training-generator-pro/client";
import { SettingsModal } from "./SettingsModal";
import { InjectConfigProModal } from "./InjectConfigProModal";
import type { PromptTemplate } from "@/lib/training-generator/types";
import {
  isProPromptTemplate,
  PRO_PROMPT_TEMPLATE_TAG,
  PRO_SCRIPT_TEMPLATE,
  PRO_TEMPLATE_VERSION,
} from "@/lib/training-generator-pro/prompts";

type GeneratePhase = "idle" | "generating" | "completed" | "error";

const PRO_DRAFT_STORAGE_KEY = "training-generator-pro-draft-v1";
const PRO_INPUT_DB_NAME = "training-generator-pro-cache";
const PRO_INPUT_DB_VERSION = 1;
const PRO_INPUT_STORE_NAME = "inputs";
const PRO_INPUT_RECORD_KEY = "latest";
const PRO_PROMPT_SETTINGS_KEY = "training-generator-pro-prompt-settings";

interface ProGeneratorDraft {
  inputMode: "file" | "text";
  teacherDocContent: string;
  teacherDocName: string;
  userGenerationAdvice: string;
  generatedContent: string;
  taskName: string;
  editContent: string;
  isEditing: boolean;
  updatedAt: number;
}

interface PersistedProInput {
  inputMode: "file" | "text";
  teacherDocContent: string;
  teacherDocName: string;
  fileBlob: Blob | null;
  fileName: string;
  fileType: string;
  fileLastModified: number;
  updatedAt: number;
}

function openProInputDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(
      PRO_INPUT_DB_NAME,
      PRO_INPUT_DB_VERSION,
    );
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PRO_INPUT_STORE_NAME)) {
        database.createObjectStore(PRO_INPUT_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadPersistedProInput(): Promise<PersistedProInput | null> {
  if (typeof window === "undefined" || !window.indexedDB) return null;
  try {
    const database = await openProInputDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(
        PRO_INPUT_STORE_NAME,
        "readonly",
      );
      const request = transaction
        .objectStore(PRO_INPUT_STORE_NAME)
        .get(PRO_INPUT_RECORD_KEY);
      request.onsuccess = () => {
        resolve((request.result as PersistedProInput | undefined) || null);
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => database.close();
    });
  } catch {
    return null;
  }
}

async function persistProInput(input: PersistedProInput): Promise<void> {
  if (typeof window === "undefined" || !window.indexedDB) return;
  try {
    const database = await openProInputDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        PRO_INPUT_STORE_NAME,
        "readwrite",
      );
      transaction
        .objectStore(PRO_INPUT_STORE_NAME)
        .put(input, PRO_INPUT_RECORD_KEY);
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error);
      };
    });
  } catch {
    // IndexedDB 被禁用时继续使用 localStorage 文本草稿。
  }
}

function loadProGeneratorDraft(): ProGeneratorDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PRO_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ProGeneratorDraft>;
    return {
      inputMode: parsed.inputMode === "text" ? "text" : "file",
      teacherDocContent:
        typeof parsed.teacherDocContent === "string"
          ? parsed.teacherDocContent
          : "",
      teacherDocName:
        typeof parsed.teacherDocName === "string" ? parsed.teacherDocName : "",
      userGenerationAdvice:
        typeof parsed.userGenerationAdvice === "string"
          ? parsed.userGenerationAdvice
          : "",
      generatedContent:
        typeof parsed.generatedContent === "string"
          ? parsed.generatedContent
          : "",
      taskName: typeof parsed.taskName === "string" ? parsed.taskName : "",
      editContent:
        typeof parsed.editContent === "string" ? parsed.editContent : "",
      isEditing: parsed.isEditing === true,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function TrainingGenerateProInterface() {
  // ─── 状态 ─────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<GeneratePhase>("idle");
  const [inputMode, setInputMode] = useState<"file" | "text">("file");
  const [teacherDocContent, setTeacherDocContent] = useState("");
  const [teacherDocName, setTeacherDocName] = useState("");
  const [userGenerationAdvice, setUserGenerationAdvice] = useState("");
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [generatedContent, setGeneratedContent] = useState("");
  const [taskName, setTaskName] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showInject, setShowInject] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [showPromptEditor, setShowPromptEditor] = useState(false);
  const [promptTemplate, setPromptTemplate] = useState(() => {
    if (typeof window === "undefined") return PRO_SCRIPT_TEMPLATE;
    try {
      const saved = window.localStorage.getItem(PRO_PROMPT_SETTINGS_KEY);
      if (!saved) return PRO_SCRIPT_TEMPLATE;
      const parsed = JSON.parse(saved) as { version?: number; template?: string };
      return parsed.version === PRO_TEMPLATE_VERSION && parsed.template
        ? parsed.template
        : PRO_SCRIPT_TEMPLATE;
    } catch {
      return PRO_SCRIPT_TEMPLATE;
    }
  });
  const [dbTemplates, setDbTemplates] = useState<PromptTemplate[]>([]);
  const [selectedPromptTemplateId, setSelectedPromptTemplateId] = useState("default");
  const [templateLoading, setTemplateLoading] = useState(false);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveDesc, setSaveDesc] = useState("");
  const [saveTags, setSaveTags] = useState("");
  const [savePublic, setSavePublic] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        PRO_PROMPT_SETTINGS_KEY,
        JSON.stringify({
          version: PRO_TEMPLATE_VERSION,
          template: promptTemplate,
        }),
      );
    } catch {
      // 本地存储不可用时仍可在当前页面使用自定义模板。
    }
  }, [promptTemplate]);

  const loadPromptTemplates = useCallback(async () => {
    setTemplateLoading(true);
    try {
      const response = await fetch("/api/prompt-templates?type=script");
      if (!response.ok) return;
      const data = await response.json() as { templates?: PromptTemplate[] };
      setDbTemplates((data.templates || []).filter((template) => isProPromptTemplate(template.tags)));
    } catch {
      // 模板市场不可用时保留内置模板，不阻塞 Pro 生成。
    } finally {
      setTemplateLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPromptTemplates();
  }, [loadPromptTemplates]);

  const handleSelectPromptTemplate = useCallback((templateId: string) => {
    setSelectedPromptTemplateId(templateId);
    if (templateId === "default") {
      setPromptTemplate(PRO_SCRIPT_TEMPLATE);
      return;
    }

    const selected = dbTemplates.find((template) => template.id === templateId);
    if (!selected) return;
    setPromptTemplate(selected.prompt_template);
    fetch(`/api/prompt-templates/${selected.id}/use`, { method: "POST" }).catch(() => undefined);
  }, [dbTemplates]);

  const handleSavePromptTemplate = useCallback(async () => {
    if (!saveName.trim()) return;
    if (!promptTemplate.includes("{teacherDoc}")) {
      window.alert("模板内容必须包含 {teacherDoc} 占位符");
      return;
    }

    setSavingTemplate(true);
    try {
      const userTags = saveTags.split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean);
      const response = await fetch("/api/prompt-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: saveName.trim(),
          description: saveDesc.trim() || undefined,
          type: "script",
          prompt_template: promptTemplate,
          is_public: savePublic,
          tags: Array.from(new Set([PRO_PROMPT_TEMPLATE_TAG, ...userTags])),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "保存失败");
      }

      setSaveModalOpen(false);
      setSaveName("");
      setSaveDesc("");
      setSaveTags("");
      setSavePublic(false);
      await loadPromptTemplates();
      if (data.template?.id) {
        setSelectedPromptTemplateId(data.template.id);
      }
    } catch (error) {
      window.alert((error as Error).message || "保存失败");
    } finally {
      setSavingTemplate(false);
    }
  }, [loadPromptTemplates, promptTemplate, saveDesc, saveName, savePublic, saveTags]);

  // 刷新后恢复最近一次 Pro 草稿与输入。文本草稿保存在 localStorage，
  // 上传文件的 Blob 保存在 IndexedDB，因此 doc/docx 刷新后也能继续生成。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [draft, persistedInput] = await Promise.all([
        Promise.resolve(loadProGeneratorDraft()),
        loadPersistedProInput(),
      ]);
      if (cancelled) return;

      if (persistedInput) {
        setInputMode(persistedInput.inputMode);
        setTeacherDocContent(persistedInput.teacherDocContent || "");
        setTeacherDocName(persistedInput.teacherDocName || "");
        if (persistedInput.fileBlob && persistedInput.fileName) {
          setUploadedFile(
            new File([persistedInput.fileBlob], persistedInput.fileName, {
              type: persistedInput.fileType || persistedInput.fileBlob.type,
              lastModified: persistedInput.fileLastModified || Date.now(),
            }),
          );
        }
      } else if (draft) {
        const hasRecoverableText =
          Boolean(draft.teacherDocContent.trim()) &&
          !draft.teacherDocContent.startsWith("[已上传文件:");
        setInputMode(hasRecoverableText ? "text" : draft.inputMode);
        setTeacherDocContent(hasRecoverableText ? draft.teacherDocContent : "");
        setTeacherDocName(draft.teacherDocName);
      }

      if (draft) {
        setUserGenerationAdvice(draft.userGenerationAdvice);
        setGeneratedContent(draft.generatedContent);
        setTaskName(draft.taskName);
        setEditContent(draft.editContent || draft.generatedContent);
        setIsEditing(
          Boolean(
            draft.isEditing && (draft.editContent || draft.generatedContent),
          ),
        );
        if (draft.generatedContent) setPhase("completed");
      }
      setDraftHydrated(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // 生成流会高频追加 chunk，做一个轻量防抖，避免每个 token 都写 localStorage。
  useEffect(() => {
    if (!draftHydrated) return;
    const persistDraft = () => {
      const draft: ProGeneratorDraft = {
        inputMode,
        teacherDocContent,
        teacherDocName,
        userGenerationAdvice,
        generatedContent,
        taskName,
        editContent,
        isEditing,
        updatedAt: Date.now(),
      };
      try {
        window.localStorage.setItem(
          PRO_DRAFT_STORAGE_KEY,
          JSON.stringify(draft),
        );
      } catch {
        // localStorage 被禁用或超额时不影响生成主流程。
      }
    };
    const timer = window.setTimeout(persistDraft, 300);
    window.addEventListener("beforeunload", persistDraft);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("beforeunload", persistDraft);
    };
  }, [
    draftHydrated,
    inputMode,
    teacherDocContent,
    teacherDocName,
    userGenerationAdvice,
    generatedContent,
    taskName,
    editContent,
    isEditing,
  ]);

  // ─── 文件处理 ──────────────────────────────────────────────────────
  // IndexedDB 可持久化文件 Blob，避免 doc/docx 刷新后只剩文件名。
  useEffect(() => {
    if (!draftHydrated) return;
    const timer = window.setTimeout(() => {
      void persistProInput({
        inputMode,
        teacherDocContent,
        teacherDocName,
        fileBlob: uploadedFile,
        fileName: uploadedFile?.name || "",
        fileType: uploadedFile?.type || "",
        fileLastModified: uploadedFile?.lastModified || 0,
        updatedAt: Date.now(),
      });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [
    draftHydrated,
    inputMode,
    teacherDocContent,
    teacherDocName,
    uploadedFile,
  ]);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setUploadedFile(file);
      setTeacherDocName(file.name);

      if (file.name.endsWith(".txt") || file.name.endsWith(".md")) {
        const reader = new FileReader();
        reader.onload = () => setTeacherDocContent(reader.result as string);
        reader.readAsText(file);
      } else {
        setTeacherDocContent(`[已上传文件: ${file.name}，将在服务端解析]`);
      }
    },
    [],
  );

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    setUploadedFile(file);
    setTeacherDocName(file.name);

    if (file.name.endsWith(".txt") || file.name.endsWith(".md")) {
      const reader = new FileReader();
      reader.onload = () => setTeacherDocContent(reader.result as string);
      reader.readAsText(file);
    } else {
      setTeacherDocContent(`[已上传文件: ${file.name}，将在服务端解析]`);
    }
  }, []);

  const clearFile = useCallback(() => {
    setUploadedFile(null);
    setTeacherDocName("");
    setTeacherDocContent("");
  }, []);

  // ─── 生成逻辑 ──────────────────────────────────────────────────────
  const handleGenerate = useCallback(async () => {
    if (!teacherDocContent.trim() && !uploadedFile) {
      setErrorMessage("请先上传文件或粘贴教师文档内容");
      return;
    }

    if (!isProApiConfigured()) {
      setShowSettings(true);
      return;
    }

    setPhase("generating");
    setGeneratedContent("");
    setErrorMessage("");
    setStatusMessage("正在生成能力训练 Pro 配置...");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamProTrainingGenerate({
        file: uploadedFile || undefined,
        teacherDocContent: uploadedFile ? undefined : teacherDocContent,
        teacherDocName: teacherDocName || "未命名文档",
        userGenerationAdvice: userGenerationAdvice.trim() || undefined,
        promptTemplate:
          promptTemplate !== PRO_SCRIPT_TEMPLATE ? promptTemplate : undefined,
        onEvent: (event: ProTrainingSSEEvent) => {
          switch (event.type) {
            case "start":
              setStatusMessage(event.message);
              break;
            case "chunk":
              setGeneratedContent((prev) => prev + event.content);
              break;
            case "complete":
              setGeneratedContent(event.fullContent);
              setTaskName(event.taskName);
              setPhase("completed");
              setStatusMessage("");
              break;
            case "error":
              setErrorMessage(event.message);
              setPhase("error");
              setStatusMessage("");
              break;
          }
        },
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setErrorMessage((err as Error).message || "生成失败");
        setPhase("error");
      }
    }
  }, [teacherDocContent, uploadedFile, teacherDocName, userGenerationAdvice, promptTemplate]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    setPhase("idle");
    setStatusMessage("");
  }, []);

  // ─── 操作按钮 ──────────────────────────────────────────────────────
  const handleCopy = useCallback(async () => {
    const content = isEditing ? editContent : generatedContent;
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [generatedContent, editContent, isEditing]);

  const handleDownload = useCallback(() => {
    const content = isEditing ? editContent : generatedContent;
    const filename = taskName ? `${taskName}_Pro配置.md` : "能力训练Pro配置.md";
    downloadProMarkdown(content, filename);
  }, [generatedContent, editContent, isEditing, taskName]);

  const handleEdit = useCallback(() => {
    setEditContent(generatedContent);
    setIsEditing(true);
  }, [generatedContent]);

  const handleSaveEdit = useCallback(() => {
    setGeneratedContent(editContent);
    setIsEditing(false);
  }, [editContent]);

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false);
  }, []);

  const handleReset = useCallback(() => {
    setPhase("idle");
    setGeneratedContent("");
    setTaskName("");
    setErrorMessage("");
    setStatusMessage("");
    setIsEditing(false);
    setEditContent("");
  }, []);

  const canGenerate = !!(teacherDocContent.trim() || uploadedFile);
  const activeContent = isEditing ? editContent : generatedContent;

  // ─── 渲染 ──────────────────────────────────────────────────────────
  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 bg-gradient-to-br from-violet-100 to-indigo-100 rounded-xl">
            <Sparkles className="w-6 h-6 text-indigo-600" />
          </div>
          <h1 className="text-2xl font-bold text-slate-800">
            能力训练 Pro 配置生成
          </h1>
          <span className="px-2 py-0.5 text-xs font-medium bg-indigo-100 text-indigo-700 rounded-full">
            Pro
          </span>
        </div>
        <p className="text-slate-500 ml-[52px]">
          上传教师文档，自动生成能力训练 Pro 配置（含全局成员、技能、阶段剧本）
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ====== 左侧：输入区 ====== */}
        <div className="space-y-5">
          {/* 文档输入 */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-indigo-500" />
                <span className="font-semibold text-slate-700 text-sm">
                  教师任务文档
                </span>
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
                <div
                  className={`border-2 border-dashed rounded-xl p-8 text-center transition-all cursor-pointer ${
                    isDragging
                      ? "border-indigo-400 bg-indigo-50"
                      : uploadedFile
                        ? "border-emerald-300 bg-emerald-50"
                        : "border-slate-200 hover:border-indigo-300 hover:bg-slate-50"
                  }`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDragging(true);
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    setIsDragging(false);
                  }}
                  onDrop={handleFileDrop}
                  onClick={() => !uploadedFile && fileInputRef.current?.click()}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".txt,.md,.doc,.docx"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                  {uploadedFile ? (
                    <div className="space-y-2">
                      <FileText className="w-10 h-10 text-emerald-500 mx-auto" />
                      <p className="text-sm font-medium text-emerald-700">
                        {uploadedFile.name}
                      </p>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          clearFile();
                        }}
                        className="text-xs text-slate-500 hover:text-red-500"
                      >
                        移除文件
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Upload className="w-10 h-10 text-slate-300 mx-auto" />
                      <p className="text-sm text-slate-500">
                        拖拽或点击上传文件
                      </p>
                      <p className="text-xs text-slate-400">
                        .docx / .doc / .txt / .md
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <textarea
                  value={
                    teacherDocContent.startsWith("[已上传文件")
                      ? ""
                      : teacherDocContent
                  }
                  onChange={(e) => {
                    setTeacherDocContent(e.target.value);
                    setUploadedFile(null);
                    setTeacherDocName("粘贴文档");
                  }}
                  placeholder="在此粘贴教师实训任务文档内容..."
                  className="w-full h-64 px-4 py-3 border border-slate-200 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 text-sm"
                  disabled={phase === "generating"}
                />
              )}
            </div>
          </div>

          {/* 用户生成建议 */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Lightbulb className="w-4 h-4 text-amber-500" />
                <span className="font-semibold text-slate-700 text-sm">
                  生成配置建议
                </span>
                <span className="text-xs text-slate-400">（选填）</span>
              </div>
              <span className="text-xs text-slate-400">
                {userGenerationAdvice.length}/2000
              </span>
            </div>
            <div className="p-4">
              <textarea
                value={userGenerationAdvice}
                onChange={(event) =>
                  setUserGenerationAdvice(event.target.value.slice(0, 2000))
                }
                placeholder="例如：希望分为 6 个阶段；重点强化安全规范和实操纠偏；角色语气要严谨；每轮只提一个问题……"
                rows={4}
                disabled={phase === "generating"}
                className="w-full px-4 py-3 border border-slate-200 rounded-xl resize-y focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-400 text-sm leading-6 placeholder:text-slate-400 disabled:bg-slate-50"
              />
              <p className="text-xs text-slate-400 mt-2">
                生成时会在教师任务文档的基础上同时参考这些建议，留空则按默认规则生成。
              </p>
            </div>
          </div>

          {/* Prompt 模板 */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <button
              type="button"
              onClick={() => setShowPromptEditor((visible) => !visible)}
              className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-slate-50 transition-colors"
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                <Sparkles className="w-4 h-4 text-indigo-400" />
                Prompt 模板
                {promptTemplate !== PRO_SCRIPT_TEMPLATE && (
                  <span className="px-1.5 py-0.5 bg-violet-100 text-violet-600 text-xs rounded-full">
                    已修改
                  </span>
                )}
                <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 text-xs rounded-full">
                  {dbTemplates.length + 1} 个可用
                </span>
              </span>
              <ChevronDown
                className={`w-4 h-4 text-slate-400 transition-transform ${showPromptEditor ? "rotate-180" : ""}`}
              />
            </button>

            {showPromptEditor && (
              <div className="border-t border-slate-100 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <select
                    value={selectedPromptTemplateId}
                    onChange={(event) => handleSelectPromptTemplate(event.target.value)}
                    disabled={templateLoading || phase === "generating"}
                    className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-xs text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300 disabled:bg-slate-50"
                  >
                    <option value="default">内置 Pro 默认模板</option>
                    {selectedPromptTemplateId === "custom" && (
                      <option value="custom">当前自定义内容</option>
                    )}
                    {dbTemplates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.is_public ? "公开 · " : "私有 · "}
                        {template.name}
                        {template.creator_name ? ` · ${template.creator_name}` : ""}
                        {template.use_count > 0 ? ` (${template.use_count}次)` : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => {
                      setSaveName("");
                      setSaveDesc("");
                      setSaveTags("");
                      setSavePublic(false);
                      setSaveModalOpen(true);
                    }}
                    disabled={phase === "generating"}
                    className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors whitespace-nowrap disabled:opacity-50"
                  >
                    <Save className="w-3.5 h-3.5" />
                    另存
                  </button>
                </div>

                <p className="text-xs text-slate-500">
                  使用 <code className="bg-slate-100 px-1 py-0.5 rounded text-violet-600">{"{teacherDoc}"}</code> 作为教师文档占位符，生成时会自动替换。
                </p>

                <textarea
                  value={promptTemplate}
                  onChange={(event) => {
                    setPromptTemplate(event.target.value);
                    setSelectedPromptTemplateId("custom");
                  }}
                  rows={20}
                  disabled={phase === "generating"}
                  spellCheck={false}
                  className="w-full p-3 border border-slate-200 rounded-xl text-xs font-mono text-slate-700 leading-5 focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-300 resize-y disabled:bg-slate-50"
                />

                <button
                  type="button"
                  onClick={() => {
                    setPromptTemplate(PRO_SCRIPT_TEMPLATE);
                    setSelectedPromptTemplateId("default");
                  }}
                  disabled={phase === "generating"}
                  className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 transition-colors disabled:opacity-50"
                >
                  <RotateCcw className="w-3 h-3" />
                  恢复默认
                </button>
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
          </div>

          {/* 未配置 API 提示 */}
          {!isProApiConfigured() && (
            <div className="flex items-start gap-2.5 p-3 bg-amber-50 border border-amber-200 rounded-xl">
              <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-amber-700">
                请先在导航栏「设置」中配置 API
                地址；如你的服务需要鉴权，再额外填写 API Key。
              </p>
            </div>
          )}

          {/* 状态消息 */}
          {statusMessage && (
            <div className="flex items-center gap-2 text-sm text-indigo-600 bg-indigo-50 border border-indigo-100 px-4 py-3 rounded-xl">
              <Loader2 className="w-4 h-4 animate-spin" />
              {statusMessage}
            </div>
          )}

          {/* 错误消息 */}
          {errorMessage && (
            <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-100 px-4 py-3 rounded-xl">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}
        </div>

        {/* ====== 右侧：结果展示区 ====== */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col min-h-[500px]">
          {/* Tab 头 + 操作按钮 */}
          <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between gap-4">
            <div className="flex gap-1.5 p-1 bg-slate-100/80 rounded-xl shrink-0">
              <button className="px-3 py-2 text-sm font-medium rounded-lg bg-white text-violet-700 shadow-sm ring-1 ring-slate-200/50 flex items-center gap-1.5">
                <BookOpen className="w-4 h-4 shrink-0" />
                <span>Pro 配置</span>
                {generatedContent && phase === "completed" && (
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                )}
              </button>
            </div>

            {/* 操作按钮 */}
            {activeContent && phase === "completed" && (
              <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                {!isEditing ? (
                  <>
                    <button
                      onClick={() => setShowInject(true)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 rounded-lg shadow-sm shadow-indigo-200 transition-all hover:-translate-y-0.5"
                      title="一键注入到平台"
                    >
                      🚀 一键注入
                    </button>
                    <button
                      onClick={handleEdit}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:text-indigo-600 bg-slate-50 hover:bg-indigo-50 rounded-lg transition-colors"
                      title="编辑配置"
                    >
                      ✏️ 编辑
                    </button>
                    <button
                      onClick={handleCopy}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:text-indigo-600 bg-slate-50 hover:bg-indigo-50 rounded-lg transition-colors"
                      title="复制内容"
                    >
                      {copied ? (
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      {copied ? "已复制" : "复制"}
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
                  </>
                ) : (
                  <>
                    <button
                      onClick={handleSaveEdit}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      保存
                    </button>
                    <button
                      onClick={handleCancelEdit}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:text-rose-600 bg-slate-50 hover:bg-rose-50 rounded-lg transition-colors"
                    >
                      <X className="w-3.5 h-3.5" />
                      取消
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {/* 内容区域 */}
          <div className="flex-1 overflow-y-auto">
            {isEditing ? (
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="w-full h-full min-h-[600px] px-5 py-4 resize-none focus:outline-none text-sm font-mono"
              />
            ) : generatedContent ? (
              <div className="px-5 py-4 prose prose-sm max-w-none overflow-auto max-h-[700px]">
                <MarkdownRenderer content={generatedContent} />
              </div>
            ) : phase === "generating" ? (
              <div className="flex flex-col items-center justify-center h-64 text-slate-400">
                <Loader2 className="w-8 h-8 animate-spin mb-3" />
                <p className="text-sm">正在生成中...</p>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-64 text-slate-400">
                <Sparkles className="w-12 h-12 mb-3 opacity-50" />
                <p className="text-sm">
                  上传文档并点击生成，Pro 配置将在这里显示
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 弹窗 */}
      {saveModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          onClick={() => setSaveModalOpen(false)}
        >
          <div
            className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="bg-indigo-600 p-4 text-white">
              <h3 className="flex items-center gap-2 text-lg font-bold">
                <Save className="w-5 h-5" />
                保存 Pro Prompt 模板
              </h3>
              <p className="mt-1 text-sm text-indigo-100">
                保存当前模板，后续可直接选择复用
              </p>
            </div>
            <div className="space-y-4 p-5">
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  模板名称 *
                </label>
                <input
                  value={saveName}
                  onChange={(event) => setSaveName(event.target.value)}
                  placeholder="例如：多角色岗位实训 Pro 模板"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  简介
                </label>
                <input
                  value={saveDesc}
                  onChange={(event) => setSaveDesc(event.target.value)}
                  placeholder="简要说明模板适用的训练场景"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  标签（逗号分隔）
                </label>
                <input
                  value={saveTags}
                  onChange={(event) => setSaveTags(event.target.value)}
                  placeholder="例如：护理, 法律, 多角色"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </div>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={savePublic}
                  onChange={(event) => setSavePublic(event.target.checked)}
                  className="sr-only"
                />
                <span className={`flex h-5 w-5 items-center justify-center rounded-md border-2 transition-colors ${savePublic ? "border-indigo-500 bg-indigo-500" : "border-slate-300"}`}>
                  {savePublic && <Check className="w-3.5 h-3.5 text-white" />}
                </span>
                <span className="flex items-center gap-1.5 text-sm text-slate-700">
                  {savePublic ? (
                    <Globe className="w-3.5 h-3.5 text-emerald-500" />
                  ) : (
                    <Lock className="w-3.5 h-3.5 text-slate-400" />
                  )}
                  {savePublic ? "公开（所有用户可见可用）" : "私有（仅自己可见）"}
                </span>
              </label>
            </div>
            <div className="flex gap-3 px-5 pb-5">
              <button
                type="button"
                onClick={() => setSaveModalOpen(false)}
                className="flex-1 rounded-lg bg-slate-100 px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSavePromptTemplate}
                disabled={!saveName.trim() || savingTemplate}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {savingTemplate ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                {savingTemplate ? "保存中..." : "保存模板"}
              </button>
            </div>
          </div>
        </div>
      )}
      {showSettings && (
        <SettingsModal
          isOpen={showSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showInject && (
        <InjectConfigProModal
          markdown={isEditing ? editContent : generatedContent}
          onClose={() => setShowInject(false)}
        />
      )}
    </div>
  );
}
