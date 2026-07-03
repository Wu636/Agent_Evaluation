/**
 * POST /api/training-generate-pro
 * 能力训练 Pro - 流式生成 API
 * 仅生成 Pro 格式配置（无评分标准）
 */

import { NextRequest } from "next/server";
import { MODEL_NAME_MAPPING } from "@/lib/config";
import { ApiConfig } from "@/lib/llm/types";
import { callLLMStream } from "@/lib/llm/utils";
import {
  buildProScriptGeneratorPrompt,
  PRO_SCRIPT_SYSTEM_PROMPT,
} from "@/lib/training-generator-pro/prompts";
import { convertDocxToText } from "@/lib/converters/docx-converter";
import WordExtractor from "word-extractor";

// Vercel 函数配置
export const maxDuration = 300;
export const runtime = "nodejs";

function formatStreamErrorMessage(err: unknown): string {
  const anyErr = err as {
    message?: string;
    cause?: { message?: string; code?: string };
  };
  const rawMsg = String(anyErr?.message || err || "");
  const rawCause = String(anyErr?.cause?.message || "");
  const combined = `${rawMsg} ${rawCause}`.toLowerCase();

  if (
    combined.includes("当前 llm api 地址不可达") ||
    combined.includes("und_err_connect_timeout") ||
    combined.includes("connect timeout") ||
    combined.includes("fetch failed")
  ) {
    return rawMsg;
  }

  if (/terminated|econnreset/i.test(rawMsg)) {
    return "LLM 流式连接中断（网络波动或网关超时）。系统已自动重试一次但仍失败，请稍后重试。";
  }

  return rawMsg || "生成失败";
}

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        let teacherDocContent: string;
        let teacherDocName: string;
        let apiKey: string;
        let apiUrl: string;
        let model: string;
        let promptTemplate: string | undefined;
        let userGenerationAdvice: string;

        const contentType = request.headers.get("content-type") || "";

        if (contentType.includes("multipart/form-data")) {
          // 文件上传模式：服务端解析文件内容
          const formData = await request.formData();
          teacherDocName =
            (formData.get("teacherDocName") as string) || "未命名文档";
          apiKey = (formData.get("apiKey") as string) || "";
          apiUrl = (formData.get("apiUrl") as string) || "";
          model = (formData.get("model") as string) || "";
          promptTemplate =
            (formData.get("promptTemplate") as string) || undefined;
          userGenerationAdvice = String(
            formData.get("userGenerationAdvice") || "",
          ).trim();

          const file = formData.get("file") as File | null;
          if (!file) {
            throw new Error("未上传文件");
          }

          // 根据文件类型解析内容
          const fileName = file.name.toLowerCase();
          if (fileName.endsWith(".docx")) {
            const arrayBuffer = await file.arrayBuffer();
            teacherDocContent = await convertDocxToText(
              Buffer.from(arrayBuffer),
            );
          } else if (fileName.endsWith(".doc")) {
            const arrayBuffer = await file.arrayBuffer();
            const extractor = new WordExtractor();
            const extracted = await extractor.extract(Buffer.from(arrayBuffer));
            teacherDocContent = extracted.getBody();
          } else {
            // .txt / .md 等文本文件
            teacherDocContent = await file.text();
          }
        } else {
          // JSON 模式
          const body = await request.json();
          teacherDocContent = body.teacherDocContent || "";
          teacherDocName = body.teacherDocName || "未命名文档";
          apiKey = body.apiKey || "";
          apiUrl = body.apiUrl || "";
          model = body.model || "";
          promptTemplate = body.promptTemplate || undefined;
          userGenerationAdvice = String(body.userGenerationAdvice || "").trim();
        }

        if (!teacherDocContent.trim()) {
          throw new Error("教师文档内容为空");
        }

        // 获取 API 配置
        const finalApiUrl =
          apiUrl ||
          process.env.LLM_BASE_URL ||
          "https://llm-service.polymas.com/api/openai/v1/chat/completions";
        const finalApiKey = apiKey || process.env.LLM_API_KEY || "";
        const finalModel =
          MODEL_NAME_MAPPING[model] ||
          model ||
          process.env.LLM_MODEL ||
          "gpt-4o";

        const apiConfig: ApiConfig & { model: string } = {
          apiKey: finalApiKey,
          baseUrl: finalApiUrl,
          model: finalModel,
        };

        // 发送开始事件
        const sendEvent = (data: unknown) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
          );
        };

        sendEvent({ type: "start", message: "正在生成能力训练 Pro 配置..." });

        // 构建 Prompt
        const prompt = buildProScriptGeneratorPrompt(
          teacherDocContent,
          promptTemplate || undefined,
          userGenerationAdvice,
        );

        // 流式调用 LLM
        let fullContent = "";
        const streamGenerator = callLLMStream(
          prompt,
          apiConfig,
          0.7,
          PRO_SCRIPT_SYSTEM_PROMPT,
        );

        for await (const chunk of streamGenerator) {
          fullContent += chunk;
          sendEvent({ type: "chunk", content: chunk });
        }

        // 提取任务名称
        const taskNameMatch = fullContent.match(
          /^#\s+(.+?)(?:\s*-\s*能力训练\s*Pro\s*配置)?$/m,
        );
        const taskName = taskNameMatch
          ? taskNameMatch[1].trim()
          : teacherDocName;

        // 发送完成事件
        sendEvent({
          type: "complete",
          fullContent,
          taskName,
        });
      } catch (err) {
        const errorMessage = formatStreamErrorMessage(err);
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "error", message: errorMessage })}\n\n`,
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
