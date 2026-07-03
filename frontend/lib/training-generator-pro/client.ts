/**
 * 能力训练 Pro - 前端 SSE 客户端封装
 */

import { ProTrainingSSEEvent } from "./types";
import { loadLLMSettingsFromStorage } from "@/lib/llm/settings";

export interface ProTrainingGenerateParams {
  /** 文件模式：传入 File 对象（服务端解析内容） */
  file?: File;
  /** 文本粘贴模式：直接传入文本内容 */
  teacherDocContent?: string;
  teacherDocName: string;
  /** 用户对本次配置生成的补充建议（选填） */
  userGenerationAdvice?: string;
  /** 自定义 Prompt 模板（含 {teacherDoc} 占位符）*/
  promptTemplate?: string;
  onEvent: (event: ProTrainingSSEEvent) => void;
  signal?: AbortSignal;
}

/**
 * 流式调用 Pro 版训练配置生成 API
 */
export async function streamProTrainingGenerate(
  params: ProTrainingGenerateParams,
): Promise<void> {
  const {
    file,
    teacherDocContent,
    teacherDocName,
    userGenerationAdvice,
    promptTemplate,
    onEvent,
    signal,
  } = params;
  const settings = loadLLMSettingsFromStorage("trainingGenerate");

  const shouldRetry = (error: unknown): boolean => {
    const msg = String(
      (error as Record<string, unknown>)?.message || error || "",
    ).toLowerCase();
    return (
      msg.includes("意外中断") ||
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
          message: `检测到生成中断，系统自动重试中（${attempt}/${maxAttempts}）...`,
        });
      }

      let response: Response;

      if (file) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("teacherDocName", teacherDocName);
        formData.append("apiKey", settings.apiKey || "");
        formData.append("apiUrl", settings.apiUrl || "");
        formData.append("model", settings.model || "");
        if (userGenerationAdvice) {
          formData.append("userGenerationAdvice", userGenerationAdvice);
        }
        if (promptTemplate) formData.append("promptTemplate", promptTemplate);

        response = await fetch("/api/training-generate-pro", {
          method: "POST",
          body: formData,
          signal,
        });
      } else {
        response = await fetch("/api/training-generate-pro", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            teacherDocContent: teacherDocContent || "",
            teacherDocName,
            apiKey: settings.apiKey || "",
            apiUrl: settings.apiUrl || "",
            model: settings.model || "",
            userGenerationAdvice: userGenerationAdvice || "",
            promptTemplate,
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
              const data = JSON.parse(trimmed.slice(6)) as ProTrainingSSEEvent;
              if (data.type === "complete") hasCompleteEvent = true;
              if (data.type === "error") hasErrorEvent = true;
              onEvent(data);
            } catch {
              // 忽略无法解析的行
            }
          }
        }

        // 处理缓冲区中残留的最后一条消息
        if (buffer.trim().startsWith("data: ")) {
          try {
            const data = JSON.parse(
              buffer.trim().slice(6),
            ) as ProTrainingSSEEvent;
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

  throw lastError instanceof Error ? lastError : new Error("生成失败");
}

/**
 * 检查 API 设置是否已配置
 */
export function isProApiConfigured(): boolean {
  const settings = loadLLMSettingsFromStorage("trainingGenerate");
  return Boolean(settings.apiUrl);
}

/**
 * 将文本内容下载为 .md 文件
 */
export function downloadProMarkdown(content: string, filename: string): void {
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
