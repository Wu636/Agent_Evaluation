/**
 * 训练配置生成器 - 前端 SSE 客户端封装
 */

import { ScriptMode, TrainingPlanRequestOptions, TrainingSSEEvent, TrainingScriptPlan, TrainingScriptPlanResponse } from "./types";
import { loadLLMSettingsFromStorage } from "@/lib/llm/settings";

export interface TrainingGenerateParams {
    /** 文件模式：传入 File 对象（服务端解析内容） */
    file?: File;
    /** 文本粘贴模式：直接传入文本内容 */
    teacherDocContent?: string;
    teacherDocName: string;
    generateScript: boolean;
    generateRubric: boolean;
    scriptMode?: ScriptMode;
    modulePlan?: TrainingScriptPlan;
    /** 自定义剧本生成 Prompt（含 {teacherDoc} 占位符）*/
    scriptPromptTemplate?: string;
    /** 自定义评分标准 Prompt（含 {teacherDoc} 占位符）*/
    rubricPromptTemplate?: string;
    onEvent: (event: TrainingSSEEvent) => void;
    signal?: AbortSignal;
}

/**
 * 流式调用训练配置生成 API
 * - 文件模式：用 FormData 上传原始文件，服务端解析（支持 .docx）
 * - 文本模式：用 JSON 发送文本内容
 */
export async function streamTrainingGenerate(params: TrainingGenerateParams): Promise<void> {
    const { file, teacherDocContent, teacherDocName, generateScript, generateRubric, scriptMode = "general", modulePlan,
            scriptPromptTemplate, rubricPromptTemplate, onEvent, signal } = params;
    const settings = loadLLMSettingsFromStorage("trainingGenerate");

    const shouldRetry = (error: unknown): boolean => {
        const msg = String((error as any)?.message || error || "").toLowerCase();
        return (
            msg.includes("意外中断") ||
            msg.includes("疑似截断") ||
            msg.includes("terminated") ||
            msg.includes("econnreset") ||
            msg.includes("fetch failed") ||
            msg.includes("timeout")
        );
    };

    const maxAttempts = 2;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            if (attempt > 1) {
                onEvent({
                    type: "start",
                    phase: generateScript ? "script" : "rubric",
                    message: `检测到生成中断，系统自动重试中（${attempt}/${maxAttempts}）...`,
                });
            }

            let response: Response;

            if (file) {
                const formData = new FormData();
                formData.append("file", file);
                formData.append("teacherDocName", teacherDocName);
                formData.append("generateScript", String(generateScript));
                formData.append("generateRubric", String(generateRubric));
                formData.append("scriptMode", scriptMode);
                if (modulePlan) formData.append("modulePlan", JSON.stringify(modulePlan));
                formData.append("apiKey", settings.apiKey || "");
                formData.append("apiUrl", settings.apiUrl || "");
                formData.append("model", settings.model || "");
                if (scriptPromptTemplate) formData.append("scriptPromptTemplate", scriptPromptTemplate);
                if (rubricPromptTemplate) formData.append("rubricPromptTemplate", rubricPromptTemplate);

                response = await fetch("/api/training-generate", {
                    method: "POST",
                    body: formData,
                    signal,
                });
            } else {
                response = await fetch("/api/training-generate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        teacherDocContent: teacherDocContent || "",
                        teacherDocName,
                        generateScript,
                        generateRubric,
                        scriptMode,
                        modulePlan,
                        apiKey: settings.apiKey || "",
                        apiUrl: settings.apiUrl || "",
                        model: settings.model || "",
                        scriptPromptTemplate,
                        rubricPromptTemplate,
                    }),
                    signal,
                });
            }

            if (!response.ok) {
                throw new Error(`请求失败: ${response.status} ${response.statusText}`);
            }

            const reader = response.body?.getReader();
            if (!reader) {
                throw new Error("无法读取响应流");
            }

            const decoder = new TextDecoder();
            let buffer = "";
            let hasCompleteEvent = false;
            let hasErrorEvent = false;

            try {
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
                            const data = JSON.parse(trimmed.slice(6)) as TrainingSSEEvent;
                            if (data.type === "complete") hasCompleteEvent = true;
                            if (data.type === "error") hasErrorEvent = true;
                            onEvent(data);
                        } catch {
                            // 忽略无法解析的行
                        }
                    }
                }

                if (buffer.trim().startsWith("data: ")) {
                    try {
                        const data = JSON.parse(buffer.trim().slice(6)) as TrainingSSEEvent;
                        if (data.type === "complete") hasCompleteEvent = true;
                        if (data.type === "error") hasErrorEvent = true;
                        onEvent(data);
                    } catch {
                        // ignore
                    }
                }

                if (!hasCompleteEvent && !hasErrorEvent) {
                    throw new Error("生成流意外中断：未收到完成信号");
                }
            } finally {
                reader.releaseLock();
            }

            return;
        } catch (error) {
            lastError = error;
            if (attempt < maxAttempts && shouldRetry(error)) {
                continue;
            }
            throw error;
        }
    }

    throw (lastError instanceof Error ? lastError : new Error("生成失败"));
}

export interface TrainingPlanParams {
    file?: File;
    teacherDocContent?: string;
    teacherDocName: string;
    planningFeedback?: string;
    usePreviousPlan?: boolean;
    currentPlan?: TrainingScriptPlan;
    previousPlan?: TrainingScriptPlan;
}

export interface ModuleRegenerateParams {
    file?: File;
    teacherDocContent?: string;
    teacherDocName: string;
    modulePlan: TrainingScriptPlan;
    targetModuleId: string;
    feedback: string;
    usePreviousResult: boolean;
    currentStageMarkdown?: string;
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
    const raw = await response.text().catch(() => "");
    const trimmed = raw.trim();

    if (trimmed) {
        try {
            const data = JSON.parse(trimmed) as { error?: unknown; message?: unknown; detail?: unknown };
            if (typeof data.error === "string" && data.error.trim()) return data.error;
            if (typeof data.message === "string" && data.message.trim()) return data.message;
            if (typeof data.detail === "string" && data.detail.trim()) return data.detail;
        } catch {
            return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
        }
    }

    return fallback;
}

export async function createTrainingScriptPlan(params: TrainingPlanParams): Promise<TrainingScriptPlanResponse> {
    const settings = loadLLMSettingsFromStorage("trainingGenerate");
    let response: Response;
    const options: TrainingPlanRequestOptions = {
        planningFeedback: params.planningFeedback,
        usePreviousPlan: params.usePreviousPlan,
        currentPlan: params.currentPlan,
        previousPlan: params.previousPlan,
    };

    if (params.file) {
        const formData = new FormData();
        formData.append("file", params.file);
        formData.append("teacherDocName", params.teacherDocName);
        if (options.planningFeedback) formData.append("planningFeedback", options.planningFeedback);
        if (typeof options.usePreviousPlan === "boolean") formData.append("usePreviousPlan", String(options.usePreviousPlan));
        if (options.currentPlan) formData.append("currentPlan", JSON.stringify(options.currentPlan));
        if (options.previousPlan) formData.append("previousPlan", JSON.stringify(options.previousPlan));
        formData.append("apiKey", settings.apiKey || "");
        formData.append("apiUrl", settings.apiUrl || "");
        formData.append("model", settings.model || "");

        response = await fetch("/api/training-generate/plan", {
            method: "POST",
            body: formData,
        });
    } else {
        response = await fetch("/api/training-generate/plan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                teacherDocContent: params.teacherDocContent || "",
                teacherDocName: params.teacherDocName,
                planningFeedback: options.planningFeedback || "",
                usePreviousPlan: options.usePreviousPlan ?? false,
                currentPlan: options.currentPlan,
                previousPlan: options.previousPlan,
                apiKey: settings.apiKey || "",
                apiUrl: settings.apiUrl || "",
                model: settings.model || "",
            }),
        });
    }

    if (!response.ok) {
        const message = await readErrorMessage(response, `请求失败: ${response.status}`);
        throw new Error(message || "模块规划失败");
    }

    const data = await response.json();
    return {
        plan: data.plan,
        validation: data.validation || [],
        autofillApplied: data.autofillApplied || false,
        autofillFields: data.autofillFields || [],
        autofillTaskFields: data.autofillTaskFields || [],
        autofillModuleFields: data.autofillModuleFields || {},
    };
}

export async function regenerateTrainingScriptModule(params: ModuleRegenerateParams): Promise<{ stageMarkdown: string; stageIndex: number; moduleId: string }> {
    const settings = loadLLMSettingsFromStorage("trainingGenerate");
    let response: Response;

    if (params.file) {
        const formData = new FormData();
        formData.append("file", params.file);
        formData.append("teacherDocName", params.teacherDocName);
        formData.append("modulePlan", JSON.stringify(params.modulePlan));
        formData.append("targetModuleId", params.targetModuleId);
        formData.append("feedback", params.feedback);
        formData.append("usePreviousResult", String(params.usePreviousResult));
        if (params.currentStageMarkdown) formData.append("currentStageMarkdown", params.currentStageMarkdown);
        formData.append("apiKey", settings.apiKey || "");
        formData.append("apiUrl", settings.apiUrl || "");
        formData.append("model", settings.model || "");

        response = await fetch("/api/training-generate/module-regenerate", {
            method: "POST",
            body: formData,
        });
    } else {
        response = await fetch("/api/training-generate/module-regenerate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                teacherDocContent: params.teacherDocContent || "",
                teacherDocName: params.teacherDocName,
                modulePlan: params.modulePlan,
                targetModuleId: params.targetModuleId,
                feedback: params.feedback,
                usePreviousResult: params.usePreviousResult,
                currentStageMarkdown: params.currentStageMarkdown || "",
                apiKey: settings.apiKey || "",
                apiUrl: settings.apiUrl || "",
                model: settings.model || "",
            }),
        });
    }

    const data = await response.json().catch(() => ({ error: `请求失败: ${response.status}` }));
    if (!response.ok) {
        throw new Error(data.error || "局部重生成失败");
    }

    return {
        stageMarkdown: data.stageMarkdown,
        stageIndex: data.stageIndex,
        moduleId: data.moduleId,
    };
}

/**
 * 检查 API 设置是否已配置
 */
export function isApiConfigured(): boolean {
    const settings = loadLLMSettingsFromStorage("trainingGenerate");
    return Boolean(settings.apiUrl);
}

/**
 * 将文本内容下载为 .md 文件
 */
export function downloadMarkdown(content: string, filename: string): void {
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.endsWith(".md") ? filename : `${filename}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * 复制文本到剪贴板
 */
export async function copyToClipboard(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // fallback
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(textarea);
        return ok;
    }
}

/**
 * 读取文件内容为文本
 * 支持 .txt / .md 直接读取，.docx 需要额外处理
 */
export function readFileAsText(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("文件读取失败"));
        reader.readAsText(file);
    });
}
