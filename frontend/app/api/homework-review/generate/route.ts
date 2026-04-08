import { NextRequest } from "next/server";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

export const runtime = "nodejs";
export const maxDuration = 300; // Vercel Hobby计划最大值

// Railway API配置
const RAILWAY_API_URL = process.env.NEXT_PUBLIC_HOMEWORK_API_URL;
const USE_REMOTE_API = !!RAILWAY_API_URL;

// 在Vercel serverless环境使用/tmp目录（可写）
const IS_VERCEL = process.env.VERCEL === "1";
const BASE_DIR = IS_VERCEL ? "/tmp" : path.resolve(process.cwd(), "..");
const HOMEWORK_REVIEW_DIR = IS_VERCEL ? path.join(BASE_DIR, "homework_review") : path.join(BASE_DIR, "homework_review");
const RUNTIME_DIR = path.join(HOMEWORK_REVIEW_DIR, "runtime");
const UPLOADS_DIR = path.join(RUNTIME_DIR, "uploads");
const OUTPUTS_DIR = path.join(RUNTIME_DIR, "outputs");

async function ensureDirs() {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.mkdir(OUTPUTS_DIR, { recursive: true });
}

function generateJobId() {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * POST /api/homework-review/generate
 *
 * 仅生成答案，不触发批阅。
 * 前端收到 generate_complete 后展示生成文件列表，由用户决定是否继续批阅。
 */
export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  function sseEvent(
    controller: ReadableStreamDefaultController,
    type: string,
    data: Record<string, unknown>
  ) {
    try {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type, ...data })}\n\n`)
      );
    } catch {
      /* stream closed */
    }
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // 如果配置了Railway API，使用远程服务
        if (USE_REMOTE_API) {
          const formData = await request.formData();
          
          // 重新构建FormData，只包含Railway API需要的字段
          const railwayFormData = new FormData();
          const file = formData.get("file") as File | null;
          const examText = ((formData.get("exam_text") as string) || "").trim();
          const examTitle = ((formData.get("exam_title") as string) || "").trim();
          if (!file && !examText) {
            sseEvent(controller, "error", { message: "请上传题卷文件或粘贴题卷文字" });
            controller.close();
            return;
          }
          
          if (file) railwayFormData.append("file", file);
          if (examText) railwayFormData.append("exam_text", examText);
          if (examTitle) railwayFormData.append("exam_title", examTitle);
          
          // 认证参数（仅存在时才发送）
          const auth = formData.get("authorization") as string;
          const ck = formData.get("cookie") as string;
          const nid = formData.get("instance_nid") as string;
          const lvls = formData.get("levels") as string;
          if (auth) railwayFormData.append("authorization", auth);
          if (ck) railwayFormData.append("cookie", ck);
          if (nid) railwayFormData.append("instance_nid", nid);
          if (lvls) railwayFormData.append("levels", lvls);
          
          // 可选LLM参数
          const llmApiKey = formData.get("llm_api_key") as string;
          const llmApiUrl = formData.get("llm_api_url") as string;
          const llmModel = formData.get("llm_model") as string;
          if (llmApiKey) railwayFormData.append("llm_api_key", llmApiKey);
          if (llmApiUrl) railwayFormData.append("llm_api_url", llmApiUrl);
          if (llmModel) railwayFormData.append("llm_model", llmModel);
          const customPromptRailway = formData.get("custom_prompt") as string;
          if (customPromptRailway) railwayFormData.append("custom_prompt", customPromptRailway);
          const customLevelsRailway = formData.get("custom_levels") as string;
          if (customLevelsRailway) railwayFormData.append("custom_levels", customLevelsRailway);
          
          // 转发到Railway API
          const response = await fetch(`${RAILWAY_API_URL}/api/generate`, {
            method: "POST",
            body: railwayFormData,
          });

          if (!response.ok) {
            sseEvent(controller, "error", { message: `Railway API错误: ${response.statusText}` });
            controller.close();
            return;
          }

          // 转发SSE流
          const reader = response.body?.getReader();
          if (reader) {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
          }
          controller.close();
          return;
        }

        // 本地模式：使用spawn Python
        if (IS_VERCEL && !USE_REMOTE_API) {
          sseEvent(controller, "error", {
            message: "❌ 未配置Railway API且无法在Vercel运行Python。请设置NEXT_PUBLIC_HOMEWORK_API_URL环境变量。"
          });
          controller.close();
          return;
        }

        await ensureDirs();
        const formData = await request.formData();

        // ── 读取文件 ──
        const file = formData.get("file") as File | null;
        const rawExamText = (formData.get("exam_text") as string) || "";
        const examText = rawExamText.trim();
        const examTitle = ((formData.get("exam_title") as string) || "").trim();
        if (!file && !examText) {
          sseEvent(controller, "error", { message: "请上传题卷文件或粘贴题卷文字" });
          controller.close();
          return;
        }

        // ── 读取参数 ──
        const authorization = (
          (formData.get("authorization") as string) || ""
        ).trim();
        const cookie = ((formData.get("cookie") as string) || "").trim();
        const instanceNid = (
          (formData.get("instance_nid") as string) || ""
        ).trim();
        const llmApiKey = (
          (formData.get("llm_api_key") as string) || ""
        ).trim() || (process.env.LLM_API_KEY || "").trim();
        const llmApiUrl = (
          (formData.get("llm_api_url") as string) || ""
        ).trim() || (process.env.LLM_BASE_URL || "").trim();
        const llmModel = ((formData.get("llm_model") as string) || "").trim() || (process.env.LLM_MODEL || "").trim();
        const customPrompt = (formData.get("custom_prompt") as string) || "";
        const customLevels = (formData.get("custom_levels") as string) || "";

        const levelsJson = formData.get("levels") as string;
        let levels: string[] = [
          "优秀的回答",
          "良好的回答",
          "中等的回答",
          "合格的回答",
          "较差的回答",
        ];
        try {
          if (levelsJson) levels = JSON.parse(levelsJson);
        } catch {
          /* keep defaults */
        }

        if (!authorization || !cookie || !instanceNid) {
          sseEvent(controller, "log", {
            message: "ℹ️ 未提供智慧树认证信息，将使用本地解析模式",
          });
        }

        const jobId = generateJobId();
        sseEvent(controller, "log", {
          message: `🆔 Job ID: ${jobId}`,
        });

        const jobUploadDir = path.join(UPLOADS_DIR, jobId);
        await fs.mkdir(jobUploadDir, { recursive: true });

        let inputPath: string | null = null;
        let inputTextPath: string | null = null;

        if (file) {
          const bytes = await file.arrayBuffer();
          const buffer = Buffer.from(bytes);
          const safeName = file.name.replace(
            /[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g,
            "_"
          );
          inputPath = path.join(jobUploadDir, safeName);
          await fs.writeFile(inputPath, buffer);

          sseEvent(controller, "log", {
            message: `📄 已保存题卷: ${safeName}`,
          });
        } else if (examText) {
          const safeTitle = (examTitle || "作业")
            .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, "_")
            .slice(0, 40) || "作业";
          inputTextPath = path.join(jobUploadDir, `${safeTitle}.txt`);
          await fs.writeFile(inputTextPath, rawExamText, "utf8");

          sseEvent(controller, "log", {
            message: `📝 已接收题卷文字内容（${examText.length} 字）`,
          });
        }

        // ── 输出目录 ──
        const outputRoot = path.join(OUTPUTS_DIR, jobId);
        await fs.mkdir(outputRoot, { recursive: true });

        // ── 环境变量 ──
        const envVars: Record<string, string> = {
          PYTHONUNBUFFERED: "1",
        };
        // 认证信息（可选，无认证时使用本地解析）
        if (authorization) envVars.AUTHORIZATION = authorization;
        if (cookie) envVars.COOKIE = cookie;
        if (instanceNid) envVars.INSTANCE_NID = instanceNid;
        if (llmApiKey) envVars.LLM_API_KEY = llmApiKey;
        if (llmApiUrl) envVars.LLM_API_URL = llmApiUrl;
        if (llmModel) envVars.LLM_MODEL = llmModel;
        if (customPrompt) envVars.CUSTOM_PROMPT = customPrompt;
        if (customLevels) envVars.CUSTOM_LEVELS = customLevels;

        // ── 启动 Python 子进程 ──
        const pythonBin =
          process.env.PYTHON_BIN ||
          "/opt/anaconda3/envs/agent-env/bin/python";
        const scriptPath = path.join(
          HOMEWORK_REVIEW_DIR,
          "generate_and_review_service.py"
        );

        const scriptArgs = [
          "-u",
          scriptPath,
          "--output-root",
          outputRoot,
          "--levels",
          ...levels,
          "--llm-api-key",
          llmApiKey || "",
          "--llm-api-url",
          llmApiUrl || "",
          "--llm-model",
          llmModel || "",
        ];

        if (inputPath) {
          scriptArgs.splice(2, 0, "--input", inputPath);
        } else if (inputTextPath) {
          scriptArgs.splice(2, 0, "--input-text-file", inputTextPath);
          if (examTitle) {
            scriptArgs.splice(4, 0, "--input-title", examTitle);
          }
        }

        sseEvent(controller, "log", {
          message: `🚀 启动答案生成流程...`,
        });

        const childEnv = {
          ...process.env,
          ...envVars,
        } as NodeJS.ProcessEnv;

        const child = spawn(pythonBin, scriptArgs, {
          cwd: HOMEWORK_REVIEW_DIR,
          env: childEnv,
        });

        let fullStderr = "";

        child.stdout.on("data", (chunk) => {
          const text = chunk.toString();
          const lines = text.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
              const msg = JSON.parse(trimmed);
              if (msg.type === "generate_complete") {
                // 生成完成 → 转发给前端，附加 jobId
                sseEvent(controller, "generate_complete", {
                  jobId,
                  outputRoot,
                  files: msg.files || [],
                });
              } else if (msg.type === "error") {
                sseEvent(controller, "error", {
                  message: msg.message,
                });
              } else if (msg.type === "log") {
                sseEvent(controller, "log", { message: msg.message });
              } else if (msg.type === "progress") {
                sseEvent(controller, "progress", {
                  current: msg.current,
                  total: msg.total,
                  message: msg.message || "",
                });
              } else {
                // 未知 JSON 消息，当日志
                sseEvent(controller, "log", { message: trimmed });
              }
            } catch {
              // 非 JSON 行，当日志
              sseEvent(controller, "log", { message: trimmed });
            }
          }
        });

        child.stderr.on("data", (chunk) => {
          const text = chunk.toString();
          fullStderr += text;
          const lines = text.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
              sseEvent(controller, "log", {
                message: `⚠️ ${trimmed}`,
                level: "warn",
              });
            }
          }
        });

        child.on("error", (err) => {
          sseEvent(controller, "error", {
            message: `进程启动失败: ${err.message}`,
          });
          controller.close();
        });

        child.on("close", (code) => {
          if (code !== 0) {
            sseEvent(controller, "error", {
              message: `Python 进程退出码 ${code}`,
            });
          }
          controller.close();
        });
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "未知服务端错误";
        sseEvent(controller, "error", { message });
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
