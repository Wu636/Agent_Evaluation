import { normalizeModelId } from "@/lib/config";
import { TrainingScriptPlan } from "@/lib/training-generator/types";
import { TemplateDimensionsConfig } from "@/lib/templates";

import { OptimizationLoopResult, OptimizationProgressEvent } from "./types";

const SETTINGS_KEY = "llm-eval-settings";
const DEFAULT_API_URL = "https://llm-service.polymas.com/api/openai/v1/chat/completions";

interface StoredSettings {
    apiKey?: string;
    apiUrl?: string;
    model?: string;
}

function getStoredSettings(): StoredSettings {
    if (typeof window === "undefined") return {};

    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as StoredSettings;
        return {
            ...parsed,
            apiUrl: parsed.apiUrl || DEFAULT_API_URL,
            model: normalizeModelId(parsed.model),
        };
    } catch {
        return {};
    }
}

export interface TrainingOptimizationParams {
    teacherDocFile?: File;
    teacherDocContent?: string;
    teacherDocName: string;
    dialogueFile?: File;
    dialogueRecordContent?: string;
    dialogueRecordName: string;
    scriptMarkdown: string;
    rubricMarkdown?: string;
    modulePlan?: TrainingScriptPlan;
    maxActions?: number;
    optimizationFeedback?: string;
    evaluationTemplateId?: string;
    evaluationTemplateName?: string;
    evaluationTemplateDimensions?: TemplateDimensionsConfig;
    onProgress?: (event: OptimizationProgressEvent) => void;
}

export async function runTrainingOptimizationLoop(params: TrainingOptimizationParams): Promise<OptimizationLoopResult> {
    const settings = getStoredSettings();
    let response: Response;

    if (params.teacherDocFile || params.dialogueFile) {
        const formData = new FormData();
        if (params.teacherDocFile) {
            formData.append("teacherDocFile", params.teacherDocFile);
        } else {
            formData.append("teacherDocContent", params.teacherDocContent || "");
        }
        if (params.dialogueFile) {
            formData.append("dialogueFile", params.dialogueFile);
        } else {
            formData.append("dialogueRecordContent", params.dialogueRecordContent || "");
        }

        formData.append("teacherDocName", params.teacherDocName);
        formData.append("dialogueRecordName", params.dialogueRecordName);
        formData.append("scriptMarkdown", params.scriptMarkdown);
        if (params.rubricMarkdown) formData.append("rubricMarkdown", params.rubricMarkdown);
        if (params.modulePlan) formData.append("modulePlan", JSON.stringify(params.modulePlan));
        if (params.maxActions) formData.append("maxActions", String(params.maxActions));
        if (params.optimizationFeedback) formData.append("optimizationFeedback", params.optimizationFeedback);
        if (params.evaluationTemplateId) formData.append("evaluationTemplateId", params.evaluationTemplateId);
        if (params.evaluationTemplateName) formData.append("evaluationTemplateName", params.evaluationTemplateName);
        if (params.evaluationTemplateDimensions) {
            formData.append("evaluationTemplateDimensions", JSON.stringify(params.evaluationTemplateDimensions));
        }
        formData.append("apiKey", settings.apiKey || "");
        formData.append("apiUrl", settings.apiUrl || "");
        formData.append("model", settings.model || "");

        response = await fetch("/api/training-optimize", {
            method: "POST",
            body: formData,
        });
    } else {
        response = await fetch("/api/training-optimize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                teacherDocContent: params.teacherDocContent || "",
                teacherDocName: params.teacherDocName,
                dialogueRecordContent: params.dialogueRecordContent || "",
                dialogueRecordName: params.dialogueRecordName,
                scriptMarkdown: params.scriptMarkdown,
                rubricMarkdown: params.rubricMarkdown,
                modulePlan: params.modulePlan,
                maxActions: params.maxActions,
                optimizationFeedback: params.optimizationFeedback,
                evaluationTemplateId: params.evaluationTemplateId,
                evaluationTemplateName: params.evaluationTemplateName,
                evaluationTemplateDimensions: params.evaluationTemplateDimensions,
                apiKey: settings.apiKey || "",
                apiUrl: settings.apiUrl || "",
                model: settings.model || "",
            }),
        });
    }

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: `请求失败: ${response.status}` }));
        throw new Error(errorData.error || "闭环优化失败");
    }

    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error("未收到闭环优化响应流");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult: OptimizationLoopResult | null = null;
    let pendingError = "";

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const chunks = buffer.split("\n\n");
            buffer = chunks.pop() || "";

            for (const chunk of chunks) {
                const line = chunk
                    .split("\n")
                    .find((entry) => entry.startsWith("data: "));
                if (!line) continue;

                const payload = line.slice(6);
                try {
                    const event = JSON.parse(payload) as OptimizationProgressEvent;
                    params.onProgress?.(event);

                    if (event.type === "complete" && event.result) {
                        finalResult = event.result;
                    } else if (event.type === "error") {
                        pendingError = event.message || "闭环优化失败";
                    }
                } catch (error) {
                    console.warn("[training-optimize] 无法解析 SSE 事件:", error);
                }
            }
        }
    } finally {
        reader.releaseLock();
    }

    if (pendingError) {
        throw new Error(pendingError);
    }
    if (!finalResult) {
        throw new Error("闭环优化未返回最终结果");
    }

    return finalResult;
}
