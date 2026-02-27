/**
 * 训练配置生成器 - 前端 SSE 客户端封装
 */

import { TrainingSSEEvent } from "./types";

const SETTINGS_KEY = "llm-eval-settings";

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
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

export interface TrainingGenerateParams {
    /** 文件模式：传入 File 对象（服务端解析内容） */
    file?: File;
    /** 文本粘贴模式：直接传入文本内容 */
    teacherDocContent?: string;
    teacherDocName: string;
    generateScript: boolean;
    generateRubric: boolean;
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
    const { file, teacherDocContent, teacherDocName, generateScript, generateRubric,
            scriptPromptTemplate, rubricPromptTemplate, onEvent, signal } = params;
    const settings = getStoredSettings();

    let response: Response;

    if (file) {
        // 文件模式：FormData 上传，服务端用 mammoth 解析 docx
        const formData = new FormData();
        formData.append("file", file);
        formData.append("teacherDocName", teacherDocName);
        formData.append("generateScript", String(generateScript));
        formData.append("generateRubric", String(generateRubric));
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
        // 文本模式：JSON 发送
        response = await fetch("/api/training-generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                teacherDocContent: teacherDocContent || "",
                teacherDocName,
                generateScript,
                generateRubric,
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
        onEvent({ type: "error", message: `请求失败: ${response.status} ${response.statusText}` });
        return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
        onEvent({ type: "error", message: "无法读取响应流" });
        return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // 解析 SSE 数据行
            const lines = buffer.split("\n");
            buffer = lines.pop() || ""; // 保留不完整的行

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data: ")) continue;

                try {
                    const data = JSON.parse(trimmed.slice(6)) as TrainingSSEEvent;
                    onEvent(data);
                } catch {
                    // 忽略无法解析的行
                }
            }
        }

        // 处理缓冲区中剩余的数据
        if (buffer.trim().startsWith("data: ")) {
            try {
                const data = JSON.parse(buffer.trim().slice(6)) as TrainingSSEEvent;
                onEvent(data);
            } catch {
                // 忽略
            }
        }
    } finally {
        reader.releaseLock();
    }
}

/**
 * 检查 API 设置是否已配置
 */
export function isApiConfigured(): boolean {
    const settings = getStoredSettings();
    return Boolean(settings.apiKey && settings.apiUrl);
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
