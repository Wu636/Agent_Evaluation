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
    GripVertical,
    Plus,
    Trash2,
    Crosshair,
} from "lucide-react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import {
    PromptTemplate,
    ScriptMode,
    ScriptModulePlan,
    ScriptPlanValidationIssue,
    TrainingSSEEvent,
    TrainingScriptPlan,
} from "@/lib/training-generator/types";
import {
    createTrainingScriptPlan,
    regenerateTrainingScriptModule,
    streamTrainingGenerate,
    isApiConfigured,
    downloadMarkdown,
    copyToClipboard,
} from "@/lib/training-generator/client";
import { DEFAULT_RUBRIC_TEMPLATE, DEFAULT_SCRIPT_TEMPLATE, TEMPLATE_VERSION, getBuiltInScriptTemplate } from "@/lib/training-generator/prompts";
import { findMultiRoleModuleIssue } from "@/lib/training-generator/plan-validation";
import { diagnoseTrainingScript, extractScriptStructure, replaceStageInScript } from "@/lib/training-generator/script-tools";
import { SettingsModal } from "./SettingsModal";
import { InjectConfigModal } from "./InjectConfigModal";
import { TrainingOptimizationModal } from "./TrainingOptimizationModal";
import { OptimizationLoopResult } from "@/lib/training-optimizer/types";

type GeneratePhase = "idle" | "generating" | "completed" | "error";
type ResultTab = "script" | "rubric";
type PlanRegenerateSource = "current_edited" | "previous_plan" | "teacher_doc_only";

const RESULT_CACHE_KEY = "training-generate-result";
const MODULE_PLAN_CACHE_KEY = "training-generate-module-plan";
const MODULE_PLAN_CACHE_VERSION = 1;
const MODULE_PLAN_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OPTIMIZATION_SNAPSHOT_KEY = "training-generate-optimization-snapshots";
const OPTIMIZATION_SNAPSHOT_LIMIT = 8;
const TEACHER_DOC_CACHE_DB = "training-generate-teacher-doc";
const TEACHER_DOC_CACHE_STORE = "teacher-doc-state";
const TEACHER_DOC_CACHE_KEY = "latest";
const TEACHER_DOC_CACHE_VERSION = 1;
const TEACHER_DOC_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CachedModulePlanState {
    _v: number;
    modulePlan: TrainingScriptPlan | null;
    lastSystemPlan: TrainingScriptPlan | null;
    planAutofillApplied: boolean;
    planAutofillFields: string[];
    planAutofillTaskFields: string[];
    planAutofillModuleFields: Record<string, string[]>;
    updatedAt: number;
}

interface CachedTeacherDocState {
    _v: number;
    inputMode: "file" | "text";
    textContent: string;
    updatedAt: number;
    fileBlob: Blob | null;
    fileName: string;
    fileType: string;
    fileLastModified: number;
}

interface OptimizationSnapshot {
    id: string;
    createdAt: number;
    taskName: string;
    summary: string;
    appliedActionCount: number;
    actionTitles: string[];
    scriptContent: string;
    rubricContent: string;
    modulePlan: TrainingScriptPlan | null;
}

const EMPTY_MODULE_PLAN_CACHE: CachedModulePlanState = {
    _v: MODULE_PLAN_CACHE_VERSION,
    modulePlan: null,
    lastSystemPlan: null,
    planAutofillApplied: false,
    planAutofillFields: [],
    planAutofillTaskFields: [],
    planAutofillModuleFields: {},
    updatedAt: 0,
};

function loadOptimizationSnapshots(): OptimizationSnapshot[] {
    if (typeof window === "undefined") return [];

    try {
        const raw = localStorage.getItem(OPTIMIZATION_SNAPSHOT_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        localStorage.removeItem(OPTIMIZATION_SNAPSHOT_KEY);
        return [];
    }
}

function openTeacherDocCacheDb(): Promise<IDBDatabase | null> {
    if (typeof window === "undefined" || typeof indexedDB === "undefined") {
        return Promise.resolve(null);
    }

    return new Promise((resolve, reject) => {
        const request = indexedDB.open(TEACHER_DOC_CACHE_DB, 1);

        request.onerror = () => reject(request.error || new Error("无法打开教师文档缓存"));
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(TEACHER_DOC_CACHE_STORE)) {
                db.createObjectStore(TEACHER_DOC_CACHE_STORE);
            }
        };
        request.onsuccess = () => resolve(request.result);
    });
}

function loadCachedTeacherDocState(): Promise<CachedTeacherDocState | null> {
    return openTeacherDocCacheDb().then((db) => {
        if (!db) return null;

        return new Promise((resolve, reject) => {
            const tx = db.transaction(TEACHER_DOC_CACHE_STORE, "readonly");
            const store = tx.objectStore(TEACHER_DOC_CACHE_STORE);
            const request = store.get(TEACHER_DOC_CACHE_KEY);

            request.onerror = () => {
                db.close();
                reject(request.error || new Error("读取教师文档缓存失败"));
            };

            request.onsuccess = () => {
                const result = request.result as CachedTeacherDocState | undefined;
                if (!result || result._v !== TEACHER_DOC_CACHE_VERSION) {
                    db.close();
                    resolve(null);
                    return;
                }

                if (!result.updatedAt || Date.now() - result.updatedAt > TEACHER_DOC_CACHE_TTL_MS) {
                    db.close();
                    void clearCachedTeacherDocState();
                    resolve(null);
                    return;
                }

                db.close();
                resolve(result);
            };
        });
    });
}

function saveCachedTeacherDocState(state: CachedTeacherDocState): Promise<void> {
    return openTeacherDocCacheDb().then((db) => {
        if (!db) return;

        return new Promise<void>((resolve, reject) => {
            const tx = db.transaction(TEACHER_DOC_CACHE_STORE, "readwrite");
            const store = tx.objectStore(TEACHER_DOC_CACHE_STORE);
            const request = store.put(state, TEACHER_DOC_CACHE_KEY);

            request.onerror = () => {
                db.close();
                reject(request.error || new Error("保存教师文档缓存失败"));
            };
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => {
                db.close();
                reject(tx.error || new Error("保存教师文档缓存失败"));
            };
        });
    });
}

function clearCachedTeacherDocState(): Promise<void> {
    return openTeacherDocCacheDb().then((db) => {
        if (!db) return;

        return new Promise<void>((resolve, reject) => {
            const tx = db.transaction(TEACHER_DOC_CACHE_STORE, "readwrite");
            const store = tx.objectStore(TEACHER_DOC_CACHE_STORE);
            const request = store.delete(TEACHER_DOC_CACHE_KEY);

            request.onerror = () => {
                db.close();
                reject(request.error || new Error("清空教师文档缓存失败"));
            };
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => {
                db.close();
                reject(tx.error || new Error("清空教师文档缓存失败"));
            };
        });
    });
}

function loadCachedModulePlanState(): CachedModulePlanState {
    if (typeof window === "undefined") return EMPTY_MODULE_PLAN_CACHE;

    try {
        const raw = localStorage.getItem(MODULE_PLAN_CACHE_KEY);
        if (!raw) return EMPTY_MODULE_PLAN_CACHE;

        const parsed = JSON.parse(raw) as Partial<CachedModulePlanState>;
        const updatedAt = Number(parsed.updatedAt || 0);
        if (!updatedAt || Date.now() - updatedAt > MODULE_PLAN_CACHE_TTL_MS) {
            localStorage.removeItem(MODULE_PLAN_CACHE_KEY);
            return EMPTY_MODULE_PLAN_CACHE;
        }

        if (parsed._v !== MODULE_PLAN_CACHE_VERSION) {
            localStorage.removeItem(MODULE_PLAN_CACHE_KEY);
            return EMPTY_MODULE_PLAN_CACHE;
        }

        return {
            _v: MODULE_PLAN_CACHE_VERSION,
            modulePlan: parsed.modulePlan || null,
            lastSystemPlan: parsed.lastSystemPlan || null,
            planAutofillApplied: Boolean(parsed.planAutofillApplied),
            planAutofillFields: Array.isArray(parsed.planAutofillFields) ? parsed.planAutofillFields : [],
            planAutofillTaskFields: Array.isArray(parsed.planAutofillTaskFields) ? parsed.planAutofillTaskFields : [],
            planAutofillModuleFields: parsed.planAutofillModuleFields && typeof parsed.planAutofillModuleFields === "object"
                ? parsed.planAutofillModuleFields
                : {},
            updatedAt,
        };
    } catch {
        localStorage.removeItem(MODULE_PLAN_CACHE_KEY);
        return EMPTY_MODULE_PLAN_CACHE;
    }
}

const SCRIPT_MODE_LABELS: Record<Exclude<ScriptMode, "auto">, string> = {
    general: "通用",
    sequential: "循序过关型",
    roleplay: "模拟人物型",
    summary: "总结复盘型",
};

const BUILTIN_TEMPLATE_ORIGINAL = "builtin:original";
const BUILTIN_TEMPLATE_SEQUENTIAL = "builtin:sequential";
const BUILTIN_TEMPLATE_ROLEPLAY = "builtin:roleplay";
const BUILTIN_TEMPLATE_SUMMARY = "builtin:summary";

type BuiltInTemplateId =
    | typeof BUILTIN_TEMPLATE_ORIGINAL
    | typeof BUILTIN_TEMPLATE_SEQUENTIAL
    | typeof BUILTIN_TEMPLATE_ROLEPLAY
    | typeof BUILTIN_TEMPLATE_SUMMARY;

function isBuiltInTemplateId(value: string): value is BuiltInTemplateId {
    return [
        BUILTIN_TEMPLATE_ORIGINAL,
        BUILTIN_TEMPLATE_SEQUENTIAL,
        BUILTIN_TEMPLATE_ROLEPLAY,
        BUILTIN_TEMPLATE_SUMMARY,
    ].includes(value);
}

function getBuiltInTemplateById(id: BuiltInTemplateId): string {
    switch (id) {
        case BUILTIN_TEMPLATE_ORIGINAL:
            return DEFAULT_SCRIPT_TEMPLATE;
        case BUILTIN_TEMPLATE_SEQUENTIAL:
            return getBuiltInScriptTemplate("sequential");
        case BUILTIN_TEMPLATE_ROLEPLAY:
            return getBuiltInScriptTemplate("roleplay");
        case BUILTIN_TEMPLATE_SUMMARY:
            return getBuiltInScriptTemplate("summary");
        default:
            return DEFAULT_SCRIPT_TEMPLATE;
    }
}

function getBuiltInTemplateIdByMode(mode: Exclude<ScriptMode, "auto">): BuiltInTemplateId {
    switch (mode) {
        case "sequential":
            return BUILTIN_TEMPLATE_SEQUENTIAL;
        case "roleplay":
            return BUILTIN_TEMPLATE_ROLEPLAY;
        case "summary":
            return BUILTIN_TEMPLATE_SUMMARY;
        case "general":
        default:
            return BUILTIN_TEMPLATE_ORIGINAL;
    }
}

function validatePlanLocally(plan: TrainingScriptPlan | null): ScriptPlanValidationIssue[] {
    if (!plan) return [];

    const issues: ScriptPlanValidationIssue[] = [];
    if (!plan.taskName.trim()) {
        issues.push({ level: "error", message: "规划中未填写任务名称。", field: "taskName" });
    }
    if (!plan.overallObjective.trim()) {
        issues.push({ level: "error", message: "规划中未填写整体训练目标。", field: "overallObjective" });
    }
    if (plan.modules.length === 0) {
        issues.push({ level: "error", message: "规划中没有任何模块。" });
        return issues;
    }
    plan.modules.forEach((module, index) => {
        if (!module.title.trim()) issues.push({ level: "error", message: `模块 ${index + 1} 缺少标题。`, moduleId: module.id, field: "title" });
        if (!module.objective.trim()) issues.push({ level: "error", message: `模块 ${index + 1} 缺少训练目的。`, moduleId: module.id, field: "objective" });
        if (!module.description.trim()) issues.push({ level: "error", message: `模块 ${index + 1} 缺少模块说明。`, moduleId: module.id, field: "description" });
        if (module.keyPoints.length < 2) issues.push({ level: "error", message: `模块 ${index + 1} 的关键要点不足 2 条。`, moduleId: module.id, field: "keyPoints" });
        if (module.suggestedRounds < 1) issues.push({ level: "error", message: `模块 ${index + 1} 的建议轮次不能小于 1。`, moduleId: module.id, field: "suggestedRounds" });
        if (module.suggestedRounds > 10) issues.push({ level: "error", message: `模块 ${index + 1} 的建议轮次超过 10，需拆分为多个模块。`, moduleId: module.id, field: "suggestedRounds" });
        const multiRoleIssue = findMultiRoleModuleIssue(module, index);
        if (multiRoleIssue) issues.push(multiRoleIssue);
    });
    return issues;
}

function createEmptyModule(index: number): ScriptModulePlan {
    const order = index + 1;
    return {
        id: `module_${Date.now()}_${order}`,
        title: `新模块 ${order}`,
        moduleType: "general",
        objective: "",
        description: "",
        keyPoints: [],
        interactionStyle: "",
        transitionGoal: "",
        suggestedRounds: 3,
    };
}

function reorderModules(modules: ScriptModulePlan[], draggedId: string, targetId: string): ScriptModulePlan[] {
    if (draggedId === targetId) return modules;
    const fromIndex = modules.findIndex((module) => module.id === draggedId);
    const toIndex = modules.findIndex((module) => module.id === targetId);
    if (fromIndex < 0 || toIndex < 0) return modules;

    const nextModules = [...modules];
    const [moved] = nextModules.splice(fromIndex, 1);
    nextModules.splice(toIndex, 0, moved);
    return nextModules;
}

export function TrainingGenerateInterface() {
    // --- 输入状态 ---
    const [inputMode, setInputMode] = useState<"file" | "text">("file");
    const [file, setFile] = useState<File | null>(null);
    const [textContent, setTextContent] = useState("");
    const [isDragging, setIsDragging] = useState(false);
    const [teacherDocCacheHydrated, setTeacherDocCacheHydrated] = useState(false);
    const [teacherDocCacheRestored, setTeacherDocCacheRestored] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // --- 生成选项 ---
    const [generateScript, setGenerateScript] = useState(true);
    const [generateRubric, setGenerateRubric] = useState(true);
    const [scriptMode, setScriptMode] = useState<ScriptMode>(() => {
        if (typeof window === "undefined") return "general";
        try {
            const saved = localStorage.getItem("training-prompt-settings");
            if (!saved) return "general";
            const parsed = JSON.parse(saved);
            return parsed._v === TEMPLATE_VERSION ? (parsed.scriptMode || "auto") : "auto";
        } catch {
            return "auto";
        }
    });

    // --- 生成状态 ---
    const [phase, setPhase] = useState<GeneratePhase>("idle");
    const [currentGeneratingPhase, setCurrentGeneratingPhase] = useState<"script" | "rubric" | null>(null);
    const [statusMessage, setStatusMessage] = useState("");
    const abortRef = useRef<AbortController | null>(null);

    // --- 结果（从 localStorage 恢复）---
    const loadCached = () => {
        try {
            const raw = typeof window !== "undefined" ? localStorage.getItem(RESULT_CACHE_KEY) : null;
            if (!raw) return { script: "", rubric: "", name: "" };
            return JSON.parse(raw) as { script: string; rubric: string; name: string };
        } catch { return { script: "", rubric: "", name: "" }; }
    };
    const cached = loadCached();
    const [initialModulePlanCache] = useState<CachedModulePlanState>(() => loadCachedModulePlanState());
    const [scriptContent, setScriptContent] = useState(cached.script);
    const [rubricContent, setRubricContent] = useState(cached.rubric);
    const [activeTab, setActiveTab] = useState<ResultTab>("script");
    const [taskName, setTaskName] = useState(cached.name);
    const [errorMessage, setErrorMessage] = useState("");
    const [optimizationSnapshots, setOptimizationSnapshots] = useState<OptimizationSnapshot[]>(() => loadOptimizationSnapshots());
    const [lastOptimizationResult, setLastOptimizationResult] = useState<OptimizationLoopResult | null>(null);

    // 生成完成后自动持久化
    useEffect(() => {
        if (phase === "completed" && (scriptContent || rubricContent)) {
            localStorage.setItem(RESULT_CACHE_KEY, JSON.stringify({ script: scriptContent, rubric: rubricContent, name: taskName }));
        }
    }, [phase, scriptContent, rubricContent, taskName]);

    useEffect(() => {
        if (typeof window === "undefined") return;
        if (optimizationSnapshots.length === 0) {
            localStorage.removeItem(OPTIMIZATION_SNAPSHOT_KEY);
            return;
        }
        localStorage.setItem(OPTIMIZATION_SNAPSHOT_KEY, JSON.stringify(optimizationSnapshots));
    }, [optimizationSnapshots]);

    useEffect(() => {
        let cancelled = false;

        const restoreTeacherDoc = async () => {
            try {
                const cachedDoc = await loadCachedTeacherDocState();
                if (cancelled || !cachedDoc) return;

                setInputMode(cachedDoc.inputMode);
                setTextContent(cachedDoc.textContent || "");

                if (cachedDoc.fileBlob && cachedDoc.fileName) {
                    const restoredFile = new File(
                        [cachedDoc.fileBlob],
                        cachedDoc.fileName,
                        {
                            type: cachedDoc.fileType || cachedDoc.fileBlob.type || "",
                            lastModified: cachedDoc.fileLastModified || Date.now(),
                        },
                    );
                    setFile(restoredFile);
                }

                if (cachedDoc.textContent.trim() || cachedDoc.fileBlob) {
                    setTeacherDocCacheRestored(true);
                }
            } catch {
                // ignore cache restore failures
            } finally {
                if (!cancelled) setTeacherDocCacheHydrated(true);
            }
        };

        void restoreTeacherDoc();

        return () => {
            cancelled = true;
        };
    }, []);

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
    const [showOptimizationModal, setShowOptimizationModal] = useState(false);
    const [showPromptEditor, setShowPromptEditor] = useState(false);
    const [activePromptTab, setActivePromptTab] = useState<"script" | "rubric">("script");
    const [modulePlan, setModulePlan] = useState<TrainingScriptPlan | null>(initialModulePlanCache.modulePlan);
    const [lastSystemPlan, setLastSystemPlan] = useState<TrainingScriptPlan | null>(initialModulePlanCache.lastSystemPlan);
    const [planValidation, setPlanValidation] = useState<ScriptPlanValidationIssue[]>([]);
    const [planAutofillApplied, setPlanAutofillApplied] = useState(initialModulePlanCache.planAutofillApplied);
    const [planAutofillFields, setPlanAutofillFields] = useState<string[]>(initialModulePlanCache.planAutofillFields);
    const [planAutofillTaskFields, setPlanAutofillTaskFields] = useState<string[]>(initialModulePlanCache.planAutofillTaskFields);
    const [planAutofillModuleFields, setPlanAutofillModuleFields] = useState<Record<string, string[]>>(initialModulePlanCache.planAutofillModuleFields);
    const [planning, setPlanning] = useState(false);
    const [showPlanEditor, setShowPlanEditor] = useState(Boolean(initialModulePlanCache.modulePlan));
    const [planCacheRestored, setPlanCacheRestored] = useState(Boolean(initialModulePlanCache.modulePlan));
    const [draggingModuleId, setDraggingModuleId] = useState<string | null>(null);
    const [dragOverModuleId, setDragOverModuleId] = useState<string | null>(null);
    const [collapsedModuleIds, setCollapsedModuleIds] = useState<string[]>([]);
    const [focusedModuleId, setFocusedModuleId] = useState<string | null>(null);
    const [focusedStageIndex, setFocusedStageIndex] = useState<number | null>(null);
    const [moduleRegenTargetId, setModuleRegenTargetId] = useState("");
    const [moduleRegenFeedback, setModuleRegenFeedback] = useState("");
    const [moduleRegenUsePrevious, setModuleRegenUsePrevious] = useState(true);
    const [moduleRegenerating, setModuleRegenerating] = useState(false);
    const [showModuleRegenModal, setShowModuleRegenModal] = useState(false);
    const [showPlanRegenerateModal, setShowPlanRegenerateModal] = useState(false);
    const [planRegenerateFeedback, setPlanRegenerateFeedback] = useState("");
    const [planRegenerateSource, setPlanRegenerateSource] = useState<PlanRegenerateSource>("current_edited");
    const moduleCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const resultPaneRef = useRef<HTMLDivElement | null>(null);

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
        localStorage.setItem(PROMPT_SETTINGS_KEY, JSON.stringify({ scriptTemplate, rubricTemplate, scriptMode, _v: TEMPLATE_VERSION }));
    }, [scriptTemplate, rubricTemplate, scriptMode]);

    const activeDefaultScriptTemplate = modulePlan
        ? getBuiltInScriptTemplate(scriptMode)
        : DEFAULT_SCRIPT_TEMPLATE;

    // --- 数据库模板列表 ---
    const [dbTemplates, setDbTemplates] = useState<PromptTemplate[]>([]);
    const [selectedScriptTemplateId, setSelectedScriptTemplateId] = useState<string>(BUILTIN_TEMPLATE_ORIGINAL);
    const [selectedRubricTemplateId, setSelectedRubricTemplateId] = useState<string>("default");
    const [templateLoading, setTemplateLoading] = useState(false);
    const [saveModalOpen, setSaveModalOpen] = useState(false);
    const [saveName, setSaveName] = useState("");
    const [saveDesc, setSaveDesc] = useState("");
    const [savePublic, setSavePublic] = useState(false);
    const [saveTags, setSaveTags] = useState("");
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (isBuiltInTemplateId(selectedScriptTemplateId)) {
            setScriptTemplate(getBuiltInTemplateById(selectedScriptTemplateId));
        }
    }, [selectedScriptTemplateId]);

    useEffect(() => {
        setPlanValidation(validatePlanLocally(modulePlan));
    }, [modulePlan]);

    useEffect(() => {
        if (modulePlan?.modules.length) {
            setModuleRegenTargetId((prev) => (
                prev && modulePlan.modules.some((module) => module.id === prev)
                    ? prev
                    : modulePlan.modules[0].id
            ));
        } else {
            setModuleRegenTargetId("");
        }
    }, [modulePlan]);

    useEffect(() => {
        if (typeof window === "undefined") return;

        if (!modulePlan && !lastSystemPlan) {
            localStorage.removeItem(MODULE_PLAN_CACHE_KEY);
            return;
        }

        const payload: CachedModulePlanState = {
            _v: MODULE_PLAN_CACHE_VERSION,
            modulePlan,
            lastSystemPlan,
            planAutofillApplied,
            planAutofillFields,
            planAutofillTaskFields,
            planAutofillModuleFields,
            updatedAt: Date.now(),
        };

        localStorage.setItem(MODULE_PLAN_CACHE_KEY, JSON.stringify(payload));
    }, [
        modulePlan,
        lastSystemPlan,
        planAutofillApplied,
        planAutofillFields,
        planAutofillTaskFields,
        planAutofillModuleFields,
    ]);

    useEffect(() => {
        if (!teacherDocCacheHydrated) return;

        const persistTeacherDoc = async () => {
            const hasText = textContent.trim().length > 0;
            if (!file && !hasText) {
                try {
                    await clearCachedTeacherDocState();
                } catch {
                    // ignore cache clear failures
                }
                return;
            }

            try {
                await saveCachedTeacherDocState({
                    _v: TEACHER_DOC_CACHE_VERSION,
                    inputMode,
                    textContent,
                    updatedAt: Date.now(),
                    fileBlob: file,
                    fileName: file?.name || "",
                    fileType: file?.type || "",
                    fileLastModified: file?.lastModified || 0,
                });
            } catch {
                // ignore cache save failures
            }
        };

        void persistTeacherDoc();
    }, [teacherDocCacheHydrated, inputMode, textContent, file]);

    useEffect(() => {
        if (!focusedModuleId) return;
        const node = moduleCardRefs.current[focusedModuleId];
        if (node) {
            node.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        const timeout = window.setTimeout(() => setFocusedModuleId(null), 1800);
        return () => window.clearTimeout(timeout);
    }, [focusedModuleId]);

    useEffect(() => {
        if (focusedStageIndex === null || activeTab !== "script" || phase !== "completed") return;
        const pane = resultPaneRef.current;
        if (!pane) return;

        const stageNumber = focusedStageIndex + 1;
        const headingRegex = new RegExp(`阶段\\s*${stageNumber}(?!\\d)`);
        const headingNodes = Array.from(pane.querySelectorAll("h3, h4")) as HTMLElement[];
        const matched = headingNodes.filter((node) => headingRegex.test(node.textContent || ""));
        const target = matched[matched.length - 1];
        if (target) {
            target.scrollIntoView({ behavior: "smooth", block: "center" });
        }

        const timeout = window.setTimeout(() => setFocusedStageIndex(null), 1800);
        return () => window.clearTimeout(timeout);
    }, [focusedStageIndex, activeTab, phase]);

    const syncDominantMode = useCallback((nextMode: Exclude<ScriptMode, "auto">) => {
        setScriptMode(nextMode);
        if (isBuiltInTemplateId(selectedScriptTemplateId)) {
            setSelectedScriptTemplateId(getBuiltInTemplateIdByMode(nextMode));
        }
    }, [selectedScriptTemplateId]);

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

        if (tab === "script" && isBuiltInTemplateId(templateId)) {
            setScriptTemplate(getBuiltInTemplateById(templateId));
            return;
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

    const handlePlanScript = useCallback(async (options?: {
        planningFeedback?: string;
        usePreviousPlan?: boolean;
        currentPlan?: TrainingScriptPlan;
        previousPlan?: TrainingScriptPlan;
    }) => {
        if (!generateScript) return false;
        if (!isApiConfigured()) {
            setShowSettings(true);
            return false;
        }

        const doc = await getDocContent();
        if (!doc) {
            setErrorMessage("请先提供教师任务文档，再进行模块规划");
            return false;
        }

        setPlanning(true);
        setErrorMessage("");
        try {
            const result = await createTrainingScriptPlan({
                teacherDocContent: doc.content || "",
                file: doc.file,
                teacherDocName: doc.name,
                planningFeedback: options?.planningFeedback,
                usePreviousPlan: options?.usePreviousPlan,
                currentPlan: options?.currentPlan,
                previousPlan: options?.previousPlan,
            });
            setModulePlan(result.plan);
            setLastSystemPlan(result.plan);
            setPlanValidation(result.validation);
            setPlanAutofillApplied(Boolean(result.autofillApplied));
            setPlanAutofillFields(result.autofillFields || []);
            setPlanAutofillTaskFields(result.autofillTaskFields || []);
            setPlanAutofillModuleFields(result.autofillModuleFields || {});
            setPlanCacheRestored(false);
            syncDominantMode(result.plan.recommendedMode);
            setShowPlanEditor(true);
            return true;
        } catch (err) {
            setErrorMessage(err instanceof Error ? err.message : "模块规划失败");
            return false;
        } finally {
            setPlanning(false);
        }
    }, [generateScript, getDocContent, syncDominantMode]);

    const openPlanRegenerateModal = useCallback(() => {
        setPlanRegenerateFeedback("");
        setPlanRegenerateSource("current_edited");
        setShowPlanRegenerateModal(true);
    }, []);

    const clearModulePlan = useCallback(() => {
        if (typeof window !== "undefined") {
            const confirmed = window.confirm("清空当前模块规划及本地缓存后，将需要重新智能规划。是否继续？");
            if (!confirmed) return;
            localStorage.removeItem(MODULE_PLAN_CACHE_KEY);
        }

        setModulePlan(null);
        setLastSystemPlan(null);
        setPlanValidation([]);
        setPlanAutofillApplied(false);
        setPlanAutofillFields([]);
        setPlanAutofillTaskFields([]);
        setPlanAutofillModuleFields({});
        setPlanCacheRestored(false);
        setShowPlanEditor(false);
        setCollapsedModuleIds([]);
        setFocusedModuleId(null);
        setModuleRegenTargetId("");
    }, []);

    const handleRegeneratePlan = useCallback(async () => {
        if (!modulePlan) return;
        const ok = await handlePlanScript({
            planningFeedback: planRegenerateFeedback.trim(),
            usePreviousPlan: planRegenerateSource !== "teacher_doc_only",
            currentPlan: planRegenerateSource === "current_edited" ? modulePlan : undefined,
            previousPlan: planRegenerateSource === "previous_plan" ? lastSystemPlan || modulePlan : undefined,
        });
        if (ok) {
            setShowPlanRegenerateModal(false);
        }
    }, [handlePlanScript, lastSystemPlan, modulePlan, planRegenerateFeedback, planRegenerateSource]);

    const updateModulePlanField = useCallback(<K extends keyof TrainingScriptPlan>(field: K, value: TrainingScriptPlan[K]) => {
        setModulePlan((prev) => prev ? { ...prev, [field]: value } : prev);
        if (field === "recommendedMode") {
            syncDominantMode(value as Exclude<ScriptMode, "auto">);
        }
    }, [syncDominantMode]);

    const updateModule = useCallback((moduleId: string, updater: (module: ScriptModulePlan) => ScriptModulePlan) => {
        setModulePlan((prev) => {
            if (!prev) return prev;
            return {
                ...prev,
                modules: prev.modules.map((module) => module.id === moduleId ? updater(module) : module),
            };
        });
    }, []);

    const addModule = useCallback(() => {
        setModulePlan((prev) => {
            if (!prev) return prev;
            return {
                ...prev,
                modules: [...prev.modules, createEmptyModule(prev.modules.length)],
            };
        });
        setShowPlanEditor(true);
    }, []);

    const removeModule = useCallback((moduleId: string) => {
        setModulePlan((prev) => {
            if (!prev || prev.modules.length <= 1) return prev;
            return {
                ...prev,
                modules: prev.modules.filter((module) => module.id !== moduleId),
            };
        });
        setCollapsedModuleIds((prev) => prev.filter((id) => id !== moduleId));
    }, []);

    const moveModuleByDrag = useCallback((targetId: string) => {
        if (!draggingModuleId) return;
        setModulePlan((prev) => {
            if (!prev) return prev;
            return {
                ...prev,
                modules: reorderModules(prev.modules, draggingModuleId, targetId),
            };
        });
        setDraggingModuleId(null);
        setDragOverModuleId(null);
    }, [draggingModuleId]);

    const toggleModuleCollapsed = useCallback((moduleId: string) => {
        setCollapsedModuleIds((prev) => (
            prev.includes(moduleId)
                ? prev.filter((id) => id !== moduleId)
                : [...prev, moduleId]
        ));
    }, []);

    const hasInput = inputMode === "text" ? textContent.trim().length > 0 : file !== null;
    const hasSelection = generateScript || generateRubric;
    const hasPlanErrors = planValidation.some((item) => item.level === "error");
    const canGenerate = hasInput && hasSelection && phase !== "generating" && !hasPlanErrors;

    const clearOptimizationHistory = useCallback(() => {
        setOptimizationSnapshots([]);
        setLastOptimizationResult(null);
        if (typeof window !== "undefined") {
            localStorage.removeItem(OPTIMIZATION_SNAPSHOT_KEY);
        }
    }, []);

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
        if (generateScript) clearOptimizationHistory();
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
                scriptMode,
                modulePlan: generateScript ? modulePlan || undefined : undefined,
                scriptPromptTemplate: scriptTemplate !== activeDefaultScriptTemplate ? scriptTemplate : undefined,
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
                            setPhase(tempScript || tempRubric ? "completed" : "error");
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
                setPhase(tempScript || tempRubric ? "completed" : "error");
                setErrorMessage(err instanceof Error ? err.message : "生成失败");
            }
        } finally {
            abortRef.current = null;
            setCurrentGeneratingPhase(null);
        }
    }, [
        activeDefaultScriptTemplate,
        canGenerate,
        getDocContent,
        generateScript,
        generateRubric,
        modulePlan,
        rubricTemplate,
        scriptMode,
        scriptTemplate,
        clearOptimizationHistory,
    ]);

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
        if (shouldRegenScript) clearOptimizationHistory();
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
                scriptMode,
                modulePlan: shouldRegenScript ? modulePlan || undefined : undefined,
                scriptPromptTemplate: scriptTemplate !== activeDefaultScriptTemplate ? scriptTemplate : undefined,
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
                            setPhase(tempScript || tempRubric ? "completed" : "error");
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
                setPhase(tempScript || tempRubric ? "completed" : "error");
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
        clearOptimizationHistory();
        localStorage.removeItem(RESULT_CACHE_KEY);
    }, [clearOptimizationHistory]);

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
        setTeacherDocCacheRestored(false);
    };

    const clearFile = () => {
        setFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        setTeacherDocCacheRestored(false);
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
    const isAutoRecoveryStatus = /断点续写|自动重试|自动补救|生成中断|中断/.test(statusMessage);
    const recommendedBuiltInTemplateId = modulePlan
        ? getBuiltInTemplateIdByMode(modulePlan.recommendedMode)
        : BUILTIN_TEMPLATE_ORIGINAL;
    const builtInScriptTemplateOptions: Array<{ id: BuiltInTemplateId; label: string }> = [
        { id: BUILTIN_TEMPLATE_ORIGINAL, label: "内置模板 · 原始模板" },
        { id: BUILTIN_TEMPLATE_SEQUENTIAL, label: "内置模板 · 循序过关模板" },
        { id: BUILTIN_TEMPLATE_ROLEPLAY, label: "内置模板 · 模拟人物模板" },
        { id: BUILTIN_TEMPLATE_SUMMARY, label: "内置模板 · 总结复盘模板" },
    ];
    const orderedBuiltInScriptTemplateOptions = [
        ...builtInScriptTemplateOptions.filter((option) => option.id === recommendedBuiltInTemplateId),
        ...builtInScriptTemplateOptions.filter((option) => option.id !== recommendedBuiltInTemplateId),
    ];
    const activeScriptTemplateOption = builtInScriptTemplateOptions.find((option) => option.id === selectedScriptTemplateId);
    const activeScriptDbTemplate = dbTemplates.find((template) => template.type === "script" && template.id === selectedScriptTemplateId);
    const scriptTemplateModeHint = modulePlan
        ? `已完成智能规划：默认推荐使用「${SCRIPT_MODE_LABELS[modulePlan.recommendedMode]}内置模板」，你仍可在下拉框切回原始模板。`
        : activeScriptTemplateOption
            ? `未进行智能规划：当前将使用「${activeScriptTemplateOption.label}」。`
            : selectedScriptTemplateId === "custom"
                ? "未进行智能规划：当前将使用你编辑后的自定义模板。"
                : activeScriptDbTemplate
                    ? `未进行智能规划：当前将使用模板「${activeScriptDbTemplate.name}」。`
                    : "未进行智能规划：当前将使用你选中的模板。";
    const scriptDiagnostics = scriptContent ? diagnoseTrainingScript(scriptContent, modulePlan) : null;
    const scriptStructure = scriptContent ? extractScriptStructure(scriptContent) : { prefix: "", stages: [], suffix: "" };

    const handleRegenerateModule = useCallback(async () => {
        if (!modulePlan || !moduleRegenTargetId || !moduleRegenFeedback.trim()) return;
        const targetStageIndex = modulePlan.modules.findIndex((module) => module.id === moduleRegenTargetId);
        if (targetStageIndex < 0) return;

        const doc = await getDocContent();
        if (!doc) {
            setErrorMessage("请先提供教师任务文档，再进行单模块重生成");
            return;
        }

        setModuleRegenerating(true);
        setErrorMessage("");
        try {
            const currentStageMarkdown = scriptStructure.stages[targetStageIndex]?.markdown || "";
            const result = await regenerateTrainingScriptModule({
                teacherDocContent: doc.content || "",
                file: doc.file,
                teacherDocName: doc.name,
                modulePlan,
                targetModuleId: moduleRegenTargetId,
                feedback: moduleRegenFeedback,
                usePreviousResult: moduleRegenUsePrevious,
                currentStageMarkdown,
            });

            setScriptContent((prev) => replaceStageInScript(prev, result.stageIndex, result.stageMarkdown));
            setActiveTab("script");
            setModuleRegenFeedback("");
            setPhase("completed");
            setShowModuleRegenModal(false);
        } catch (err) {
            setErrorMessage(err instanceof Error ? err.message : "单模块重生成失败");
        } finally {
            setModuleRegenerating(false);
        }
    }, [getDocContent, modulePlan, moduleRegenFeedback, moduleRegenTargetId, moduleRegenUsePrevious, scriptStructure.stages]);

    const openModuleRegenerateModal = useCallback((moduleId: string) => {
        setModuleRegenTargetId(moduleId);
        setModuleRegenFeedback("");
        setModuleRegenUsePrevious(true);
        setShowModuleRegenModal(true);
    }, []);

    const handleOptimizationApplied = useCallback((result: OptimizationLoopResult) => {
        const optimizedDiagnostics = diagnoseTrainingScript(result.optimized_script_markdown, result.module_plan_used);
        if (optimizedDiagnostics.stageCount === 0 || !optimizedDiagnostics.canInject) {
            const firstError = optimizedDiagnostics.issues.find((issue) => issue.level === "error")?.message;
            setErrorMessage(
                firstError
                    ? `闭环优化返回的训练剧本结构异常（${firstError}），已阻止自动覆盖当前内容。你可以稍后重试，或改用单模块重生成。`
                    : "闭环优化返回的训练剧本结构异常，已阻止自动覆盖当前内容。你可以稍后重试，或改用单模块重生成。"
            );
            return;
        }

        const snapshot: OptimizationSnapshot = {
            id: `optimization_snapshot_${Date.now()}`,
            createdAt: Date.now(),
            taskName,
            summary: result.optimization_plan.summary,
            appliedActionCount: result.applied_actions.length,
            actionTitles: result.applied_actions.map((action) => action.title),
            scriptContent,
            rubricContent,
            modulePlan,
        };

        setOptimizationSnapshots((prev) => [snapshot, ...prev].slice(0, OPTIMIZATION_SNAPSHOT_LIMIT));
        setScriptContent(result.optimized_script_markdown);
        if (result.optimized_rubric_markdown) {
            setRubricContent(result.optimized_rubric_markdown);
        }
        setModulePlan(result.module_plan_used);
        if (!lastSystemPlan) {
            setLastSystemPlan(result.module_plan_used);
        }
        setActiveTab("script");
        setPhase("completed");
        setErrorMessage("");
        setLastOptimizationResult(result);
        setStatusMessage(`闭环优化完成：已自动应用 ${result.applied_actions.length} 条修订动作`);
    }, [lastSystemPlan, modulePlan, rubricContent, scriptContent, taskName]);

    const handleRestoreOptimizationSnapshot = useCallback((snapshotId: string) => {
        const snapshot = optimizationSnapshots.find((item) => item.id === snapshotId);
        if (!snapshot) return;

        setScriptContent(snapshot.scriptContent);
        setRubricContent(snapshot.rubricContent);
        setModulePlan(snapshot.modulePlan);
        setLastSystemPlan(snapshot.modulePlan);
        setTaskName(snapshot.taskName);
        setActiveTab("script");
        setPhase("completed");
        setLastOptimizationResult(null);
        setStatusMessage(`已回退到 ${new Date(snapshot.createdAt).toLocaleString()} 的优化前版本`);
    }, [optimizationSnapshots]);

    const focusModuleFromDiagnostic = useCallback((stageIndex?: number) => {
        if (stageIndex === undefined) return;

        setActiveTab("script");
        setFocusedStageIndex(null);
        window.requestAnimationFrame(() => setFocusedStageIndex(stageIndex));

        if (!modulePlan) return;
        const targetModule = modulePlan.modules[stageIndex];
        if (!targetModule) return;
        setShowPlanEditor(true);
        setFocusedModuleId(targetModule.id);
        setCollapsedModuleIds((prev) => prev.filter((id) => id !== targetModule.id));
    }, [modulePlan]);

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
                        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
                            <div>
                                <div className="flex items-center gap-2">
                                    <FileText className="w-4 h-4 text-indigo-500" />
                                    <span className="font-semibold text-slate-700 text-sm">教师任务文档</span>
                                </div>
                                {teacherDocCacheRestored && (
                                    <p className="mt-1 text-xs text-emerald-600">已从本地恢复上一次教师任务文档</p>
                                )}
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
                                    onChange={(e) => {
                                        setTextContent(e.target.value);
                                        setTeacherDocCacheRestored(false);
                                    }}
                                    placeholder="将教师任务文档内容粘贴到此处..."
                                    className="w-full h-48 p-4 border border-slate-200 rounded-xl text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300 resize-none transition-all"
                                />
                            )}
                        </div>
                    </div>

                    {/* 生成选项 */}
                    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
                        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <p className="text-sm font-semibold text-slate-700">生成内容</p>
                            <div className="flex items-center gap-1.5 text-xs text-slate-500 sm:justify-end">
                                <AlertCircle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                                <span>建议选择 Claude Sonnet 4.5 生成训练基本配置，不容易出现截断</span>
                            </div>
                        </div>
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

                    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
                            <div>
                                <p className="text-sm font-semibold text-slate-700">模块规划</p>
                                <p className="text-xs text-slate-500 mt-1">先规划模块，再逐模块调整类型。正式生成优先参考模块规划</p>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (modulePlan) {
                                            openPlanRegenerateModal();
                                            return;
                                        }
                                        void handlePlanScript();
                                    }}
                                    disabled={planning || !generateScript}
                                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 disabled:opacity-50 rounded-lg transition-colors"
                                >
                                    {planning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                                    {planning ? "规划中..." : modulePlan ? "重新规划" : "智能规划"}
                                </button>
                                {modulePlan && (
                                    <button
                                        type="button"
                                        onClick={clearModulePlan}
                                        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-rose-600 bg-rose-50 hover:bg-rose-100 rounded-lg transition-colors"
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                        清空规划
                                    </button>
                                )}
                                {modulePlan && (
                                    <button
                                        type="button"
                                        onClick={() => setShowPlanEditor((v) => !v)}
                                        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                                    >
                                        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showPlanEditor ? "rotate-180" : ""}`} />
                                        {showPlanEditor ? "收起" : "展开"}
                                    </button>
                                )}
                            </div>
                        </div>

                        <div className="p-5 space-y-4">
                            {!modulePlan ? (
                                <p className="text-xs text-slate-500">
                                    先根据教师文档生成模块规划。规划完成后，你可以直接修改模块标题、类型、目标和关键要点，再进入正式生成。
                                </p>
                            ) : (
                                <>
                                    {planCacheRestored && (
                                        <div className="px-3 py-2 rounded-lg bg-indigo-50 border border-indigo-100 text-xs text-indigo-700">
                                            已从本地缓存恢复上一次模块规划，可直接继续编辑；如当前教师文档已经更换，建议重新智能规划一次。
                                        </div>
                                    )}
                                    <div>
                                        <label className="text-xs font-medium text-slate-600 flex items-center gap-1.5 mb-1">
                                            <span>任务名称</span>
                                            {planAutofillTaskFields.includes("taskName") && (
                                                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700 text-[10px]">
                                                    自动补全
                                                </span>
                                            )}
                                        </label>
                                        <input
                                            value={modulePlan.taskName}
                                            onChange={(e) => updateModulePlanField("taskName", e.target.value)}
                                            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                                        />
                                    </div>

                                    <div>
                                        <label className="text-xs font-medium text-slate-600 flex items-center gap-1.5 mb-1">
                                            <span>整体训练目标</span>
                                            {planAutofillTaskFields.includes("overallObjective") && (
                                                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700 text-[10px]">
                                                    自动补全
                                                </span>
                                            )}
                                        </label>
                                        <textarea
                                            value={modulePlan.overallObjective}
                                            onChange={(e) => updateModulePlanField("overallObjective", e.target.value)}
                                            rows={3}
                                            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300 resize-y"
                                        />
                                    </div>

                                    <div className="flex flex-wrap gap-2">
                                        <span className="inline-flex items-center px-2 py-1 rounded-full bg-slate-100 text-slate-600 text-xs">
                                            模块数 {modulePlan.modules.length}
                                        </span>
                                        <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs ${planValidation.some((item) => item.level === "error")
                                            ? "bg-rose-100 text-rose-700"
                                            : planValidation.length > 0
                                                ? "bg-amber-100 text-amber-700"
                                                : "bg-emerald-100 text-emerald-700"
                                            }`}>
                                            {planValidation.some((item) => item.level === "error")
                                                ? `错误 ${planValidation.filter((item) => item.level === "error").length}`
                                                : planValidation.length > 0
                                                    ? `警告 ${planValidation.length}`
                                                    : "校验通过"}
                                        </span>
                                        {planAutofillApplied && (
                                            <span className="inline-flex items-center px-2 py-1 rounded-full bg-sky-100 text-sky-700 text-xs">
                                                已自动补全缺失字段
                                            </span>
                                        )}
                                        <button
                                            type="button"
                                            onClick={addModule}
                                            className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-indigo-100 text-indigo-700 text-xs hover:bg-indigo-200 transition-colors"
                                        >
                                            <Plus className="w-3 h-3" />
                                            新增模块
                                        </button>
                                    </div>

                                    {planValidation.length > 0 && (
                                        <div className="space-y-2">
                                            {planValidation.map((issue, index) => (
                                                <div
                                                    key={`${issue.message}-${index}`}
                                                    className={`px-3 py-2 rounded-lg text-xs ${issue.level === "error"
                                                        ? "bg-rose-50 text-rose-700 border border-rose-100"
                                                        : "bg-amber-50 text-amber-700 border border-amber-100"
                                                        }`}
                                                >
                                                    {issue.message}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {planAutofillApplied && planAutofillFields.length > 0 && (
                                        <div className="px-3 py-2 rounded-lg bg-sky-50 border border-sky-100 text-xs text-sky-700">
                                            系统已自动补全这些缺失字段：{planAutofillFields.join("、")}
                                        </div>
                                    )}

                                    {showPlanEditor && (
                                        <div className="space-y-4">
                                            <div className="px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600">
                                                模块类型决定具体阶段的生成方式。拖拽可排序，点击诊断结果可定位到对应模块。
                                            </div>
                                            {modulePlan.modules.map((module, index) => (
                                                (() => {
                                                    const autofilledModuleFields = planAutofillModuleFields[module.id] || [];
                                                    return (
                                                <div
                                                    key={module.id}
                                                    ref={(node) => { moduleCardRefs.current[module.id] = node; }}
                                                    draggable
                                                    onDragStart={() => setDraggingModuleId(module.id)}
                                                    onDragEnd={() => setDraggingModuleId(null)}
                                                    onDragOver={(e) => {
                                                        e.preventDefault();
                                                        setDragOverModuleId(module.id);
                                                    }}
                                                    onDragLeave={() => setDragOverModuleId((prev) => prev === module.id ? null : prev)}
                                                    onDrop={() => moveModuleByDrag(module.id)}
                                                    className={`border rounded-xl p-4 space-y-3 transition-all ${
                                                        focusedModuleId === module.id
                                                            ? "border-indigo-400 ring-2 ring-indigo-200 bg-indigo-50/70"
                                                            : draggingModuleId === module.id
                                                                ? "border-indigo-300 bg-indigo-50/60"
                                                                : dragOverModuleId === module.id
                                                                    ? "border-indigo-300 bg-indigo-50/40"
                                                                    : "border-slate-200"
                                                        }`}
                                                >
                                                    <div className="flex items-center justify-between gap-3">
                                                        <div className="flex items-center gap-2">
                                                            <button
                                                                type="button"
                                                                className="p-1 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-grab"
                                                                title="拖拽排序"
                                                            >
                                                                <GripVertical className="w-4 h-4" />
                                                            </button>
                                                            <p className="text-sm font-semibold text-slate-700">模块 {index + 1}</p>
                                                            {autofilledModuleFields.length > 0 && (
                                                                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700 text-[10px]">
                                                                    含自动补全字段
                                                                </span>
                                                            )}
                                                        </div>
                                                        <div className="flex items-center gap-2">
                                                            <button
                                                                type="button"
                                                                onClick={() => toggleModuleCollapsed(module.id)}
                                                                className="p-1.5 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
                                                                title={collapsedModuleIds.includes(module.id) ? "展开模块" : "收起模块"}
                                                            >
                                                                <ChevronDown className={`w-4 h-4 transition-transform ${collapsedModuleIds.includes(module.id) ? "-rotate-90" : ""}`} />
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onClick={() => openModuleRegenerateModal(module.id)}
                                                                disabled={!scriptContent || phase !== "completed"}
                                                                className="p-1.5 rounded-md text-slate-400 hover:text-violet-600 hover:bg-violet-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                                                title={scriptContent && phase === "completed" ? "单模块重生成" : "请先生成完整剧本后再进行单模块重生成"}
                                                            >
                                                                <RotateCcw className="w-4 h-4" />
                                                            </button>
                                                            <select
                                                                value={module.moduleType}
                                                                onChange={(e) => updateModule(module.id, (prev) => ({ ...prev, moduleType: e.target.value as typeof prev.moduleType }))}
                                                                className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                                                            >
                                                                {Object.entries(SCRIPT_MODE_LABELS).map(([value, label]) => (
                                                                    <option key={value} value={value}>{label}</option>
                                                                ))}
                                                            </select>
                                                            <button
                                                                type="button"
                                                                onClick={() => removeModule(module.id)}
                                                                disabled={modulePlan.modules.length <= 1}
                                                                className="p-1.5 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                                                title="删除模块"
                                                            >
                                                                <Trash2 className="w-4 h-4" />
                                                            </button>
                                                        </div>
                                                    </div>

                                                    {dragOverModuleId === module.id && draggingModuleId && draggingModuleId !== module.id && (
                                                        <div className="px-3 py-2 rounded-lg bg-indigo-100 text-indigo-700 text-xs border border-indigo-200">
                                                            松手后会把当前拖拽模块移动到这里
                                                        </div>
                                                    )}

                                                    {!collapsedModuleIds.includes(module.id) && (
                                                        <>
                                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                                        <div>
                                                            <label className="text-xs font-medium text-slate-600 flex items-center gap-1.5 mb-1">
                                                                <span>标题</span>
                                                                {autofilledModuleFields.includes("title") && (
                                                                    <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700 text-[10px]">
                                                                        自动补全
                                                                    </span>
                                                                )}
                                                            </label>
                                                            <input
                                                                value={module.title}
                                                                onChange={(e) => updateModule(module.id, (prev) => ({ ...prev, title: e.target.value }))}
                                                                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                                                            />
                                                        </div>
                                                        <div>
                                                            <label className="text-xs font-medium text-slate-600 block mb-1">建议轮次</label>
                                                            <input
                                                                type="number"
                                                                min={1}
                                                                max={10}
                                                                value={module.suggestedRounds}
                                                                onChange={(e) => updateModule(module.id, (prev) => ({ ...prev, suggestedRounds: Number(e.target.value) || 1 }))}
                                                                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                                                            />
                                                        </div>
                                                    </div>

                                                    <div>
                                                        <label className="text-xs font-medium text-slate-600 flex items-center gap-1.5 mb-1">
                                                            <span>训练目的</span>
                                                            {autofilledModuleFields.includes("objective") && (
                                                                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700 text-[10px]">
                                                                    自动补全
                                                                </span>
                                                            )}
                                                        </label>
                                                        <textarea
                                                            value={module.objective}
                                                            onChange={(e) => updateModule(module.id, (prev) => ({ ...prev, objective: e.target.value }))}
                                                            rows={2}
                                                            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300 resize-y"
                                                        />
                                                    </div>

                                                    <div>
                                                        <label className="text-xs font-medium text-slate-600 flex items-center gap-1.5 mb-1">
                                                            <span>模块说明</span>
                                                            {autofilledModuleFields.includes("description") && (
                                                                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700 text-[10px]">
                                                                    自动补全
                                                                </span>
                                                            )}
                                                        </label>
                                                        <textarea
                                                            value={module.description}
                                                            onChange={(e) => updateModule(module.id, (prev) => ({ ...prev, description: e.target.value }))}
                                                            rows={3}
                                                            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300 resize-y"
                                                        />
                                                    </div>

                                                    <div>
                                                        <label className="text-xs font-medium text-slate-600 flex items-center gap-1.5 mb-1">
                                                            <span>关键要点（每行一个）</span>
                                                            {autofilledModuleFields.includes("keyPoints") && (
                                                                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700 text-[10px]">
                                                                    自动补全
                                                                </span>
                                                            )}
                                                        </label>
                                                        <textarea
                                                            value={module.keyPoints.join("\n")}
                                                            onChange={(e) => updateModule(module.id, (prev) => ({
                                                                ...prev,
                                                                keyPoints: e.target.value.split("\n").map((item) => item.trim()).filter(Boolean),
                                                            }))}
                                                            rows={3}
                                                            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300 resize-y"
                                                        />
                                                    </div>
                                                        </>
                                                    )}
                                                </div>
                                                    );
                                                })()
                                            ))}
                                        </div>
                                    )}
                                </>
                            )}
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
                                {(scriptTemplate !== activeDefaultScriptTemplate || rubricTemplate !== DEFAULT_RUBRIC_TEMPLATE) && (
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
                                            {activePromptTab === "script" && (
                                                <>
                                                    {orderedBuiltInScriptTemplateOptions.map((option) => (
                                                        <option key={option.id} value={option.id}>
                                                            {option.label}
                                                            {recommendedBuiltInTemplateId === option.id ? " ⭐推荐" : ""}
                                                        </option>
                                                    ))}
                                                </>
                                            )}
                                            {activePromptTab === "rubric" && (
                                                <option value="default">内置默认模板</option>
                                            )}
                                            {dbTemplates
                                                .filter(t => t.type === activePromptTab)
                                                .filter(t => !(activePromptTab === "script" && t.is_default))
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
                                    {activePromptTab === "script" && (
                                        <p className="text-xs text-indigo-600 bg-indigo-50 border border-indigo-100 rounded-lg px-2.5 py-2">
                                            {scriptTemplateModeHint}
                                        </p>
                                    )}

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
                                                onClick={() => { setScriptTemplate(DEFAULT_SCRIPT_TEMPLATE); setSelectedScriptTemplateId(BUILTIN_TEMPLATE_ORIGINAL); }}
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
                    </div>

                    {/* 未配置 API 提示 */}
                    {!isApiConfigured() && (
                        <div className="flex items-start gap-2.5 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                            <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                            <p className="text-xs text-amber-700">
                                请先在导航栏「设置」中配置 API 地址；如你的服务需要鉴权，再额外填写 API Key。
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
                                {scriptContent && (
                                    <button
                                        onClick={() => setShowOptimizationModal(true)}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors"
                                        title="基于对话记录自动分析并修订当前训练剧本"
                                    >
                                        <Sparkles className="w-3.5 h-3.5" />
                                        闭环优化
                                    </button>
                                )}
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

                    {phase === "completed" && generateScript && scriptDiagnostics && activeTab === "script" && (
                        <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/60 space-y-2">
                            <div className="flex items-center justify-between gap-3 text-xs">
                                <span className="text-slate-500">结构诊断</span>
                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full font-medium ${scriptDiagnostics.canInject ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                                    {scriptDiagnostics.canInject ? "可注入" : "存在阻塞问题"}
                                </span>
                            </div>
                            {scriptDiagnostics.issues.length === 0 ? (
                                <p className="text-xs text-emerald-700">未发现结构问题，当前剧本满足基础注入要求。</p>
                            ) : (
                                <div className="space-y-1.5 max-h-32 overflow-y-auto">
                                    {scriptDiagnostics.issues.map((issue, index) => (
                                                <div
                                                    key={`${issue.message}-${index}`}
                                                    onClick={() => focusModuleFromDiagnostic(issue.stageIndex)}
                                                    className={`px-2.5 py-2 rounded-lg text-xs ${issue.level === "error" ? "bg-rose-50 text-rose-700 border border-rose-100" : "bg-amber-50 text-amber-700 border border-amber-100"} ${issue.stageIndex !== undefined ? "cursor-pointer hover:shadow-sm" : ""}`}
                                                >
                                                    {issue.stageIndex !== undefined ? `阶段 ${issue.stageIndex + 1}：` : ""}
                                                    {issue.message}
                                                    {issue.stageIndex !== undefined && (
                                                        <span className="ml-2 inline-flex items-center gap-1 text-[11px] opacity-80">
                                                            <Crosshair className="w-3 h-3" />
                                                            定位模块
                                                        </span>
                                                    )}
                                                </div>
                                            ))}
                                </div>
                            )}
                        </div>
                    )}

                    {phase === "completed" && activeTab === "script" && (lastOptimizationResult || optimizationSnapshots.length > 0) && (
                        <div className="px-5 py-3 border-b border-slate-100 bg-indigo-50/40 space-y-3">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <div className="text-xs text-slate-500">闭环优化快照</div>
                                    <div className="text-sm font-semibold text-slate-800">最近的优化结果与回退版本</div>
                                </div>
                                {optimizationSnapshots.length > 0 && (
                                    <span className="inline-flex items-center px-2 py-1 rounded-full bg-white border border-indigo-100 text-xs text-indigo-700">
                                        可回退 {optimizationSnapshots.length} 个版本
                                    </span>
                                )}
                            </div>

                            {lastOptimizationResult && (
                                <div className="rounded-xl border border-indigo-200 bg-white px-4 py-3 space-y-2">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="inline-flex items-center px-2 py-1 rounded-full bg-emerald-100 text-emerald-700 text-xs font-medium">
                                            已应用 {lastOptimizationResult.applied_actions.length} 条修订
                                        </span>
                                        {lastOptimizationResult.evaluation_template_name && (
                                            <span className="inline-flex items-center px-2 py-1 rounded-full bg-indigo-100 text-indigo-700 text-xs font-medium">
                                                评测模板：{lastOptimizationResult.evaluation_template_name}
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-sm text-slate-700 whitespace-pre-wrap">
                                        {lastOptimizationResult.optimization_plan.summary}
                                    </p>
                                    {lastOptimizationResult.applied_actions.length > 0 && (
                                        <div className="flex flex-wrap gap-2">
                                            {lastOptimizationResult.applied_actions.map((action) => (
                                                <span key={action.id} className="inline-flex items-center px-2 py-1 rounded-full bg-slate-100 text-slate-700 text-xs">
                                                    {action.module_title || action.target_module_id || `阶段 ${action.target_stage_number || "-"}`}：{action.title}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            {optimizationSnapshots.length > 0 && (
                                <div className="space-y-2">
                                    {optimizationSnapshots.slice(0, 3).map((snapshot) => (
                                        <div key={snapshot.id} className="rounded-xl border border-slate-200 bg-white px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                            <div className="min-w-0">
                                                <div className="text-xs text-slate-500">
                                                    优化前快照 · {new Date(snapshot.createdAt).toLocaleString()}
                                                </div>
                                                <div className="text-sm text-slate-800 line-clamp-2">
                                                    {snapshot.summary}
                                                </div>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => handleRestoreOptimizationSnapshot(snapshot.id)}
                                                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors shrink-0"
                                            >
                                                <RotateCcw className="w-3.5 h-3.5" />
                                                回退到此版本
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* 内容区 */}
                    <div ref={resultPaneRef} className="flex-1 overflow-y-auto p-5">
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
                                {isAutoRecoveryStatus && (
                                    <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                                        <RefreshCw className="w-4 h-4 text-amber-600 animate-spin flex-shrink-0" />
                                        <div>
                                            <p className="text-sm font-medium text-amber-700">系统正在自动补救（断点续写/重试）</p>
                                            <p className="text-xs text-amber-600 mt-0.5">无需手动操作，请稍候，系统会在补全后自动继续输出。</p>
                                        </div>
                                    </div>
                                )}

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

            {showPlanRegenerateModal && modulePlan && (
                <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => !planning && setShowPlanRegenerateModal(false)}>
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden animate-in zoom-in-95" onClick={(e) => e.stopPropagation()}>
                        <div className="bg-gradient-to-r from-indigo-600 to-violet-600 p-4 text-white">
                            <h3 className="font-bold text-lg flex items-center gap-2">
                                <Sparkles className="w-5 h-5" />
                                整体重新规划
                            </h3>
                            <p className="text-indigo-100 text-sm mt-1">
                                结合教师文档、你的修改意见，以及当前页面规划重新生成模块结构
                            </p>
                        </div>
                        <div className="p-5 space-y-4">
                            <div className="space-y-2">
                                <p className="text-sm font-medium text-slate-700">重新规划依据</p>
                                <label className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-sm cursor-pointer transition-colors ${planRegenerateSource === "current_edited" ? "bg-indigo-50 border-indigo-200 text-indigo-700" : "bg-slate-50 border-slate-200 text-slate-600"}`}>
                                    <input
                                        type="radio"
                                        name="plan-regenerate-source"
                                        checked={planRegenerateSource === "current_edited"}
                                        onChange={() => setPlanRegenerateSource("current_edited")}
                                        disabled={planning}
                                        className="w-4 h-4 mt-0.5 border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                    />
                                    <span>基于当前页面已编辑的模块规划继续优化</span>
                                </label>
                                <label className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-sm cursor-pointer transition-colors ${planRegenerateSource === "previous_plan" ? "bg-indigo-50 border-indigo-200 text-indigo-700" : "bg-slate-50 border-slate-200 text-slate-600"}`}>
                                    <input
                                        type="radio"
                                        name="plan-regenerate-source"
                                        checked={planRegenerateSource === "previous_plan"}
                                        onChange={() => setPlanRegenerateSource("previous_plan")}
                                        disabled={planning || !lastSystemPlan}
                                        className="w-4 h-4 mt-0.5 border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                    />
                                    <span>{lastSystemPlan ? "参考上一次系统规划" : "参考上一次系统规划（当前暂无可参考快照）"}</span>
                                </label>
                                <label className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-sm cursor-pointer transition-colors ${planRegenerateSource === "teacher_doc_only" ? "bg-indigo-50 border-indigo-200 text-indigo-700" : "bg-slate-50 border-slate-200 text-slate-600"}`}>
                                    <input
                                        type="radio"
                                        name="plan-regenerate-source"
                                        checked={planRegenerateSource === "teacher_doc_only"}
                                        onChange={() => setPlanRegenerateSource("teacher_doc_only")}
                                        disabled={planning}
                                        className="w-4 h-4 mt-0.5 border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                    />
                                    <span>不参考旧规划，仅按教师文档和修改意见重来</span>
                                </label>
                            </div>
                            <div>
                                <label className="text-sm font-medium text-slate-700 block mb-1">修改意见</label>
                                <textarea
                                    value={planRegenerateFeedback}
                                    onChange={(e) => setPlanRegenerateFeedback(e.target.value)}
                                    rows={5}
                                    disabled={planning}
                                    placeholder="例如：文档里实际有 8 个阶段，不要合并第 5/6/7 阶段；新增一个独立的总结模块；保留我刚才手动拆分出来的结构。"
                                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 resize-y"
                                />
                            </div>
                            <p className="text-xs text-slate-500">
                                {planRegenerateSource === "current_edited"
                                    ? "当前模式：始终会带上原始教师文档和你的修改建议，并优先参考你在页面上已经手动修改过的模块结构。"
                                    : planRegenerateSource === "previous_plan"
                                        ? "当前模式：始终会带上原始教师文档和你的修改建议，并参考上一次系统规划结果，但不直接继承当前页面的手动编辑内容。"
                                        : "当前模式：始终会带上原始教师文档和你的修改建议，但不参考旧规划，直接重新规划。"}
                            </p>
                        </div>
                        <div className="flex gap-3 p-5 pt-0">
                            <button
                                onClick={() => setShowPlanRegenerateModal(false)}
                                disabled={planning}
                                className="flex-1 px-4 py-2.5 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors disabled:opacity-50"
                            >
                                取消
                            </button>
                            <button
                                onClick={() => void handleRegeneratePlan()}
                                disabled={planning}
                                className="flex-1 px-4 py-2.5 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-lg transition-colors flex items-center justify-center gap-1.5"
                            >
                                {planning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                                {planning ? "重新规划中..." : "开始重新规划"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {showModuleRegenModal && modulePlan && (
                <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => !moduleRegenerating && setShowModuleRegenModal(false)}>
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden animate-in zoom-in-95" onClick={(e) => e.stopPropagation()}>
                        <div className="bg-gradient-to-r from-violet-600 to-indigo-600 p-4 text-white">
                            <h3 className="font-bold text-lg flex items-center gap-2">
                                <RotateCcw className="w-5 h-5" />
                                单模块重生成
                            </h3>
                            <p className="text-violet-100 text-sm mt-1">
                                只替换一个阶段，其余阶段保持不变
                            </p>
                        </div>
                        <div className="p-5 space-y-4">
                            <div>
                                <label className="text-sm font-medium text-slate-700 block mb-1">目标模块</label>
                                <select
                                    value={moduleRegenTargetId}
                                    onChange={(e) => setModuleRegenTargetId(e.target.value)}
                                    disabled={moduleRegenerating}
                                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500"
                                >
                                    {modulePlan.modules.map((module, index) => (
                                        <option key={module.id} value={module.id}>
                                            阶段 {index + 1} · {module.title || `模块 ${index + 1}`}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <label className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm text-slate-600">
                                <input
                                    type="checkbox"
                                    checked={moduleRegenUsePrevious}
                                    onChange={(e) => setModuleRegenUsePrevious(e.target.checked)}
                                    disabled={moduleRegenerating}
                                    className="w-4 h-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500"
                                />
                                参考当前阶段结果再修订
                            </label>
                            <div>
                                <label className="text-sm font-medium text-slate-700 block mb-1">修改建议</label>
                                <textarea
                                    value={moduleRegenFeedback}
                                    onChange={(e) => setModuleRegenFeedback(e.target.value)}
                                    rows={4}
                                    disabled={moduleRegenerating}
                                    placeholder={moduleRegenUsePrevious ? "例如：保留原有结构，但把这一阶段的追问更聚焦，并减少提示泄题。" : "例如：不要参考当前版本，直接把这一阶段改成模拟人物型问答。"}
                                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 resize-y"
                                />
                            </div>
                            <p className="text-xs text-slate-500">
                                {moduleRegenUsePrevious
                                    ? "当前模式：参考原阶段结果，并结合你的修改建议进行局部修订。"
                                    : "当前模式：忽略原阶段结果，直接根据教师文档、模块规划和你的建议重新生成该阶段。"}
                            </p>
                        </div>
                        <div className="flex gap-3 p-5 pt-0">
                            <button
                                onClick={() => setShowModuleRegenModal(false)}
                                disabled={moduleRegenerating}
                                className="flex-1 px-4 py-2.5 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors disabled:opacity-50"
                            >
                                取消
                            </button>
                            <button
                                onClick={handleRegenerateModule}
                                disabled={moduleRegenerating || !moduleRegenFeedback.trim() || !moduleRegenTargetId}
                                className="flex-1 px-4 py-2.5 text-sm font-semibold text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-50 rounded-lg transition-colors flex items-center justify-center gap-1.5"
                            >
                                {moduleRegenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                                {moduleRegenerating ? "重生成中..." : "开始重生成"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 设置弹窗 */}
            <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />

            <TrainingOptimizationModal
                isOpen={showOptimizationModal}
                onClose={() => setShowOptimizationModal(false)}
                getDocContent={getDocContent}
                scriptMarkdown={scriptContent}
                rubricMarkdown={rubricContent}
                modulePlan={modulePlan}
                onOptimizationApplied={handleOptimizationApplied}
            />

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
