"use client";

import React, { useState, useEffect, useRef } from "react";
import { X, Shield, Key, FilePlus, Loader2, CheckCircle2, AlertCircle, Play, Cpu, Upload, ChevronDown, ChevronRight, FileText, RefreshCw, Plus, ArrowUp, ArrowDown, Trash2 } from "lucide-react";
import { getModels, ModelInfo } from "@/lib/api";
import { ParsedStep, PolymasCredentials, InjectProgressEvent, InjectSummary } from "@/lib/training-injector/types";
import { parsePolymasUrl } from "@/lib/training-injector/api";
import { AVAILABLE_MODELS } from "@/lib/config";
import {
    DEFAULT_IMAGE_MODEL,
    LLM_SETTINGS_STORAGE_KEY,
    loadLLMSettingsFromStorage,
} from "@/lib/llm/settings";
import { diagnoseTrainingScript } from "@/lib/training-generator/script-tools";
import { ParsedTaskConfig, parseRubricMarkdown, parseTaskConfig, parseTrainingScript, serializeTrainingScriptMarkdown } from "@/lib/training-injector/parser";

interface InjectConfigModalProps {
    isOpen: boolean;
    onClose: () => void;
    scriptMarkdown?: string;
    rubricMarkdown?: string;
}

const STORAGE_KEY = "training-injector-credentials";
const TASK_CONTEXT_STORAGE_KEY = "training-injector-task-contexts";
const IMAGE_PROVIDER_OPTIONS = [
    { id: "cloudapi", name: "cloudapi（优先）" },
    { id: "openai", name: "OpenAI 兼容接口（优先）" },
];
const IMAGE_MODEL_OPTIONS = [
    { id: "doubao-seedream-5-0-260128", name: "豆包 Seedream 5.0", description: "推荐默认生图模型" },
    { id: "doubao-seedream-4-0-250828", name: "豆包 Seedream 4.0", description: "兼容的 Seedream 生图模型" },
    { id: "dall-e-3", name: "DALL-E 3", description: "OpenAI 图像生成模型" },
    { id: "gpt-image-1.5", name: "GPT Image 1.5", description: "OpenAI 图像生成模型" },
];
const BACKGROUND_IMAGE_CONCURRENCY = 2;

interface StoredTaskContext {
    courseId: string;
    libraryFolderId: string;
    updatedAt: number;
}

function readStoredTaskContexts(): Record<string, StoredTaskContext> {
    if (typeof window === "undefined") return {};
    try {
        const raw = localStorage.getItem(TASK_CONTEXT_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed as Record<string, StoredTaskContext> : {};
    } catch {
        return {};
    }
}

function writeStoredTaskContexts(contexts: Record<string, StoredTaskContext>) {
    if (typeof window === "undefined") return;
    try {
        localStorage.setItem(TASK_CONTEXT_STORAGE_KEY, JSON.stringify(contexts));
    } catch {
        // ignore
    }
}

function getStoredTaskContext(trainTaskId: string): StoredTaskContext | null {
    const key = String(trainTaskId || "").trim();
    if (!key) return null;
    const contexts = readStoredTaskContexts();
    return contexts[key] || null;
}

function persistTaskContext(trainTaskId: string, courseId?: string, libraryFolderId?: string) {
    const key = String(trainTaskId || "").trim();
    if (!key) return;

    const contexts = readStoredTaskContexts();
    const existing = contexts[key];
    const nextCourseId = String(courseId || "").trim() || existing?.courseId || "";
    const nextLibraryFolderId = String(libraryFolderId || "").trim() || existing?.libraryFolderId || "";

    if (!nextCourseId && !nextLibraryFolderId) return;

    contexts[key] = {
        courseId: nextCourseId,
        libraryFolderId: nextLibraryFolderId,
        updatedAt: Date.now(),
    };
    writeStoredTaskContexts(contexts);
}

function normalizeStageNameForAppend(value: unknown): string {
    return String(value || "")
        .trim()
        .replace(/^阶段\s*[\d一二三四五六七八九十]+[：:、.\-\s]*/u, "")
        .replace(/\s+/g, "")
        .toLowerCase();
}

interface StageOption {
    stepId: string;
    stepName: string;
    stepSnapshot?: {
        stepName?: string;
        description?: string;
        prologue?: string;
        modelId?: string;
        llmPrompt?: string;
        trainerName?: string;
        interactiveRounds?: number;
        agentId?: string;
        avatarNid?: string;
        position?: {
            x?: number;
            y?: number;
        };
    };
}

function createEmptyParsedStep(stageNumber: number): ParsedStep {
    return {
        stepName: `新阶段${stageNumber}`,
        trainerName: "",
        modelId: "",
        agentId: "",
        avatarNid: "",
        description: "",
        prologue: "",
        llmPrompt: "",
        interactiveRounds: 6,
        backgroundImage: "",
        flowCondition: "",
        transitionPrompt: "",
        scriptStepCover: {},
    };
}

export function InjectConfigModal({
    isOpen,
    onClose,
    scriptMarkdown,
    rubricMarkdown,
}: InjectConfigModalProps) {
    // --- 表单状态 ---
    const [authorization, setAuthorization] = useState("");
    const [cookie, setCookie] = useState("");
    const [userNid, setUserNid] = useState("");
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
    const [extractionMode, setExtractionMode] = useState<"hybrid" | "llm" | "regex">("regex");
    const [llmModel, setLlmModel] = useState("");
    const [availableLlmModels, setAvailableLlmModels] = useState<ModelInfo[]>(AVAILABLE_MODELS);
    const [availableImageModels, setAvailableImageModels] = useState<ModelInfo[]>(IMAGE_MODEL_OPTIONS);
    const [coverStylePrompt, setCoverStylePrompt] = useState("图中禁止有任何文字和英文单词！写实风格，专业级渲染， 电影级光影 高清细节，16:9宽屏构图，尽量不要出现西方面孔");
    const [backgroundStylePrompt, setBackgroundStylePrompt] = useState("图中禁止有任何文字和英文单词！写实风格，专业级渲染，电影级光影，16:9宽屏构图，单一完整场景，适合作为教学阶段背景，尽量不要出现西方面孔");
    const [imageProviderMode, setImageProviderMode] = useState<"cloudapi" | "openai">("cloudapi");
    const [imageModel, setImageModel] = useState(DEFAULT_IMAGE_MODEL);
    const [taskContextHint, setTaskContextHint] = useState("");
    const [cloudapiProbeStatus, setCloudapiProbeStatus] = useState<"idle" | "testing" | "success" | "failed">("idle");
    const [cloudapiProbeMessage, setCloudapiProbeMessage] = useState("");
    const [cloudapiProbeCredentialKey, setCloudapiProbeCredentialKey] = useState("");
    const [injectCoverImage, setInjectCoverImage] = useState(true);
    const [injectBackgroundImage, setInjectBackgroundImage] = useState(true);
    const [regenTarget, setRegenTarget] = useState<"cover" | "background" | "all">("cover");
    const [regenStages, setRegenStages] = useState<StageOption[]>([]);
    const [regenStepId, setRegenStepId] = useState("");
    const [loadingStages, setLoadingStages] = useState(false);
    const [regeneratingImage, setRegeneratingImage] = useState(false);
    const [regenMessage, setRegenMessage] = useState("");

    // --- 自定义文档状态 ---
    const [customDocExpanded, setCustomDocExpanded] = useState(false);
    const [customDocMode, setCustomDocMode] = useState<"combined" | "separate">("combined");
    const [customCombinedText, setCustomCombinedText] = useState("");
    const [customScriptText, setCustomScriptText] = useState("");
    const [customRubricText, setCustomRubricText] = useState("");
    const [parsedJsonExpanded, setParsedJsonExpanded] = useState(false);
    const [structuredEditorExpanded, setStructuredEditorExpanded] = useState(false);
    const [expandedStructuredStages, setExpandedStructuredStages] = useState<Record<number, boolean>>({});

    const imageProviderPriority = imageProviderMode === "openai" ? "openai,cloudapi" : "cloudapi,openai";
    const switchedImageProviderPriority = imageProviderMode === "openai" ? "cloudapi,openai" : "openai,cloudapi";

    const logsEndRef = useRef<HTMLDivElement>(null);
    const combinedFileRef = useRef<HTMLInputElement>(null);
    const scriptFileRef = useRef<HTMLInputElement>(null);
    const rubricFileRef = useRef<HTMLInputElement>(null);

    // 计算最终生效的 markdown 文本（自定义文档覆盖生成的文档）
    const hasCustomDoc = (
        customDocMode === "combined"
            ? customCombinedText.trim().length > 0
            : (customScriptText.trim().length > 0 || customRubricText.trim().length > 0)
    );

    const effectiveScriptMd = customDocMode === "combined"
        ? (customCombinedText.trim() ? customCombinedText : scriptMarkdown)
        : (customScriptText.trim() ? customScriptText : scriptMarkdown);

    const effectiveRubricMd = customDocMode === "combined"
        ? (customCombinedText.trim() ? customCombinedText : rubricMarkdown)
        : (customRubricText.trim() ? customRubricText : rubricMarkdown);
    const reviewTaskConfig = effectiveScriptMd ? parseTaskConfig(effectiveScriptMd) : null;
    const reviewParsedSteps = effectiveScriptMd ? parseTrainingScript(effectiveScriptMd) : [];
    const reviewScriptDiagnostics = effectiveScriptMd ? diagnoseTrainingScript(effectiveScriptMd) : null;
    const reviewRubricItems = effectiveRubricMd ? parseRubricMarkdown(effectiveRubricMd) : [];
    const reviewParsedJson = reviewParsedSteps.length > 0
        ? JSON.stringify(reviewParsedSteps, null, 2)
        : "";
    const llmModelOptions = availableLlmModels.some((item) => item.id === llmModel) || !llmModel
        ? availableLlmModels
        : [
            {
                id: llmModel,
                name: llmModel,
                description: "当前已保存模型",
            },
            ...availableLlmModels,
        ];
    const imageModelOptions = availableImageModels.some((item) => item.id === imageModel) || !imageModel
        ? availableImageModels
        : [
            {
                id: imageModel,
                name: imageModel,
                description: "当前已保存图片模型",
            },
            ...availableImageModels,
        ];

    const refreshAvailableModels = async (nextApiUrl?: string, nextApiKey?: string) => {
        return getModels({
            baseUrl: nextApiUrl || "",
            apiKey: nextApiKey || "",
        })
            .then((data) => {
                if (data.models?.length) {
                    setAvailableLlmModels(data.models);
                }
                const imageGroup = data.groups?.find((group) => group.key === "image");
                if (imageGroup?.models?.length) {
                    setAvailableImageModels(imageGroup.models);
                }
            })
            .catch((err) => {
                console.error("Failed to fetch inject models:", err);
            });
    };

    // 回填可用的数据开关
    useEffect(() => {
        setInjectScript(!!scriptMarkdown);
        setInjectRubric(!!rubricMarkdown);
    }, [scriptMarkdown, rubricMarkdown, isOpen]);

    // 自定义文档变化时同步注入开关
    useEffect(() => {
        if (!hasCustomDoc) return;
        if (customDocMode === "combined") {
            const hasCombined = customCombinedText.trim().length > 0;
            if (hasCombined) {
                setInjectScript(true);
                setInjectRubric(true);
            }
        } else {
            if (customScriptText.trim().length > 0) {
                setInjectScript(true);
            }
            if (customRubricText.trim().length > 0) {
                setInjectRubric(true);
            }
        }
    }, [hasCustomDoc, customDocMode, customCombinedText, customScriptText, customRubricText]);

    useEffect(() => {
        if (isOpen && typeof window !== "undefined") {
            try {
                const stored = localStorage.getItem(STORAGE_KEY);
                if (stored) {
                    const parsed = JSON.parse(stored) as PolymasCredentials;
                    setAuthorization(parsed.authorization || "");
                    setCookie(parsed.cookie || "");
                    setUserNid(parsed.userNid || "");
                }
            } catch {
                // ignore
            }
            const llmSettings = loadLLMSettingsFromStorage("trainingInject");
            setLlmModel(llmSettings.model || "");
            setImageModel(llmSettings.imageModel || DEFAULT_IMAGE_MODEL);
            void refreshAvailableModels(llmSettings.apiUrl, llmSettings.apiKey);
        } else {
            // 关闭时重置状态
            if (!injecting) {
                setProgressLogs([]);
                setError("");
                setSummary(null);
                setTaskContextHint("");
                setCloudapiProbeStatus("idle");
                setCloudapiProbeMessage("");
                setCloudapiProbeCredentialKey("");
            }
        }
    }, [isOpen]);

    useEffect(() => {
        setCloudapiProbeStatus("idle");
        setCloudapiProbeMessage("");
        setCloudapiProbeCredentialKey("");
    }, [authorization, cookie, userNid]);

    // 自动滚动日志
    useEffect(() => {
        if (logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [progressLogs]);

    // 读取上传的 .md 文件内容
    const handleFileUpload = (
        e: React.ChangeEvent<HTMLInputElement>,
        setter: (v: string) => void
    ) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            setter(reader.result as string);
        };
        reader.readAsText(file);
        // 重置 input 以允许重新选择同一文件
        e.target.value = "";
    };

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
                userNid: userNid.trim(),
            })
        );
        return true;
    };

    const loadCurrentGeneratedDocsIntoEditor = () => {
        setCustomDocExpanded(true);
        setCustomDocMode("separate");
        if (scriptMarkdown) {
            setCustomScriptText(scriptMarkdown);
        }
        if (rubricMarkdown) {
            setCustomRubricText(rubricMarkdown);
        }
    };

    const writeStructuredScriptToCustomEditor = (
        nextTaskConfig: Partial<ParsedTaskConfig> | null,
        nextSteps: ParsedStep[]
    ) => {
        const sourceMarkdown = effectiveScriptMd || scriptMarkdown || "";
        const serialized = serializeTrainingScriptMarkdown({
            taskConfig: nextTaskConfig,
            steps: nextSteps,
            sourceMarkdown,
        });

        setCustomDocExpanded(true);
        if (customDocMode === "combined" && customCombinedText.trim() && !customRubricText.trim()) {
            setCustomRubricText(customCombinedText);
        }
        setCustomDocMode("separate");
        setCustomCombinedText("");
        setCustomScriptText(serialized);
        setInjectScript(true);
    };

    const handleStructuredTaskConfigChange = (
        field: keyof ParsedTaskConfig,
        value: string
    ) => {
        const nextTaskConfig: ParsedTaskConfig = {
            trainTaskName: reviewTaskConfig?.trainTaskName || "训练任务",
            description: reviewTaskConfig?.description || "",
            [field]: value,
        };
        writeStructuredScriptToCustomEditor(nextTaskConfig, reviewParsedSteps);
    };

    const handleStructuredStageChange = (
        stageIndex: number,
        field: keyof ParsedStep,
        value: string | number
    ) => {
        const nextSteps = reviewParsedSteps.map((step, index) => {
            if (index !== stageIndex) return step;
            const nextStep: ParsedStep = { ...step };
            if (field === "interactiveRounds") {
                const numericValue = typeof value === "number"
                    ? value
                    : Number.parseInt(String(value || "").replace(/[^\d]/g, ""), 10);
                nextStep.interactiveRounds = Number.isFinite(numericValue) ? numericValue : 0;
            } else {
                (nextStep[field] as string) = String(value ?? "");
            }
            return nextStep;
        });
        writeStructuredScriptToCustomEditor(reviewTaskConfig, nextSteps);
    };

    const toggleStructuredStage = (stageIndex: number) => {
        setExpandedStructuredStages((prev) => ({
            ...prev,
            [stageIndex]: !prev[stageIndex],
        }));
    };

    const handleAddStructuredStage = (insertAfterIndex?: number) => {
        const insertIndex = insertAfterIndex === undefined
            ? reviewParsedSteps.length
            : insertAfterIndex + 1;
        const nextSteps = [...reviewParsedSteps];
        nextSteps.splice(insertIndex, 0, createEmptyParsedStep(insertIndex + 1));
        writeStructuredScriptToCustomEditor(reviewTaskConfig, nextSteps);
        setStructuredEditorExpanded(true);
        setExpandedStructuredStages({ [insertIndex]: true });
    };

    const handleDeleteStructuredStage = (stageIndex: number) => {
        if (reviewParsedSteps.length <= 1) {
            setError("至少保留 1 个训练阶段；如果想重建，可以先新增一个空阶段再删除当前阶段。");
            return;
        }

        const nextSteps = reviewParsedSteps.filter((_, index) => index !== stageIndex);
        writeStructuredScriptToCustomEditor(reviewTaskConfig, nextSteps);
        setExpandedStructuredStages(nextSteps.length > 0 ? { [Math.max(0, stageIndex - 1)]: true } : {});
    };

    const handleMoveStructuredStage = (stageIndex: number, direction: "up" | "down") => {
        const targetIndex = direction === "up" ? stageIndex - 1 : stageIndex + 1;
        if (targetIndex < 0 || targetIndex >= reviewParsedSteps.length) {
            return;
        }

        const nextSteps = [...reviewParsedSteps];
        const [movedStep] = nextSteps.splice(stageIndex, 1);
        nextSteps.splice(targetIndex, 0, movedStep);
        writeStructuredScriptToCustomEditor(reviewTaskConfig, nextSteps);
        setExpandedStructuredStages({ [targetIndex]: true });
    };

    const buildPolymasCredentials = (): PolymasCredentials => ({
        authorization: authorization.trim(),
        cookie: cookie.trim(),
        userNid: userNid.trim() || undefined,
    });

    const buildCredentialKey = () => `${authorization.trim()}::${cookie.trim()}::${userNid.trim()}`;

    const runCloudapiProbe = async (options?: {
        force?: boolean;
        autoSwitchOnFailure?: boolean;
        silent?: boolean;
    }): Promise<{ available: boolean; message: string; autoSwitched: boolean }> => {
        const auth = authorization.trim();
        const cookieValue = cookie.trim();
        if (!auth || !cookieValue) {
            const message = "请先填写 Authorization 和 Cookie";
            if (!options?.silent) setError(message);
            return { available: false, message, autoSwitched: false };
        }

        const credentialKey = buildCredentialKey();
        if (!options?.force && credentialKey === cloudapiProbeCredentialKey) {
            if (cloudapiProbeStatus === "success") {
                return {
                    available: true,
                    message: cloudapiProbeMessage || "cloudapi 生图测试通过",
                    autoSwitched: false,
                };
            }
            if (cloudapiProbeStatus === "failed") {
                let message = cloudapiProbeMessage || "cloudapi 生图测试失败";
                let autoSwitched = false;
                if (options?.autoSwitchOnFailure && imageProviderMode === "cloudapi") {
                    setImageProviderMode("openai");
                    autoSwitched = true;
                    message = `${message}；已自动切换为 OpenAI 兼容接口（优先）`;
                    setCloudapiProbeMessage(message);
                }
                return {
                    available: false,
                    message,
                    autoSwitched,
                };
            }
        }

        setCloudapiProbeStatus("testing");
        setCloudapiProbeMessage("正在测试 cloudapi 生图接口...");
        if (!options?.silent) setError("");

        try {
            const response = await fetch("/api/training-inject/test-image-provider", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    credentials: {
                        authorization: auth,
                        cookie: cookieValue,
                        userNid: userNid.trim() || undefined,
                    },
                }),
            });

            const rawText = await response.text();
            let data: any = {};
            try {
                data = rawText ? JSON.parse(rawText) : {};
            } catch {
                data = { success: false, error: rawText || "cloudapi 生图测试失败" };
            }

            const success = !!data.success;
            setCloudapiProbeCredentialKey(credentialKey);

            if (success) {
                const message = data.message || "cloudapi 生图测试通过";
                setCloudapiProbeStatus("success");
                setCloudapiProbeMessage(message);
                return { available: true, message, autoSwitched: false };
            }

            let message = data.error || `cloudapi 生图测试失败: ${response.status}`;
            let autoSwitched = false;
            if (options?.autoSwitchOnFailure && imageProviderMode === "cloudapi") {
                setImageProviderMode("openai");
                autoSwitched = true;
                message = `${message}；已自动切换为 OpenAI 兼容接口（优先）`;
            }
            setCloudapiProbeStatus("failed");
            setCloudapiProbeMessage(message);
            return { available: false, message, autoSwitched };
        } catch (error) {
            let message = error instanceof Error ? error.message : "cloudapi 生图测试失败";
            let autoSwitched = false;
            if (options?.autoSwitchOnFailure && imageProviderMode === "cloudapi") {
                setImageProviderMode("openai");
                autoSwitched = true;
                message = `${message}；已自动切换为 OpenAI 兼容接口（优先）`;
            }
            setCloudapiProbeCredentialKey(credentialKey);
            setCloudapiProbeStatus("failed");
            setCloudapiProbeMessage(message);
            return { available: false, message, autoSwitched };
        }
    };

    const prepareImageExecutionPlan = async (needsImageWork: boolean) => {
        if (!needsImageWork || imageProviderMode !== "cloudapi") {
            return {
                effectiveProviderMode: imageProviderMode,
                effectiveImageProviderPriority: imageProviderPriority,
                effectiveSwitchedImageProviderPriority: switchedImageProviderPriority,
                precheckMessage: "",
            };
        }

        const probe = await runCloudapiProbe({ autoSwitchOnFailure: true, silent: true });
        if (!probe.available) {
            return {
                effectiveProviderMode: "openai" as const,
                effectiveImageProviderPriority: "openai",
                effectiveSwitchedImageProviderPriority: "openai",
                precheckMessage: probe.message,
            };
        }

        return {
            effectiveProviderMode: imageProviderMode,
            effectiveImageProviderPriority: imageProviderPriority,
            effectiveSwitchedImageProviderPriority: switchedImageProviderPriority,
            precheckMessage: probe.message,
        };
    };

    const resolveTaskIds = () => {
        let finalTaskId = taskId.trim();
        let finalCourseId = courseId.trim();
        let finalLibraryFolderId = libraryFolderId.trim();

        if (finalTaskId.includes("http") || finalTaskId.includes("?")) {
            const parsed = parsePolymasUrl(finalTaskId);
            if (parsed) {
                finalTaskId = parsed.trainTaskId;
                finalCourseId = finalCourseId || parsed.courseId;
                finalLibraryFolderId = finalLibraryFolderId || parsed.libraryFolderId;
                setTaskId(parsed.trainTaskId);
                setCourseId(parsed.courseId);
                setLibraryFolderId(parsed.libraryFolderId || "");
            }
        }

        const storedContext = finalTaskId ? getStoredTaskContext(finalTaskId) : null;
        if (storedContext) {
            if (!finalCourseId) finalCourseId = storedContext.courseId || "";
            if (!finalLibraryFolderId) finalLibraryFolderId = storedContext.libraryFolderId || "";

            if (!courseId.trim() && storedContext.courseId) {
                setCourseId(storedContext.courseId);
            }
            if (!libraryFolderId.trim() && storedContext.libraryFolderId) {
                setLibraryFolderId(storedContext.libraryFolderId);
            }
        }

        if (finalTaskId && (finalCourseId || finalLibraryFolderId)) {
            persistTaskContext(finalTaskId, finalCourseId, finalLibraryFolderId);
        }

        return { finalTaskId, finalCourseId, finalLibraryFolderId };
    };

    const fetchStageOptions = async (finalTaskId: string): Promise<StageOption[]> => {
        const response = await fetch("/api/training-inject/stages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                trainTaskId: finalTaskId,
                credentials: buildPolymasCredentials(),
            }),
        });

        const rawText = await response.text();
        let data: any = {};
        try {
            data = rawText ? JSON.parse(rawText) : {};
        } catch {
            data = { success: false, error: rawText || "加载阶段列表失败" };
        }

        if (!response.ok || !data.success) {
            throw new Error(data.error || "加载阶段列表失败");
        }
        return Array.isArray(data.stages) ? data.stages : [];
    };

    const loadStages = async () => {
        setError("");
        if (!handleSaveCredentials()) return;
        const { finalTaskId } = resolveTaskIds();
        if (!finalTaskId) {
            setError("请先填写目标训练任务 ID 或完整链接");
            return;
        }

        setLoadingStages(true);
        setRegenMessage("正在加载阶段列表...");
        try {
            const loadedStages = await fetchStageOptions(finalTaskId);
            setRegenStages(loadedStages);
            if (loadedStages.length > 0) {
                setRegenStepId((prev) => prev || loadedStages[0].stepId);
                setRegenMessage(`阶段列表已加载：${loadedStages.length} 个阶段`);
            } else {
                setRegenStepId("");
                setRegenMessage("未查询到可用阶段，请确认任务中已存在 SCRIPT_NODE 节点");
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : "加载阶段列表失败");
            setRegenMessage("");
        } finally {
            setLoadingStages(false);
        }
    };

    const handleRegenerateImage = async () => {
        setError("");
        if (!handleSaveCredentials()) return;

        const { finalTaskId, finalCourseId, finalLibraryFolderId } = resolveTaskIds();
        if (!finalTaskId) {
            setError("请先填写目标训练任务 ID 或完整链接");
            return;
        }
        if (regenTarget === "cover" && !finalCourseId) {
            setError("重新生成课程封面图需要 courseId，请粘贴完整任务链接后重试");
            return;
        }
        if (regenTarget === "background" && !regenStepId) {
            setError("请选择要重生背景图的阶段");
            return;
        }
        if (regenTarget === "background" && (!finalCourseId || !finalLibraryFolderId)) {
            setError("重新生成阶段背景图需要 courseId 与 libraryFolderId，请粘贴完整任务链接后重试");
            return;
        }

        const imageExecutionPlan = await prepareImageExecutionPlan(true);
        const effectiveProviderMode = imageExecutionPlan.effectiveProviderMode;
        const effectiveImageProviderPriority = imageExecutionPlan.effectiveImageProviderPriority;
        const effectiveSwitchedImageProviderPriority = imageExecutionPlan.effectiveSwitchedImageProviderPriority;

        const storedLlmSettings = loadLLMSettingsFromStorage("trainingInject");
        const llmSettings = storedLlmSettings.apiKey || storedLlmSettings.apiUrl || llmModel
            ? {
                apiKey: storedLlmSettings.apiKey,
                apiUrl: storedLlmSettings.apiUrl,
                model: llmModel || storedLlmSettings.model,
            }
            : undefined;

        let trainTaskName = "训练任务";
        let trainDescription = "";
        let selectedStageDescription = "";
        const parsedConfig = effectiveScriptMd ? parseTaskConfig(effectiveScriptMd) : null;
        if (parsedConfig?.trainTaskName) trainTaskName = parsedConfig.trainTaskName;
        if (parsedConfig?.description) trainDescription = parsedConfig.description;

        if (regenTarget === "background" && effectiveScriptMd) {
            const parsedSteps = parseTrainingScript(effectiveScriptMd);
            const selectedStage = regenStages.find((s) => s.stepId === regenStepId);
            const matched = parsedSteps.find((s) => s.stepName === selectedStage?.stepName);
            selectedStageDescription = matched?.description || "";
        }

        setRegeneratingImage(true);
        setRegenMessage(
            imageExecutionPlan.precheckMessage && effectiveProviderMode !== imageProviderMode
                ? imageExecutionPlan.precheckMessage
                : regenTarget === "cover"
                ? "正在重新生成课程封面图..."
                : regenTarget === "background"
                    ? "正在重新生成阶段背景图..."
                    : "正在重新生成全部图片（封面+所有阶段背景）..."
        );
        try {
            const callRegenerateApi = async (payload: Record<string, unknown>) => {
                const response = await fetch("/api/training-inject/regenerate-image", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });

                const rawText = await response.text();
                let data: any = {};
                try {
                    data = rawText ? JSON.parse(rawText) : {};
                } catch {
                    data = { success: false, error: rawText || "重生图片失败" };
                }

                if (!response.ok || !data.success) {
                    throw new Error(data.error || `请求失败: ${response.status} ${response.statusText}`);
                }
                return data;
            };

            const basePayload = {
                trainTaskId: finalTaskId,
                courseId: finalCourseId,
                libraryFolderId: finalLibraryFolderId,
                credentials: buildPolymasCredentials(),
                llmSettings,
                coverStylePrompt: coverStylePrompt.trim() || undefined,
                backgroundStylePrompt: backgroundStylePrompt.trim() || undefined,
                imageModel: effectiveProviderMode === "openai" ? imageModel : undefined,
                imageProviderPriority: effectiveImageProviderPriority,
                trainTaskName,
                trainDescription,
            };

            const runCoverRegenerateWithRetry = async (): Promise<boolean> => {
                try {
                    await callRegenerateApi({
                        ...basePayload,
                        targetType: "cover",
                        imageProviderPriority: effectiveImageProviderPriority,
                    });
                    return true;
                } catch (firstErr) {
                    if (effectiveSwitchedImageProviderPriority === effectiveImageProviderPriority) {
                        console.warn("[InjectModal] 重生封面失败，当前执行计划已禁用 cloudapi 回退:", firstErr);
                        return false;
                    }
                    console.warn("[InjectModal] 重生封面首次失败，切换提供方重试:", firstErr);
                    setRegenMessage("封面图首次生成失败，正在切换生图方式重试（1/1）...");
                    await new Promise((resolve) => setTimeout(resolve, 1200));
                    try {
                        await callRegenerateApi({
                            ...basePayload,
                            targetType: "cover",
                            imageProviderPriority: effectiveSwitchedImageProviderPriority,
                        });
                        return true;
                    } catch (secondErr) {
                        console.warn("[InjectModal] 重生封面重试失败:", secondErr);
                        return false;
                    }
                }
            };

            if (regenTarget === "all") {
                if (!finalCourseId || !finalLibraryFolderId) {
                    throw new Error("重生全部图片需要 courseId 与 libraryFolderId（请粘贴完整任务链接）");
                }

                let stageList = regenStages;
                if (stageList.length === 0) {
                    const stageResponse = await fetch("/api/training-inject/stages", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            trainTaskId: finalTaskId,
                            credentials: buildPolymasCredentials(),
                        }),
                    });
                    const stageText = await stageResponse.text();
                    let stageData: any = {};
                    try {
                        stageData = stageText ? JSON.parse(stageText) : {};
                    } catch {
                        stageData = { success: false, error: stageText || "加载阶段列表失败" };
                    }
                    if (!stageResponse.ok || !stageData.success) {
                        throw new Error(stageData.error || "加载阶段列表失败");
                    }
                    stageList = Array.isArray(stageData.stages) ? stageData.stages : [];
                    setRegenStages(stageList);
                    if (stageList.length > 0) {
                        setRegenStepId((prev) => prev || stageList[0].stepId);
                    }
                }

                const parsedSteps = effectiveScriptMd ? parseTrainingScript(effectiveScriptMd) : [];
                const total = stageList.length + 1;
                let current = 0;
                let coverOk = false;
                let successStages = 0;
                const failedStages: string[] = [];

                let coverPromise: Promise<boolean> | null = null;
                setRegenMessage(`正在并行重生图片：封面 + 阶段背景（共 ${total} 项）...`);
                coverPromise = runCoverRegenerateWithRetry();

                if (stageList.length > 0) {
                    const concurrency = Math.min(BACKGROUND_IMAGE_CONCURRENCY, stageList.length);
                    let nextIndex = 0;
                    let completedStages = 0;

                    setRegenMessage(`正在并发重生阶段背景（并发 ${concurrency}）...`);

                    const runWorker = async () => {
                        while (true) {
                            const index = nextIndex;
                            if (index >= stageList.length) return;
                            nextIndex += 1;

                            const stage = stageList[index];
                            const matched = parsedSteps.find((step) => step.stepName === stage.stepName);
                            const stageDesc = matched?.description || "";

                            try {
                                await callRegenerateApi({
                                    ...basePayload,
                                    targetType: "background",
                                    stepId: stage.stepId,
                                    stepSnapshot: stage.stepSnapshot,
                                    stageDescription: stageDesc || undefined,
                                });
                                successStages += 1;
                            } catch (err) {
                                failedStages.push(stage.stepName || stage.stepId);
                                console.warn("[InjectModal] 重生阶段背景失败，将继续下一个阶段:", stage.stepName, err);
                            }

                            completedStages += 1;
                            current = completedStages;
                            setRegenMessage(`阶段背景重生进度：${completedStages}/${stageList.length}（已完成：${stage.stepName}）`);
                        }
                    };

                    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
                }

                coverOk = coverPromise ? await coverPromise : false;
                if (!coverOk) {
                    failedStages.push("课程封面");
                }
                current += 1;

                setRegenMessage(
                    `重生完成：封面${coverOk ? "成功" : "失败"}，阶段背景 ${successStages}/${stageList.length} 成功`
                );
                if (failedStages.length > 0) {
                    setError(`部分图片重生失败：${failedStages.join("、")}`);
                }
                return;
            }

            if (regenTarget === "cover") {
                const coverOk = await runCoverRegenerateWithRetry();
                if (!coverOk) {
                    throw new Error("课程封面图重生失败（已切换提供方重试 1 次）");
                }
                setRegenMessage("课程封面图重生成功");
                return;
            }

            const data = await callRegenerateApi({
                ...basePayload,
                targetType: regenTarget,
                stepId: regenTarget === "background" ? regenStepId : undefined,
                stepSnapshot: regenTarget === "background"
                    ? regenStages.find((stage) => stage.stepId === regenStepId)?.stepSnapshot
                    : undefined,
                stageDescription: selectedStageDescription || undefined,
            });
            setRegenMessage(data.message || "重生图片成功");

            if (regenTarget === "background") {
                await loadStages();
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : "重生图片失败");
            setRegenMessage("");
        } finally {
            setRegeneratingImage(false);
        }
    };

    const handleInject = async () => {
        if (!handleSaveCredentials()) return;
        const { finalTaskId, finalCourseId, finalLibraryFolderId } = resolveTaskIds();

        if (!finalTaskId) {
            setError("请填写目标训练任务 ID (TASK_ID) 或粘贴完整链接");
            return;
        }
        if (!injectScript && !injectRubric) {
            setError("请至少选择一项注入内容");
            return;
        }

        // 自定义文档验证
        if (hasCustomDoc) {
            if (customDocMode === "combined" && !customCombinedText.trim()) {
                setError("请上传或粘贴合并文档内容");
                return;
            }
            if (customDocMode === "separate") {
                if (injectScript && !effectiveScriptMd?.trim()) {
                    setError("已选注入剧本，但未提供训练剧本配置文档");
                    return;
                }
                if (injectRubric && !effectiveRubricMd?.trim()) {
                    setError("已选注入评分标准，但未提供评分标准文档");
                    return;
                }
            }
        }

        setInjecting(true);
        setError("");
        setSummary(null);
        setProgressLogs([]);

        const shouldGenerateCoverForThisRun = injectCoverImage && injectMode !== "append";
        const shouldGenerateBackgroundForThisRun = injectBackgroundImage;
        const needsImageWork = injectScript && (shouldGenerateCoverForThisRun || shouldGenerateBackgroundForThisRun);
        const imageExecutionPlan = await prepareImageExecutionPlan(needsImageWork);
        const effectiveProviderMode = imageExecutionPlan.effectiveProviderMode;
        const effectiveImageProviderPriority = imageExecutionPlan.effectiveImageProviderPriority;
        const effectiveSwitchedImageProviderPriority = imageExecutionPlan.effectiveSwitchedImageProviderPriority;
        const shouldRunPostImageBatch = needsImageWork;
        const shouldInjectCoverInMain = shouldGenerateCoverForThisRun && !shouldRunPostImageBatch;
        const shouldInjectBgInMain = shouldGenerateBackgroundForThisRun && !shouldRunPostImageBatch;

        // 获取 LLM 配置用于智能提取，使用用户在注入弹窗中选择的模型覆盖
        const storedLlmSettings = loadLLMSettingsFromStorage("trainingInject");
        const llmSettings = storedLlmSettings.apiKey || storedLlmSettings.apiUrl || llmModel
            ? {
                apiKey: storedLlmSettings.apiKey,
                apiUrl: storedLlmSettings.apiUrl,
                model: llmModel || storedLlmSettings.model,
            }
            : undefined;
        if (llmSettings) {
            console.log("[InjectModal] LLM settings loaded:", {
                hasApiKey: !!llmSettings.apiKey,
                apiUrl: llmSettings.apiUrl,
                model: llmSettings.model,
            });
        } else {
            console.warn(`[InjectModal] No LLM settings found in localStorage (key: ${LLM_SETTINGS_STORAGE_KEY})`);
        }

        let appendPreExistingStageNames = new Set<string>();

        try {
            if (injectMode === "append" && injectScript && shouldGenerateBackgroundForThisRun) {
                const existingStagesBeforeInject = await fetchStageOptions(finalTaskId);
                appendPreExistingStageNames = new Set(
                    existingStagesBeforeInject
                        .map((stage) => normalizeStageNameForAppend(stage.stepName))
                        .filter(Boolean)
                );
                setProgressLogs((prev) => [
                    ...prev,
                    {
                        type: "progress",
                        phase: "script",
                        message: `追加模式已记录 ${appendPreExistingStageNames.size} 个已有阶段，后续只为新增阶段补背景图。`,
                        current: 0,
                        total: 1,
                    },
                ]);
            }

            if (shouldRunPostImageBatch) {
                setProgressLogs((prev) => [
                    ...prev,
                    ...(imageExecutionPlan.precheckMessage && effectiveProviderMode !== imageProviderMode
                        ? [{
                            type: "progress" as const,
                            phase: "script" as const,
                            message: imageExecutionPlan.precheckMessage,
                            current: 0,
                            total: 1,
                        }]
                        : []),
                    {
                        type: "progress",
                        phase: "script",
                        message: "检测到已开启生图：将采用“先注入文本，再分步补图”模式，避免云端超时。",
                        current: 0,
                        total: 1,
                    },
                    ...(injectMode === "append" && injectCoverImage
                        ? [{
                            type: "progress" as const,
                            phase: "script" as const,
                            message: "追加模式不会重生课程封面图，只处理新增阶段背景图。",
                            current: 0,
                            total: 1,
                        }]
                        : []),
                ]);
            }

            const response = await fetch("/api/training-inject", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    trainTaskId: finalTaskId,
                    courseId: finalCourseId,
                    libraryFolderId: finalLibraryFolderId,
                    credentials: buildPolymasCredentials(),
                    llmSettings,
                    extractionMode,
                    coverStylePrompt: coverStylePrompt.trim() || undefined,
                    backgroundStylePrompt: backgroundStylePrompt.trim() || undefined,
                    imageModel: effectiveProviderMode === "openai" ? imageModel : undefined,
                    imageProviderPriority: effectiveImageProviderPriority,
                    injectCoverImage: shouldInjectCoverInMain,
                    injectBackgroundImage: shouldInjectBgInMain,
                    scriptMarkdown: injectScript ? effectiveScriptMd : undefined,
                    rubricMarkdown: injectRubric ? effectiveRubricMd : undefined,
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
            let completedSummary: InjectSummary | null = null;
            let delayedCompleteLog: InjectProgressEvent | null = null;

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
                        if (data.type === "error") {
                            throw new Error(data.message);
                        }

                        if (data.type === "complete") {
                            completedSummary = data.summary;
                            if (shouldRunPostImageBatch) {
                                delayedCompleteLog = data;
                                continue;
                            }
                        }

                        setProgressLogs((prev) => [...prev, data]);
                    } catch (eventErr) {
                        if (eventErr instanceof Error && eventErr.message) {
                            throw eventErr;
                        }
                        // 解析异常忽略
                    }
                }
            }

            if (!completedSummary) {
                throw new Error("注入进度流异常结束，未收到完成事件，请重试");
            }

            if (shouldRunPostImageBatch) {
                if (!finalCourseId || !finalLibraryFolderId) {
                    throw new Error("你开启了图片注入，但未解析到 courseId/libraryFolderId。请粘贴包含完整参数的任务链接后重试。");
                }

                const callRegenerateApi = async (payload: Record<string, unknown>) => {
                    const regenResponse = await fetch("/api/training-inject/regenerate-image", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload),
                    });
                    const regenText = await regenResponse.text();
                    let regenData: any = {};
                    try {
                        regenData = regenText ? JSON.parse(regenText) : {};
                    } catch {
                        regenData = { success: false, error: regenText || "图片补全失败" };
                    }
                    if (!regenResponse.ok || !regenData.success) {
                        throw new Error(regenData.error || `图片补全请求失败: ${regenResponse.status} ${regenResponse.statusText}`);
                    }
                    return regenData;
                };

                const pushImageLog = (message: string, current: number, total: number) => {
                    setProgressLogs((prev) => [
                        ...prev,
                        {
                            type: "progress",
                            phase: "script",
                            message,
                            current,
                            total,
                        },
                    ]);
                };

                const parsedSteps = effectiveScriptMd ? parseTrainingScript(effectiveScriptMd) : [];
                const parsedStepNames = new Set(
                    parsedSteps
                        .map((step) => normalizeStageNameForAppend(step.stepName))
                        .filter(Boolean)
                );
                let stageList: StageOption[] = [];
                if (shouldGenerateBackgroundForThisRun) {
                    stageList = await fetchStageOptions(finalTaskId);
                    if (injectMode === "append") {
                        stageList = stageList.filter((stage) => {
                            const normalizedName = normalizeStageNameForAppend(stage.stepName);
                            return normalizedName
                                && parsedStepNames.has(normalizedName)
                                && !appendPreExistingStageNames.has(normalizedName);
                        });
                        pushImageLog(
                            `追加模式仅补全新增阶段背景图：${stageList.length} 个`,
                            0,
                            Math.max(stageList.length, 1)
                        );
                    }
                }

                const totalImageTasks = (shouldGenerateCoverForThisRun ? 1 : 0) + (shouldGenerateBackgroundForThisRun ? stageList.length : 0);
                let currentImageTask = 0;
                const failedItems: string[] = [];

                const baseRegenPayload = {
                    trainTaskId: finalTaskId,
                    courseId: finalCourseId,
                    libraryFolderId: finalLibraryFolderId,
                    credentials: buildPolymasCredentials(),
                    llmSettings,
                    coverStylePrompt: coverStylePrompt.trim() || undefined,
                    backgroundStylePrompt: backgroundStylePrompt.trim() || undefined,
                    imageModel: effectiveProviderMode === "openai" ? imageModel : undefined,
                    imageProviderPriority: effectiveImageProviderPriority,
                    trainTaskName: parseTaskConfig(effectiveScriptMd || "")?.trainTaskName || "训练任务",
                    trainDescription: parseTaskConfig(effectiveScriptMd || "")?.description || "",
                };

                const runCoverRegenerateWithRetryForInject = async (): Promise<boolean> => {
                    try {
                        await callRegenerateApi({
                            ...baseRegenPayload,
                            targetType: "cover",
                            imageProviderPriority: effectiveImageProviderPriority,
                        });
                        return true;
                    } catch (firstErr) {
                        if (effectiveSwitchedImageProviderPriority === effectiveImageProviderPriority) {
                            console.warn("[InjectModal] 注入后补全封面失败，当前执行计划已禁用 cloudapi 回退:", firstErr);
                            return false;
                        }
                        console.warn("[InjectModal] 注入后补全封面首次失败，切换提供方重试:", firstErr);
                        pushImageLog("封面图首次补全失败，正在切换生图方式重试（1/1）...", currentImageTask, totalImageTasks);
                        await new Promise((resolve) => setTimeout(resolve, 1200));
                        try {
                            await callRegenerateApi({
                                ...baseRegenPayload,
                                targetType: "cover",
                                imageProviderPriority: effectiveSwitchedImageProviderPriority,
                            });
                            return true;
                        } catch (secondErr) {
                            console.warn("[InjectModal] 注入后补全封面重试失败:", secondErr);
                            return false;
                        }
                    }
                };

                let coverPromise: Promise<boolean> | null = null;
                if (shouldGenerateCoverForThisRun) {
                    pushImageLog(`正在并行补全课程封面图（与阶段背景并行）...`, currentImageTask, totalImageTasks);
                    coverPromise = runCoverRegenerateWithRetryForInject();
                }

                if (shouldGenerateBackgroundForThisRun) {
                    const concurrency = Math.min(BACKGROUND_IMAGE_CONCURRENCY, stageList.length);
                    if (stageList.length > 0) {
                        pushImageLog(`正在并发补全阶段背景（并发 ${concurrency}，共 ${stageList.length} 个）...`, currentImageTask, totalImageTasks);
                    }

                    let nextIndex = 0;
                    const runWorker = async () => {
                        while (true) {
                            const index = nextIndex;
                            if (index >= stageList.length) return;
                            nextIndex += 1;

                            const stage = stageList[index];
                            const stageNameKey = normalizeStageNameForAppend(stage.stepName);
                            const matched = parsedSteps.find((step) => normalizeStageNameForAppend(step.stepName) === stageNameKey);
                            let stageOk = true;
                            try {
                                await callRegenerateApi({
                                    ...baseRegenPayload,
                                    targetType: "background",
                                    stepId: stage.stepId,
                                    stepSnapshot: stage.stepSnapshot,
                                    stageDescription: matched?.description || undefined,
                                });
                            } catch (stageErr) {
                                stageOk = false;
                                failedItems.push(stage.stepName || stage.stepId);
                                console.warn("[InjectModal] 注入后补全阶段背景失败:", stage.stepName, stageErr);
                            }

                            currentImageTask += 1;
                            pushImageLog(
                                `${stageOk ? "已补全" : "补全失败"}阶段背景：${stage.stepName}（${currentImageTask}/${totalImageTasks}）`,
                                currentImageTask,
                                totalImageTasks
                            );
                        }
                    };

                    if (stageList.length > 0) {
                        await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
                    }
                }

                if (shouldGenerateCoverForThisRun) {
                    const coverOk = coverPromise ? await coverPromise : false;
                    currentImageTask += 1;
                    if (!coverOk) {
                        failedItems.push("课程封面");
                    }
                    pushImageLog(
                        `${coverOk ? "已补全" : "补全失败"}课程封面图（${currentImageTask}/${totalImageTasks}）`,
                        currentImageTask,
                        totalImageTasks
                    );
                }

                if (failedItems.length > 0) {
                    setProgressLogs((prev) => [
                        ...prev,
                        {
                            type: "progress",
                            phase: "script",
                            message: `图片补全完成，但有部分失败：${failedItems.join("、")}`,
                            current: totalImageTasks,
                            total: totalImageTasks,
                        },
                    ]);
                } else if (totalImageTasks > 0) {
                    setProgressLogs((prev) => [
                        ...prev,
                        {
                            type: "progress",
                            phase: "script",
                            message: "图片补全完成",
                            current: totalImageTasks,
                            total: totalImageTasks,
                        },
                    ]);
                }
            }

            if (shouldRunPostImageBatch && delayedCompleteLog) {
                setProgressLogs((prev) => [...prev, delayedCompleteLog as InjectProgressEvent]);
            }

            setSummary(completedSummary);
            setInjecting(false);
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
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                                    <div>
                                        <label className="text-xs font-medium text-slate-600 block mb-1.5">userNid（兜底，可不填）</label>
                                        <input
                                            type="text"
                                            value={userNid}
                                            onChange={(e) => setUserNid(e.target.value)}
                                            placeholder="通常自动读取，失败时再填"
                                            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 font-mono"
                                        />
                                    </div>
                                </div>
                                <p className="text-xs text-slate-400 flex items-center gap-1.5 mt-2">
                                    <Key className="w-3.5 h-3.5" />
                                    凭证仅保存在本地浏览器中；系统会优先调用 getLoginUserInfo 自动识别当前账号 userId，手填 userNid 只作为接口失败时的兜底
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
                                            const trimmed = val.trim();
                                            setTaskId(val);

                                            if (!trimmed) {
                                                setCourseId("");
                                                setLibraryFolderId("");
                                                setTaskContextHint("");
                                                return;
                                            }

                                            // 边输入边解析完整链接，并把解析出的上下文按 trainTaskId 缓存
                                            if (trimmed.includes("http") || trimmed.includes("?")) {
                                                const parsed = parsePolymasUrl(trimmed);
                                                if (parsed) {
                                                    const storedContext = getStoredTaskContext(parsed.trainTaskId);
                                                    const resolvedCourseId = parsed.courseId || storedContext?.courseId || "";
                                                    const resolvedLibraryFolderId = parsed.libraryFolderId || storedContext?.libraryFolderId || "";
                                                    setTaskId(parsed.trainTaskId);
                                                    setCourseId(resolvedCourseId);
                                                    setLibraryFolderId(resolvedLibraryFolderId);
                                                    if (!parsed.libraryFolderId && storedContext?.libraryFolderId) {
                                                        setTaskContextHint("已从本地缓存恢复该实训的 libraryFolderId");
                                                    } else {
                                                        setTaskContextHint("");
                                                    }
                                                    persistTaskContext(parsed.trainTaskId, resolvedCourseId, resolvedLibraryFolderId);
                                                    return;
                                                }
                                            }

                                            const storedContext = getStoredTaskContext(trimmed);
                                            if (storedContext) {
                                                setCourseId(storedContext.courseId || "");
                                                setLibraryFolderId(storedContext.libraryFolderId || "");
                                                setTaskContextHint("已从本地缓存恢复该实训的 libraryFolderId");
                                            } else {
                                                // 切换到一个没有缓存的新任务时，清掉上一个任务残留的上下文
                                                setCourseId("");
                                                setLibraryFolderId("");
                                                setTaskContextHint("");
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
                                    {taskContextHint && (
                                        <p className="text-xs text-amber-600 mt-1.5 ml-1">
                                            {taskContextHint}
                                        </p>
                                    )}
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2 border-t border-slate-100">
                                    {/* 左侧：注入内容 */}
                                    <div className="space-y-3">
                                        <label className="text-xs font-medium text-slate-700 block">注入内容</label>
                                        <label className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors ${!effectiveScriptMd ? 'opacity-50 cursor-not-allowed bg-slate-50' : 'hover:bg-slate-50'}`}>
                                            <input
                                                type="checkbox"
                                                checked={injectScript}
                                                onChange={(e) => setInjectScript(e.target.checked)}
                                                disabled={!effectiveScriptMd}
                                                className="rounded text-indigo-600 focus:ring-indigo-500"
                                            />
                                            <span className="text-sm font-medium text-slate-700">训练剧本配置节点</span>
                                            {!effectiveScriptMd && <span className="text-xs text-slate-400 ml-auto">未生成</span>}
                                        </label>
                                        <label className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors ${!effectiveRubricMd ? 'opacity-50 cursor-not-allowed bg-slate-50' : 'hover:bg-slate-50'}`}>
                                            <input
                                                type="checkbox"
                                                checked={injectRubric}
                                                onChange={(e) => setInjectRubric(e.target.checked)}
                                                disabled={!effectiveRubricMd}
                                                className="rounded text-indigo-600 focus:ring-indigo-500"
                                            />
                                            <span className="text-sm font-medium text-slate-700">任务评分标准</span>
                                            {!effectiveRubricMd && <span className="text-xs text-slate-400 ml-auto">未生成</span>}
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

                                <div className="pt-3 border-t border-slate-100 space-y-2">
                                    <label className="text-xs font-medium text-slate-700 block">课程封面图风格（可选）</label>
                                    <input
                                        type="text"
                                        value={coverStylePrompt}
                                        onChange={(e) => setCoverStylePrompt(e.target.value)}
                                        placeholder="例如：蓝白医疗风、极简科技感、无人物、留标题区"
                                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                                    />
                                    <p className="text-xs text-slate-400">仅影响课程封面图，不影响阶段背景图。</p>
                                </div>

                                <div className="pt-3 border-t border-slate-100 space-y-2">
                                    <label className="text-xs font-medium text-slate-700 block">阶段背景图风格（可选）</label>
                                    <input
                                        type="text"
                                        value={backgroundStylePrompt}
                                        onChange={(e) => setBackgroundStylePrompt(e.target.value)}
                                        placeholder="例如：现代医学实训室、暖色教学空间、少人物、干净写实、禁止海报拼贴"
                                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                                    />
                                    <p className="text-xs text-slate-400">仅影响阶段背景图，不影响课程封面图。</p>
                                </div>

                                <div className="pt-3 border-t border-slate-100 space-y-2">
                                    <div className="flex items-center justify-between gap-3">
                                        <label className="text-xs font-medium text-slate-700 block">生图方式</label>
                                        <button
                                            type="button"
                                            onClick={async () => {
                                                if (!handleSaveCredentials()) return;
                                                const result = await runCloudapiProbe({ force: true, autoSwitchOnFailure: true });
                                                if (!result.available && result.autoSwitched) {
                                                    setError("");
                                                }
                                            }}
                                            disabled={cloudapiProbeStatus === "testing"}
                                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                                        >
                                            {cloudapiProbeStatus === "testing" ? (
                                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                            ) : (
                                                <Play className="w-3.5 h-3.5" />
                                            )}
                                            测试 cloudapi
                                        </button>
                                    </div>
                                    <select
                                        value={imageProviderMode}
                                        onChange={(e) => setImageProviderMode(e.target.value as "cloudapi" | "openai")}
                                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white"
                                    >
                                        {IMAGE_PROVIDER_OPTIONS.map((item) => (
                                            <option key={item.id} value={item.id}>{item.name}</option>
                                        ))}
                                    </select>
                                    <p className="text-xs text-slate-400">可先测试 cloudapi 可用性。若当前账号下 cloudapi 不可用，正式执行前也会自动切到 OpenAI 兼容接口，避免每张图都先失败一遍。</p>
                                    {cloudapiProbeMessage && (
                                        <p className={`text-xs ${cloudapiProbeStatus === "success" ? "text-emerald-600" : cloudapiProbeStatus === "failed" ? "text-amber-600" : "text-slate-500"}`}>
                                            {cloudapiProbeMessage}
                                        </p>
                                    )}
                                </div>

                                {imageProviderMode === "openai" && (
                                    <div className="pt-3 border-t border-slate-100 space-y-2">
                                        <label className="text-xs font-medium text-slate-700 block">图片模型</label>
                                        <select
                                            value={imageModel}
                                            onChange={(e) => setImageModel(e.target.value)}
                                            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white"
                                        >
                                            {imageModelOptions.map((item) => (
                                                <option key={item.id} value={item.id}>{item.name}</option>
                                            ))}
                                        </select>
                                        <p className="text-xs text-slate-400">仅在 OpenAI 兼容接口生图时生效。当前默认推荐 `doubao-seedream-5-0-260128`。</p>
                                    </div>
                                )}

                                <div className="pt-3 border-t border-slate-100 space-y-2">
                                    <label className="text-xs font-medium text-slate-700 block">图片注入开关</label>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                        <label className="flex items-center gap-2 p-2 rounded-lg border hover:bg-slate-50 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={injectCoverImage}
                                                onChange={(e) => setInjectCoverImage(e.target.checked)}
                                                className="rounded text-indigo-600 focus:ring-indigo-500"
                                            />
                                            <span className="text-sm text-slate-700">注入课程封面图</span>
                                        </label>
                                        <label className="flex items-center gap-2 p-2 rounded-lg border hover:bg-slate-50 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={injectBackgroundImage}
                                                onChange={(e) => setInjectBackgroundImage(e.target.checked)}
                                                className="rounded text-indigo-600 focus:ring-indigo-500"
                                            />
                                            <span className="text-sm text-slate-700">注入阶段背景图</span>
                                        </label>
                                    </div>
                                    <p className="text-xs text-slate-400">关闭后会跳过对应生图步骤，可用于先快速验证文字配置。</p>
                                </div>

                                <div className="pt-3 border-t border-slate-100 space-y-3">
                                    <div className="flex items-center gap-2">
                                        <RefreshCw className="w-3.5 h-3.5 text-slate-500" />
                                        <label className="text-xs font-medium text-slate-700">图片重生（可选）</label>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                        <label className={`p-2 border rounded-lg cursor-pointer transition-colors ${regenTarget === 'cover' ? 'border-indigo-500 bg-indigo-50/50' : 'hover:bg-slate-50 border-slate-200'}`}>
                                            <div className="flex items-center gap-2">
                                                <input
                                                    type="radio"
                                                    checked={regenTarget === 'cover'}
                                                    onChange={() => setRegenTarget('cover')}
                                                    className="text-indigo-600 focus:ring-indigo-500"
                                                />
                                                <span className="text-sm font-medium text-slate-800">重新生成课程封面图</span>
                                            </div>
                                        </label>

                                        <label className={`p-2 border rounded-lg cursor-pointer transition-colors ${regenTarget === 'background' ? 'border-indigo-500 bg-indigo-50/50' : 'hover:bg-slate-50 border-slate-200'}`}>
                                            <div className="flex items-center gap-2">
                                                <input
                                                    type="radio"
                                                    checked={regenTarget === 'background'}
                                                    onChange={() => setRegenTarget('background')}
                                                    className="text-indigo-600 focus:ring-indigo-500"
                                                />
                                                <span className="text-sm font-medium text-slate-800">重新生成某阶段背景图</span>
                                            </div>
                                        </label>

                                        <label className={`p-2 border rounded-lg cursor-pointer transition-colors ${regenTarget === 'all' ? 'border-indigo-500 bg-indigo-50/50' : 'hover:bg-slate-50 border-slate-200'}`}>
                                            <div className="flex items-center gap-2">
                                                <input
                                                    type="radio"
                                                    checked={regenTarget === 'all'}
                                                    onChange={() => setRegenTarget('all')}
                                                    className="text-indigo-600 focus:ring-indigo-500"
                                                />
                                                <span className="text-sm font-medium text-slate-800">重生全部图片</span>
                                            </div>
                                        </label>
                                    </div>

                                    {regenTarget === 'background' && (
                                        <div className="space-y-2">
                                            <div className="flex items-center gap-2">
                                                <button
                                                    type="button"
                                                    onClick={loadStages}
                                                    disabled={loadingStages || regeneratingImage || injecting}
                                                    className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg bg-white hover:bg-slate-50 text-slate-600 disabled:opacity-50"
                                                >
                                                    {loadingStages ? "加载中..." : "加载阶段列表"}
                                                </button>
                                                <span className="text-xs text-slate-400">从当前任务读取可选阶段</span>
                                            </div>
                                            <select
                                                value={regenStepId}
                                                onChange={(e) => setRegenStepId(e.target.value)}
                                                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white"
                                            >
                                                {regenStages.length === 0 && <option value="">请先加载阶段列表</option>}
                                                {regenStages.map((stage) => (
                                                    <option key={stage.stepId} value={stage.stepId}>{stage.stepName}</option>
                                                ))}
                                            </select>
                                        </div>
                                    )}

                                    <div className="flex items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={handleRegenerateImage}
                                            disabled={regeneratingImage || injecting || (regenTarget === 'background' && !regenStepId)}
                                            className="px-3 py-2 text-sm bg-slate-800 hover:bg-slate-900 disabled:opacity-50 text-white rounded-lg font-medium flex items-center gap-2"
                                        >
                                            {regeneratingImage ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                                            {regeneratingImage ? "重生中..." : "执行图片重生"}
                                        </button>
                                        {regenMessage && <span className="text-xs text-emerald-600">{regenMessage}</span>}
                                    </div>
                                </div>

                                {/* 提取模式选择 */}
                                <div className="pt-3 border-t border-slate-100 space-y-2">
                                    <label className="text-xs font-medium text-slate-700 block">提取模式</label>
                                    <div className="flex gap-2">
                                        <button
                                            type="button"
                                            onClick={() => setExtractionMode('regex')}
                                            className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${extractionMode === 'regex'
                                                ? 'bg-indigo-50 border-indigo-500 text-indigo-700'
                                                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                                                }`}
                                        >
                                            🚀 纯正则
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setExtractionMode('hybrid')}
                                            className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${extractionMode === 'hybrid'
                                                ? 'bg-indigo-50 border-indigo-500 text-indigo-700'
                                                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                                                }`}
                                        >
                                            ⚡ 智能混合
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
                                        {extractionMode === 'regex'
                                            ? '全部使用正则解析（最快），适用于本系统生成的标准格式文档'
                                            : extractionMode === 'hybrid'
                                                ? '正则解析剧本 + LLM 辅助提取（较快）'
                                                : '所有内容均使用 LLM 提取，适用于非标准格式文档（较慢）'
                                        }
                                    </p>
                                </div>

                                {extractionMode !== 'regex' && (
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
                                            {llmModelOptions.map((m) => (
                                                <option key={m.id} value={m.id}>{m.name} — {m.description}</option>
                                            ))}
                                        </select>
                                        {!llmModel && (
                                            <p className="text-xs text-amber-600">⚠ 未检测到模型配置，请先在全局设置中配置 API Key 和模型，或在此处选择</p>
                                        )}
                                    </div>
                                )}

                                {/* 注入前审阅与修正（可折叠） */}
                                <div className="pt-3 border-t border-slate-100">
                                    <button
                                        type="button"
                                        onClick={() => setCustomDocExpanded(!customDocExpanded)}
                                        className="flex items-center gap-2 w-full text-left group"
                                    >
                                        {customDocExpanded
                                            ? <ChevronDown className="w-4 h-4 text-slate-400 group-hover:text-indigo-500 transition-colors" />
                                            : <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-500 transition-colors" />
                                        }
                                        <Upload className="w-3.5 h-3.5 text-slate-500" />
                                        <span className="text-xs font-medium text-slate-700 group-hover:text-indigo-600 transition-colors">
                                            注入前审阅与修正（可选）
                                        </span>
                                        {hasCustomDoc && (
                                            <span className="ml-auto text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">将使用修正版注入</span>
                                        )}
                                    </button>

                                    {customDocExpanded && (
                                        <div className="mt-3 space-y-4 pl-6">
                                            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 space-y-4">
                                                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                                                    <div className="space-y-1">
                                                        <div className="text-sm font-semibold text-slate-800">当前待注入内容审阅</div>
                                                        <p className="text-xs text-slate-500">
                                                            先看解析摘要和阶段 JSON；如果哪里不对，直接在下面粘贴或修改 Markdown，执行注入时会优先使用这里的修正版。
                                                        </p>
                                                    </div>
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        {(scriptMarkdown || rubricMarkdown) && (
                                                            <button
                                                                type="button"
                                                                onClick={loadCurrentGeneratedDocsIntoEditor}
                                                                className="px-3 py-1.5 text-xs font-medium border border-indigo-200 rounded-lg bg-white text-indigo-600 hover:bg-indigo-50 transition-colors"
                                                            >
                                                                载入当前生成内容到编辑区
                                                            </button>
                                                        )}
                                                        {hasCustomDoc && (
                                                            <button
                                                                type="button"
                                                                onClick={() => {
                                                                    setCustomCombinedText("");
                                                                    setCustomScriptText("");
                                                                    setCustomRubricText("");
                                                                }}
                                                                className="px-3 py-1.5 text-xs font-medium border border-rose-200 rounded-lg bg-white text-rose-600 hover:bg-rose-50 transition-colors"
                                                            >
                                                                清空修正版
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>

                                                <div className="flex flex-wrap gap-2">
                                                    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${hasCustomDoc ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-700"}`}>
                                                        {hasCustomDoc ? "本次将按修正版注入" : "本次将按当前生成结果注入"}
                                                    </span>
                                                    {reviewTaskConfig?.trainTaskName && (
                                                        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-white border border-slate-200 text-slate-700">
                                                            任务：{reviewTaskConfig.trainTaskName}
                                                        </span>
                                                    )}
                                                    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-white border border-slate-200 text-slate-700">
                                                        训练阶段：{reviewParsedSteps.length}
                                                    </span>
                                                    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-white border border-slate-200 text-slate-700">
                                                        评分项：{reviewRubricItems.length}
                                                    </span>
                                                </div>

                                                {reviewScriptDiagnostics?.issues?.length ? (
                                                    <div className="space-y-2">
                                                        <div className="text-xs font-medium text-slate-700">解析提醒</div>
                                                        <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
                                                            {reviewScriptDiagnostics.issues.map((issue, index) => (
                                                                <div
                                                                    key={`${issue.message}-${index}`}
                                                                    className={`rounded-lg border px-3 py-2 text-xs ${issue.level === "error"
                                                                        ? "border-rose-200 bg-rose-50 text-rose-700"
                                                                        : "border-amber-200 bg-amber-50 text-amber-700"
                                                                    }`}
                                                                >
                                                                    {issue.stageIndex !== undefined && !/^阶段\s*\d+/u.test(issue.message)
                                                                        ? `阶段 ${issue.stageIndex + 1}：${issue.message}`
                                                                        : issue.message}
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                ) : effectiveScriptMd ? (
                                                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                                                        当前剧本解析正常，未发现阻塞注入的问题。
                                                    </div>
                                                ) : null}

                                                {reviewParsedSteps.length > 0 ? (
                                                    <div className="space-y-2">
                                                        <div className="text-xs font-medium text-slate-700">阶段解析摘要</div>
                                                        <div className="grid grid-cols-1 gap-2">
                                                            {reviewParsedSteps.map((step, index) => (
                                                                <div key={`${step.stepName || "stage"}-${index}`} className="rounded-lg border border-slate-200 bg-white px-3 py-3 space-y-2">
                                                                    <div className="flex flex-wrap items-center gap-2">
                                                                        <span className="text-sm font-semibold text-slate-800">阶段 {index + 1}</span>
                                                                        <span className="text-sm text-slate-600">{step.stepName || "未识别名称"}</span>
                                                                    </div>
                                                                    <div className="flex flex-wrap gap-2">
                                                                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${step.prologue.trim() ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                                                                            开场白{step.prologue.trim() ? "已识别" : "缺失"}
                                                                        </span>
                                                                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${step.llmPrompt.trim() ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                                                                            提示词{step.llmPrompt.trim() ? "已识别" : "缺失"}
                                                                        </span>
                                                                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${step.transitionPrompt.trim() ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                                                                            衔接语{step.transitionPrompt.trim() ? "已识别" : "缺失"}
                                                                        </span>
                                                                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-700">
                                                                            互动轮次 {step.interactiveRounds || 0}
                                                                        </span>
                                                                    </div>
                                                                    {step.description.trim() && (
                                                                        <p className="text-xs leading-5 text-slate-600 line-clamp-3">{step.description}</p>
                                                                    )}
                                                                </div>
                                                            ))}
                                                        </div>
                                                        <button
                                                            type="button"
                                                            onClick={() => setParsedJsonExpanded((prev) => !prev)}
                                                            className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg bg-white hover:bg-slate-50 text-slate-600 transition-colors"
                                                        >
                                                            {parsedJsonExpanded ? "收起阶段 JSON" : "显示阶段 JSON"}
                                                        </button>
                                                        {parsedJsonExpanded && reviewParsedJson && (
                                                            <pre className="max-h-80 overflow-auto rounded-xl border border-slate-200 bg-slate-950 p-4 text-[11px] leading-5 text-emerald-200 whitespace-pre-wrap break-all">
{reviewParsedJson}
                                                            </pre>
                                                        )}
                                                        <div className="rounded-xl border border-slate-200 bg-white">
                                                            <button
                                                                type="button"
                                                                onClick={() => setStructuredEditorExpanded((prev) => !prev)}
                                                                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                                                            >
                                                                <div>
                                                                    <div className="text-sm font-semibold text-slate-800">逐阶段表单修正</div>
                                                                    <p className="text-xs text-slate-500 mt-1">
                                                                        直接改任务信息、阶段名、开场白、提示词、跳转词等字段，系统会自动回写成修正版 Markdown 并用于注入。
                                                                    </p>
                                                                </div>
                                                                {structuredEditorExpanded ? (
                                                                    <ChevronDown className="w-4 h-4 text-slate-400" />
                                                                ) : (
                                                                    <ChevronRight className="w-4 h-4 text-slate-400" />
                                                                )}
                                                            </button>

                                                            {structuredEditorExpanded && (
                                                                <div className="border-t border-slate-200 px-4 py-4 space-y-4">
                                                                    <div className="grid grid-cols-1 gap-3">
                                                                        <div>
                                                                            <label className="text-xs font-medium text-slate-700 block mb-1.5">任务名称</label>
                                                                            <input
                                                                                type="text"
                                                                                value={reviewTaskConfig?.trainTaskName || ""}
                                                                                onChange={(e) => handleStructuredTaskConfigChange("trainTaskName", e.target.value)}
                                                                                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                                                                            />
                                                                        </div>
                                                                        <div>
                                                                            <label className="text-xs font-medium text-slate-700 block mb-1.5">任务描述</label>
                                                                            <textarea
                                                                                value={reviewTaskConfig?.description || ""}
                                                                                onChange={(e) => handleStructuredTaskConfigChange("description", e.target.value)}
                                                                                rows={3}
                                                                                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 resize-y"
                                                                            />
                                                                        </div>
                                                                    </div>

                                                                    <div className="flex flex-wrap items-center justify-between gap-3">
                                                                        <div className="text-xs font-medium text-slate-700">阶段列表</div>
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => handleAddStructuredStage()}
                                                                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-indigo-200 rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors"
                                                                        >
                                                                            <Plus className="w-3.5 h-3.5" />
                                                                            新增阶段
                                                                        </button>
                                                                    </div>

                                                                    <div className="space-y-3">
                                                                        {reviewParsedSteps.map((step, index) => (
                                                                            <div key={`structured-stage-${index}`} className="rounded-xl border border-slate-200 bg-slate-50/60 overflow-hidden">
                                                                                <button
                                                                                    type="button"
                                                                                    onClick={() => toggleStructuredStage(index)}
                                                                                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                                                                                >
                                                                                    <div>
                                                                                        <div className="text-sm font-semibold text-slate-800">阶段 {index + 1}</div>
                                                                                        <div className="text-xs text-slate-500 mt-1">{step.stepName || "未命名阶段"}</div>
                                                                                    </div>
                                                                                    {expandedStructuredStages[index] ? (
                                                                                        <ChevronDown className="w-4 h-4 text-slate-400" />
                                                                                    ) : (
                                                                                        <ChevronRight className="w-4 h-4 text-slate-400" />
                                                                                    )}
                                                                                </button>

                                                                                {expandedStructuredStages[index] && (
                                                                                    <div className="border-t border-slate-200 bg-white px-4 py-4 space-y-4">
                                                                                        <div className="flex flex-wrap items-center gap-2">
                                                                                            <button
                                                                                                type="button"
                                                                                                onClick={() => handleAddStructuredStage(index)}
                                                                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-indigo-200 rounded-lg bg-white text-indigo-600 hover:bg-indigo-50 transition-colors"
                                                                                            >
                                                                                                <Plus className="w-3.5 h-3.5" />
                                                                                                在后面新增
                                                                                            </button>
                                                                                            <button
                                                                                                type="button"
                                                                                                onClick={() => handleMoveStructuredStage(index, "up")}
                                                                                                disabled={index === 0}
                                                                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                                                                            >
                                                                                                <ArrowUp className="w-3.5 h-3.5" />
                                                                                                上移
                                                                                            </button>
                                                                                            <button
                                                                                                type="button"
                                                                                                onClick={() => handleMoveStructuredStage(index, "down")}
                                                                                                disabled={index === reviewParsedSteps.length - 1}
                                                                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                                                                            >
                                                                                                <ArrowDown className="w-3.5 h-3.5" />
                                                                                                下移
                                                                                            </button>
                                                                                            <button
                                                                                                type="button"
                                                                                                onClick={() => handleDeleteStructuredStage(index)}
                                                                                                disabled={reviewParsedSteps.length <= 1}
                                                                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-rose-200 rounded-lg bg-white text-rose-600 hover:bg-rose-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                                                                            >
                                                                                                <Trash2 className="w-3.5 h-3.5" />
                                                                                                删除阶段
                                                                                            </button>
                                                                                        </div>

                                                                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                                                                            <div>
                                                                                                <label className="text-xs font-medium text-slate-700 block mb-1.5">阶段名称</label>
                                                                                                <input
                                                                                                    type="text"
                                                                                                    value={step.stepName}
                                                                                                    onChange={(e) => handleStructuredStageChange(index, "stepName", e.target.value)}
                                                                                                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                                                                                                />
                                                                                            </div>
                                                                                            <div>
                                                                                                <label className="text-xs font-medium text-slate-700 block mb-1.5">虚拟训练官名字</label>
                                                                                                <input
                                                                                                    type="text"
                                                                                                    value={step.trainerName}
                                                                                                    onChange={(e) => handleStructuredStageChange(index, "trainerName", e.target.value)}
                                                                                                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                                                                                                />
                                                                                            </div>
                                                                                            <div>
                                                                                                <label className="text-xs font-medium text-slate-700 block mb-1.5">互动轮次</label>
                                                                                                <input
                                                                                                    type="number"
                                                                                                    min={0}
                                                                                                    value={step.interactiveRounds || 0}
                                                                                                    onChange={(e) => handleStructuredStageChange(index, "interactiveRounds", e.target.value)}
                                                                                                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                                                                                                />
                                                                                            </div>
                                                                                            <div>
                                                                                                <label className="text-xs font-medium text-slate-700 block mb-1.5">flowCondition</label>
                                                                                                <input
                                                                                                    type="text"
                                                                                                    value={step.flowCondition}
                                                                                                    onChange={(e) => handleStructuredStageChange(index, "flowCondition", e.target.value)}
                                                                                                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                                                                                                />
                                                                                            </div>
                                                                                        </div>

                                                                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                                                                            <div>
                                                                                                <label className="text-xs font-medium text-slate-700 block mb-1.5">模型</label>
                                                                                                <input
                                                                                                    type="text"
                                                                                                    value={step.modelId}
                                                                                                    onChange={(e) => handleStructuredStageChange(index, "modelId", e.target.value)}
                                                                                                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                                                                                                />
                                                                                            </div>
                                                                                            <div>
                                                                                                <label className="text-xs font-medium text-slate-700 block mb-1.5">声音</label>
                                                                                                <input
                                                                                                    type="text"
                                                                                                    value={step.agentId}
                                                                                                    onChange={(e) => handleStructuredStageChange(index, "agentId", e.target.value)}
                                                                                                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                                                                                                />
                                                                                            </div>
                                                                                            <div>
                                                                                                <label className="text-xs font-medium text-slate-700 block mb-1.5">形象</label>
                                                                                                <input
                                                                                                    type="text"
                                                                                                    value={step.avatarNid}
                                                                                                    onChange={(e) => handleStructuredStageChange(index, "avatarNid", e.target.value)}
                                                                                                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                                                                                                />
                                                                                            </div>
                                                                                            <div>
                                                                                                <label className="text-xs font-medium text-slate-700 block mb-1.5">背景图</label>
                                                                                                <input
                                                                                                    type="text"
                                                                                                    value={step.backgroundImage}
                                                                                                    onChange={(e) => handleStructuredStageChange(index, "backgroundImage", e.target.value)}
                                                                                                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                                                                                                />
                                                                                            </div>
                                                                                        </div>

                                                                                        <div>
                                                                                            <label className="text-xs font-medium text-slate-700 block mb-1.5">阶段描述</label>
                                                                                            <textarea
                                                                                                value={step.description}
                                                                                                onChange={(e) => handleStructuredStageChange(index, "description", e.target.value)}
                                                                                                rows={4}
                                                                                                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 resize-y"
                                                                                            />
                                                                                        </div>

                                                                                        <div>
                                                                                            <label className="text-xs font-medium text-slate-700 block mb-1.5">开场白</label>
                                                                                            <textarea
                                                                                                value={step.prologue}
                                                                                                onChange={(e) => handleStructuredStageChange(index, "prologue", e.target.value)}
                                                                                                rows={4}
                                                                                                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 resize-y"
                                                                                            />
                                                                                        </div>

                                                                                        <div>
                                                                                            <label className="text-xs font-medium text-slate-700 block mb-1.5">transitionPrompt</label>
                                                                                            <textarea
                                                                                                value={step.transitionPrompt}
                                                                                                onChange={(e) => handleStructuredStageChange(index, "transitionPrompt", e.target.value)}
                                                                                                rows={6}
                                                                                                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 font-mono resize-y"
                                                                                            />
                                                                                        </div>

                                                                                        <div>
                                                                                            <label className="text-xs font-medium text-slate-700 block mb-1.5">提示词</label>
                                                                                            <textarea
                                                                                                value={step.llmPrompt}
                                                                                                onChange={(e) => handleStructuredStageChange(index, "llmPrompt", e.target.value)}
                                                                                                rows={10}
                                                                                                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 font-mono resize-y"
                                                                                            />
                                                                                        </div>
                                                                                    </div>
                                                                                )}
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                    <p className="text-xs text-slate-500">
                                                                        表单里的修改会自动同步到下方“修正版训练剧本配置文档”，并以修正版参与注入。
                                                                    </p>
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                ) : effectiveScriptMd ? (
                                                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-700 space-y-3">
                                                        <div>当前文本还没有稳定解析出训练阶段。你可以直接把正确的 Markdown 粘贴到下面编辑区，或先创建一个空阶段再继续编辑。</div>
                                                        <button
                                                            type="button"
                                                            onClick={() => handleAddStructuredStage()}
                                                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-amber-300 rounded-lg bg-white text-amber-700 hover:bg-amber-100 transition-colors"
                                                        >
                                                            <Plus className="w-3.5 h-3.5" />
                                                            新建第 1 个阶段
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <div className="rounded-lg border border-slate-200 bg-white px-3 py-3 text-xs text-slate-500 space-y-3">
                                                        <div>当前没有可审阅的剧本内容。你可以先生成内容，或直接创建空阶段从头整理一份可注入剧本。</div>
                                                        <button
                                                            type="button"
                                                            onClick={() => handleAddStructuredStage()}
                                                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg bg-white text-slate-700 hover:bg-slate-50 transition-colors"
                                                        >
                                                            <Plus className="w-3.5 h-3.5" />
                                                            新建第 1 个阶段
                                                        </button>
                                                    </div>
                                                )}
                                            </div>

                                            {/* 文档模式选择 */}
                                            <div className="flex gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() => setCustomDocMode("combined")}
                                                    className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${customDocMode === "combined"
                                                        ? "bg-indigo-50 border-indigo-500 text-indigo-700"
                                                        : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                                                        }`}
                                                >
                                                    📄 合并文档（同一文档）
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setCustomDocMode("separate")}
                                                    className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${customDocMode === "separate"
                                                        ? "bg-indigo-50 border-indigo-500 text-indigo-700"
                                                        : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                                                        }`}
                                                >
                                                    📑 分开文档（各一份）
                                                </button>
                                            </div>

                                            {customDocMode === "combined" ? (
                                                /* 合并模式：一个文档包含训练配置 + 评分标准 */
                                                <div className="space-y-2">
                                                    <label className="text-xs font-medium text-slate-700 block">
                                                        修正版文档（训练配置 + 评分标准）
                                                    </label>
                                                    <div className="flex items-center gap-2">
                                                        <input
                                                            ref={combinedFileRef}
                                                            type="file"
                                                            accept=".md,.markdown,.txt"
                                                            className="hidden"
                                                            onChange={(e) => handleFileUpload(e, setCustomCombinedText)}
                                                        />
                                                        <button
                                                            type="button"
                                                            onClick={() => combinedFileRef.current?.click()}
                                                            className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg bg-white hover:bg-slate-50 text-slate-600 flex items-center gap-1.5 transition-colors"
                                                        >
                                                            <FileText className="w-3.5 h-3.5" />
                                                            上传 .md 文件
                                                        </button>
                                                        {customCombinedText && (
                                                            <span className="text-xs text-emerald-600">✅ 已加载 {customCombinedText.length} 字符</span>
                                                        )}
                                                    </div>
                                                    <textarea
                                                        value={customCombinedText}
                                                        onChange={(e) => setCustomCombinedText(e.target.value)}
                                                        placeholder="把你想真正注入的平台 Markdown 粘贴到这里；保存后将优先按这里的内容注入..."
                                                        rows={10}
                                                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 font-mono resize-y"
                                                    />
                                                </div>
                                            ) : (
                                                /* 分开模式：训练配置和评分标准各一个文档 */
                                                <div className="space-y-4">
                                                    {/* 训练剧本配置文档 */}
                                                    <div className="space-y-2">
                                                        <label className="text-xs font-medium text-slate-700 block">
                                                            修正版训练剧本配置文档
                                                        </label>
                                                        <div className="flex items-center gap-2">
                                                            <input
                                                                ref={scriptFileRef}
                                                                type="file"
                                                                accept=".md,.markdown,.txt"
                                                                className="hidden"
                                                                onChange={(e) => handleFileUpload(e, setCustomScriptText)}
                                                            />
                                                            <button
                                                                type="button"
                                                                onClick={() => scriptFileRef.current?.click()}
                                                                className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg bg-white hover:bg-slate-50 text-slate-600 flex items-center gap-1.5 transition-colors"
                                                            >
                                                                <FileText className="w-3.5 h-3.5" />
                                                                上传 .md 文件
                                                            </button>
                                                            {customScriptText && (
                                                                <span className="text-xs text-emerald-600">✅ 已加载 {customScriptText.length} 字符</span>
                                                            )}
                                                        </div>
                                                        <textarea
                                                            value={customScriptText}
                                                            onChange={(e) => setCustomScriptText(e.target.value)}
                                                            placeholder="把训练剧本配置 Markdown 粘贴到这里；执行注入时会优先使用这份修正版..."
                                                            rows={8}
                                                            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 font-mono resize-y"
                                                        />
                                                    </div>

                                                    {/* 评分标准文档 */}
                                                    <div className="space-y-2">
                                                        <label className="text-xs font-medium text-slate-700 block">
                                                            修正版评分标准文档
                                                        </label>
                                                        <div className="flex items-center gap-2">
                                                            <input
                                                                ref={rubricFileRef}
                                                                type="file"
                                                                accept=".md,.markdown,.txt"
                                                                className="hidden"
                                                                onChange={(e) => handleFileUpload(e, setCustomRubricText)}
                                                            />
                                                            <button
                                                                type="button"
                                                                onClick={() => rubricFileRef.current?.click()}
                                                                className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg bg-white hover:bg-slate-50 text-slate-600 flex items-center gap-1.5 transition-colors"
                                                            >
                                                                <FileText className="w-3.5 h-3.5" />
                                                                上传 .md 文件
                                                            </button>
                                                            {customRubricText && (
                                                                <span className="text-xs text-emerald-600">✅ 已加载 {customRubricText.length} 字符</span>
                                                            )}
                                                        </div>
                                                        <textarea
                                                            value={customRubricText}
                                                            onChange={(e) => setCustomRubricText(e.target.value)}
                                                            placeholder="把评分标准 Markdown 粘贴到这里；执行注入时会优先使用这份修正版..."
                                                            rows={6}
                                                            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 font-mono resize-y"
                                                        />
                                                    </div>
                                                </div>
                                            )}

                                            <p className="text-xs text-slate-400">
                                                你也可以直接把“解析不正确”的原始 Markdown 复制粘贴到上面的编辑区，修完后再注入，不需要回到生成页面重新来一遍。
                                            </p>
                                        </div>
                                    )}
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
                            disabled={injecting || (!injectScript && !injectRubric) || (!effectiveScriptMd && !effectiveRubricMd)}
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
