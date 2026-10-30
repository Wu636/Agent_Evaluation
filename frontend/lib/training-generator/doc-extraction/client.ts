import { loadLLMSettingsFromStorage } from "@/lib/llm/settings";
import type { DocExtractionEvent, ExtractionMode } from "./types";

export interface DocExtractionParams {
    teacherDocName: string;
    file?: File;
    content?: string;
    mode: ExtractionMode;
    feedback?: string;
    previousOutline?: string;
    docFingerprint: string;
    signal?: AbortSignal;
    onEvent: (event: DocExtractionEvent) => void;
}

async function readErrorMessage(response: Response): Promise<string> {
    const raw = await response.text().catch(() => "");
    const trimmed = raw.trim();
    if (trimmed) {
        try {
            const data = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
            if (typeof data.error === "string" && data.error.trim()) return data.error;
            if (typeof data.message === "string" && data.message.trim()) return data.message;
        } catch {
            return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
        }
    }
    return `提取请求失败：${response.status}`;
}

export async function streamDocExtraction(params: DocExtractionParams): Promise<void> {
    const settings = loadLLMSettingsFromStorage("trainingGenerate");
    let response: Response;

    if (params.file) {
        const formData = new FormData();
        formData.append("file", params.file);
        formData.append("teacherDocName", params.teacherDocName);
        formData.append("mode", params.mode);
        formData.append("docFingerprint", params.docFingerprint);
        if (params.feedback) formData.append("feedback", params.feedback);
        if (params.previousOutline) formData.append("previousOutline", params.previousOutline);
        formData.append("apiKey", settings.apiKey || "");
        formData.append("apiUrl", settings.apiUrl || "");
        formData.append("model", settings.model || "");

        response = await fetch("/api/training-generate/extract-doc", {
            method: "POST",
            body: formData,
            signal: params.signal,
        });
    } else {
        response = await fetch("/api/training-generate/extract-doc", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                teacherDocContent: params.content || "",
                teacherDocName: params.teacherDocName,
                mode: params.mode,
                docFingerprint: params.docFingerprint,
                feedback: params.feedback || "",
                previousOutline: params.previousOutline || "",
                apiKey: settings.apiKey || "",
                apiUrl: settings.apiUrl || "",
                model: settings.model || "",
            }),
            signal: params.signal,
        });
    }

    if (!response.ok) {
        throw new Error(await readErrorMessage(response));
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("无法读取提取响应流");

    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;

    const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) return;
        try {
            const event = JSON.parse(trimmed.slice(6)) as DocExtractionEvent;
            if (event.type === "result" || event.type === "skip" || event.type === "error") finished = true;
            params.onEvent(event);
        } catch {
            // 忽略无法解析的行
        }
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            lines.forEach(handleLine);
        }
        if (buffer.trim()) handleLine(buffer);
    } finally {
        reader.releaseLock();
    }

    if (!finished) {
        throw new Error("提取流意外中断：未收到完成信号");
    }
}
