"use client";

import React, { useState, useEffect, useRef } from "react";
import { X, Shield, Key, FilePlus, Loader2, CheckCircle2, AlertCircle, Play, Cpu, Upload, ChevronDown, ChevronRight, FileText, RefreshCw } from "lucide-react";
import { PolymasCredentials, InjectProgressEvent, InjectSummary } from "@/lib/training-injector/types";
import { parsePolymasUrl } from "@/lib/training-injector/api";
import { AVAILABLE_MODELS, normalizeModelId } from "@/lib/config";
import { parseTaskConfig, parseTrainingScript } from "@/lib/training-injector/parser";

interface InjectConfigModalProps {
    isOpen: boolean;
    onClose: () => void;
    scriptMarkdown?: string;
    rubricMarkdown?: string;
}

const STORAGE_KEY = "training-injector-credentials";
const IMAGE_PROVIDER_OPTIONS = [
    { id: "cloudapi", name: "cloudapi（优先）" },
    { id: "openai", name: "OpenAI（优先）" },
];

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
    const [extractionMode, setExtractionMode] = useState<"hybrid" | "llm" | "regex">("regex");
    const [llmModel, setLlmModel] = useState("");
    const [coverStylePrompt, setCoverStylePrompt] = useState("图中禁止有任何文字和英文单词！写实风格，专业级渲染， 电影级光影 高清细节，16:9宽屏构图");
    const [imageProviderMode, setImageProviderMode] = useState<"cloudapi" | "openai">("cloudapi");
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

    const imageProviderPriority = imageProviderMode === "openai" ? "openai,cloudapi" : "cloudapi,openai";

    const logsEndRef = useRef<HTMLDivElement>(null);
    const combinedFileRef = useRef<HTMLInputElement>(null);
    const scriptFileRef = useRef<HTMLInputElement>(null);
    const rubricFileRef = useRef<HTMLInputElement>(null);

    // 计算最终生效的 markdown 文本（自定义文档覆盖生成的文档）
    const hasCustomDoc = customDocExpanded && (
        customDocMode === "combined"
            ? customCombinedText.trim().length > 0
            : (customScriptText.trim().length > 0 || customRubricText.trim().length > 0)
    );

    const effectiveScriptMd = hasCustomDoc
        ? (customDocMode === "combined" ? customCombinedText : customScriptText) || undefined
        : scriptMarkdown;

    const effectiveRubricMd = hasCustomDoc
        ? (customDocMode === "combined" ? customCombinedText : customRubricText) || undefined
        : rubricMarkdown;

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
            setInjectScript(hasCombined);
            setInjectRubric(hasCombined);
        } else {
            setInjectScript(customScriptText.trim().length > 0);
            setInjectRubric(customRubricText.trim().length > 0);
        }
    }, [hasCustomDoc, customDocMode, customCombinedText, customScriptText, customRubricText]);

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
                    setLlmModel(normalizeModelId(llmParsed.model) || "");
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
            })
        );
        return true;
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

        if (!finalLibraryFolderId) {
            try {
                const parsed = parsePolymasUrl(taskId.trim().includes("http") ? taskId.trim() : `https://example.com?${taskId.trim()}`);
                finalLibraryFolderId = parsed?.libraryFolderId || "";
            } catch {
                // ignore
            }
        }

        return { finalTaskId, finalCourseId, finalLibraryFolderId };
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
            const response = await fetch("/api/training-inject/stages", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    trainTaskId: finalTaskId,
                    credentials: {
                        authorization: authorization.trim(),
                        cookie: cookie.trim(),
                    },
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
            const loadedStages = Array.isArray(data.stages) ? data.stages : [];
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
        if (regenTarget === "background" && !regenStepId) {
            setError("请选择要重生背景图的阶段");
            return;
        }

        let llmSettings: any = undefined;
        try {
            const storedConfig = localStorage.getItem("llm-eval-settings");
            if (storedConfig) {
                llmSettings = JSON.parse(storedConfig);
                if (llmModel) llmSettings.model = llmModel;
            }
        } catch {
            // ignore
        }

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
            regenTarget === "cover"
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
                credentials: {
                    authorization: authorization.trim(),
                    cookie: cookie.trim(),
                },
                llmSettings,
                coverStylePrompt: coverStylePrompt.trim() || undefined,
                imageProviderPriority,
                trainTaskName,
                trainDescription,
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
                            credentials: {
                                authorization: authorization.trim(),
                                cookie: cookie.trim(),
                            },
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

                for (const stage of stageList) {
                    const matched = parsedSteps.find((step) => step.stepName === stage.stepName);
                    const stageDesc = matched?.description || "";
                    setRegenMessage(`正在重生阶段背景：${stage.stepName}（${current + 1}/${total}）...`);
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
                    current += 1;
                }

                setRegenMessage(`正在重生课程封面图（${current + 1}/${total}）...`);
                try {
                    await callRegenerateApi({
                        ...basePayload,
                        targetType: "cover",
                    });
                    coverOk = true;
                } catch (err) {
                    coverOk = false;
                    failedStages.push("课程封面");
                    console.warn("[InjectModal] 重生封面失败:", err);
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
                if (injectScript && !customScriptText.trim()) {
                    setError("已选注入剧本，但未提供训练剧本配置文档");
                    return;
                }
                if (injectRubric && !customRubricText.trim()) {
                    setError("已选注入评分标准，但未提供评分标准文档");
                    return;
                }
            }
        }

        setInjecting(true);
        setError("");
        setSummary(null);
        setProgressLogs([]);

        const shouldRunPostImageBatch = injectScript && (injectCoverImage || injectBackgroundImage);
        const shouldInjectCoverInMain = injectCoverImage && !shouldRunPostImageBatch;
        const shouldInjectBgInMain = injectBackgroundImage && !shouldRunPostImageBatch;

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
            if (shouldRunPostImageBatch) {
                setProgressLogs((prev) => [
                    ...prev,
                    {
                        type: "progress",
                        phase: "script",
                        message: "检测到已开启生图：将采用“先注入文本，再分步补图”模式，避免云端超时。",
                        current: 0,
                        total: 1,
                    },
                ]);
            }

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
                    coverStylePrompt: coverStylePrompt.trim() || undefined,
                    imageProviderPriority,
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
                let stageList: StageOption[] = [];
                if (injectBackgroundImage) {
                    const stageResponse = await fetch("/api/training-inject/stages", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            trainTaskId: finalTaskId,
                            credentials: {
                                authorization: authorization.trim(),
                                cookie: cookie.trim(),
                            },
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
                }

                const totalImageTasks = (injectCoverImage ? 1 : 0) + (injectBackgroundImage ? stageList.length : 0);
                let currentImageTask = 0;
                const failedItems: string[] = [];

                const baseRegenPayload = {
                    trainTaskId: finalTaskId,
                    courseId: finalCourseId,
                    libraryFolderId: finalLibraryFolderId,
                    credentials: {
                        authorization: authorization.trim(),
                        cookie: cookie.trim(),
                    },
                    llmSettings,
                    coverStylePrompt: coverStylePrompt.trim() || undefined,
                    imageProviderPriority,
                    trainTaskName: parseTaskConfig(effectiveScriptMd || "")?.trainTaskName || "训练任务",
                    trainDescription: parseTaskConfig(effectiveScriptMd || "")?.description || "",
                };

                if (injectBackgroundImage) {
                    for (const stage of stageList) {
                        pushImageLog(`正在补全阶段背景：${stage.stepName}（${currentImageTask + 1}/${totalImageTasks}）...`, currentImageTask + 1, totalImageTasks);
                        const matched = parsedSteps.find((step) => step.stepName === stage.stepName);
                        try {
                            await callRegenerateApi({
                                ...baseRegenPayload,
                                targetType: "background",
                                stepId: stage.stepId,
                                stepSnapshot: stage.stepSnapshot,
                                stageDescription: matched?.description || undefined,
                            });
                        } catch (stageErr) {
                            failedItems.push(stage.stepName || stage.stepId);
                            console.warn("[InjectModal] 注入后补全阶段背景失败:", stage.stepName, stageErr);
                        }
                        currentImageTask += 1;
                    }
                }

                if (injectCoverImage) {
                    pushImageLog(`正在补全课程封面图（${currentImageTask + 1}/${totalImageTasks}）...`, currentImageTask + 1, totalImageTasks);
                    try {
                        await callRegenerateApi({
                            ...baseRegenPayload,
                            targetType: "cover",
                        });
                    } catch (coverErr) {
                        failedItems.push("课程封面");
                        console.warn("[InjectModal] 注入后补全封面失败:", coverErr);
                    }
                    currentImageTask += 1;
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
                                    <label className="text-xs font-medium text-slate-700 block">生图方式</label>
                                    <select
                                        value={imageProviderMode}
                                        onChange={(e) => setImageProviderMode(e.target.value as "cloudapi" | "openai")}
                                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white"
                                    >
                                        {IMAGE_PROVIDER_OPTIONS.map((item) => (
                                            <option key={item.id} value={item.id}>{item.name}</option>
                                        ))}
                                    </select>
                                    <p className="text-xs text-slate-400">仅选择调用方式：当前方式失败后会自动回退到另一种方式。</p>
                                </div>

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
                                            {AVAILABLE_MODELS.map((m) => (
                                                <option key={m.id} value={m.id}>{m.name} — {m.description}</option>
                                            ))}
                                        </select>
                                        {!llmModel && (
                                            <p className="text-xs text-amber-600">⚠ 未检测到模型配置，请先在全局设置中配置 API Key 和模型，或在此处选择</p>
                                        )}
                                    </div>
                                )}

                                {/* 自定义文档上传（可折叠） */}
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
                                            自定义注入文档（可选）
                                        </span>
                                        {hasCustomDoc && (
                                            <span className="ml-auto text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">已加载自定义文档</span>
                                        )}
                                    </button>

                                    {customDocExpanded && (
                                        <div className="mt-3 space-y-4 pl-6">
                                            <p className="text-xs text-slate-400">
                                                可上传或粘贴您自己的训练配置/评分标准文档来注入，将替代上方生成的内容。
                                            </p>

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
                                                        训练配置 + 评分标准（合并文档）
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
                                                        placeholder="或直接粘贴包含训练配置和评分标准的 Markdown 文档内容..."
                                                        rows={6}
                                                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 font-mono resize-y"
                                                    />
                                                </div>
                                            ) : (
                                                /* 分开模式：训练配置和评分标准各一个文档 */
                                                <div className="space-y-4">
                                                    {/* 训练剧本配置文档 */}
                                                    <div className="space-y-2">
                                                        <label className="text-xs font-medium text-slate-700 block">
                                                            训练剧本配置文档
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
                                                            placeholder="粘贴训练剧本配置的 Markdown 内容..."
                                                            rows={4}
                                                            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 font-mono resize-y"
                                                        />
                                                    </div>

                                                    {/* 评分标准文档 */}
                                                    <div className="space-y-2">
                                                        <label className="text-xs font-medium text-slate-700 block">
                                                            评分标准文档
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
                                                            placeholder="粘贴评分标准的 Markdown 内容..."
                                                            rows={4}
                                                            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 font-mono resize-y"
                                                        />
                                                    </div>
                                                </div>
                                            )}

                                            {/* 清空按钮 */}
                                            {hasCustomDoc && (
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setCustomCombinedText("");
                                                        setCustomScriptText("");
                                                        setCustomRubricText("");
                                                    }}
                                                    className="text-xs text-red-500 hover:text-red-600 transition-colors"
                                                >
                                                    清空自定义文档，恢复使用生成的内容
                                                </button>
                                            )}
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
