import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

export const runtime = "nodejs";
export const maxDuration = 300;

// process.cwd() = frontend/，所以 .. 是项目根 Agent_Evaluation/
const PROJECT_ROOT = path.resolve(process.cwd(), "..");
const HOMEWORK_REVIEW_DIR = path.join(PROJECT_ROOT, "homework_review");
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

async function saveUploadedFiles(jobId: string, files: File[]) {
  const jobUploadDir = path.join(UPLOADS_DIR, jobId);
  await fs.mkdir(jobUploadDir, { recursive: true });

  const savedPaths: string[] = [];
  for (const file of files) {
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const safeName = file.name.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, "_");
    const targetPath = path.join(jobUploadDir, safeName);
    await fs.writeFile(targetPath, buffer);
    savedPaths.push(targetPath);
  }

  return { jobUploadDir, savedPaths };
}

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  // 辅助函数：发送 SSE 事件
  function sseEvent(controller: ReadableStreamDefaultController, type: string, data: any) {
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, ...data })}\n\n`));
    } catch { /* stream closed */ }
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        await ensureDirs();

        const formData = await request.formData();
        const files = formData.getAll("files") as File[];

        // 支持从 server_paths 直接指定服务器上已有文件（生成模式第二步）
        const serverPathsJson = (formData.get("server_paths") as string || "").trim();
        let serverPaths: string[] = [];
        try {
          if (serverPathsJson) serverPaths = JSON.parse(serverPathsJson);
        } catch { /* ignore */ }

        if ((!files || files.length === 0) && serverPaths.length === 0) {
          sseEvent(controller, "error", { message: "请上传至少一个作业文件" });
          controller.close();
          return;
        }

        // 读取前端传入的智慧树认证参数
        const authorization = (formData.get("authorization") as string || "").trim();
        const cookie = (formData.get("cookie") as string || "").trim();
        const instanceNid = (formData.get("instance_nid") as string || "").trim();
        const llmApiKey = (formData.get("llm_api_key") as string || "").trim() || (process.env.LLM_API_KEY || "").trim();
        const llmApiUrl = (formData.get("llm_api_url") as string || "").trim() || (process.env.LLM_BASE_URL || "").trim();
        const llmModel = (formData.get("llm_model") as string || "").trim() || (process.env.LLM_MODEL || "").trim();

        if (!authorization || !cookie || !instanceNid) {
          sseEvent(controller, "error", { message: "请填写完整的智慧树认证信息" });
          controller.close();
          return;
        }

        const attempts = Number(formData.get("attempts") || 5);
        const outputFormat = (formData.get("output_format") || "json") as "json" | "pdf";
        const maxConcurrency = Number(formData.get("max_concurrency") || 5);
        const localParse = String(formData.get("local_parse") || "false") === "true";

        const jobId = generateJobId();

        sseEvent(controller, "log", { message: `🆔 Job ID: ${jobId}` });

        let savedPaths: string[];

        if (serverPaths.length > 0) {
          // 使用服务器上已有文件（生成模式第二步）
          savedPaths = serverPaths;
          sseEvent(controller, "log", { message: `📂 使用已生成的 ${savedPaths.length} 个文件` });
        } else {
          sseEvent(controller, "log", { message: `📦 正在保存 ${files.length} 个上传文件...` });
          const uploadResult = await saveUploadedFiles(jobId, files);
          savedPaths = uploadResult.savedPaths;
        }

        sseEvent(controller, "log", { message: `✅ 文件就绪，开始调用 Python 批阅服务` });
        sseEvent(controller, "log", { message: `⚙️ 参数: 评测${attempts}次, 格式=${outputFormat}, 并发=${maxConcurrency}, ${localParse ? "本地解析" : "云端解析"}` });

        const outputRoot = path.join(OUTPUTS_DIR, jobId);
        await fs.mkdir(outputRoot, { recursive: true });

        // 将认证凭证作为环境变量传给 Python 子进程
        const envVars: Record<string, string> = {
          AUTHORIZATION: authorization,
          COOKIE: cookie,
          INSTANCE_NID: instanceNid,
          PYTHONUNBUFFERED: "1",  // 关键：禁用 Python 输出缓冲
        };
        if (llmApiKey) envVars.LLM_API_KEY = llmApiKey;
        if (llmApiUrl) envVars.LLM_API_URL = llmApiUrl;
        if (llmModel) envVars.LLM_MODEL = llmModel;

        const pythonBin = process.env.PYTHON_BIN || "/opt/anaconda3/envs/agent-env/bin/python";
        const scriptPath = path.join(HOMEWORK_REVIEW_DIR, "review_service.py");

        const scriptArgs = [
          "-u",  // 强制无缓冲输出
          scriptPath,
          "--inputs", JSON.stringify(savedPaths),
          "--attempts", String(Math.max(1, attempts)),
          "--output-format", outputFormat,
          "--output-root", outputRoot,
          "--max-concurrency", String(Math.max(1, maxConcurrency)),
        ];
        if (localParse) scriptArgs.push("--local-parse");

        const childEnv = { ...process.env, ...envVars } as NodeJS.ProcessEnv;

        const child = spawn(pythonBin, scriptArgs, {
          cwd: HOMEWORK_REVIEW_DIR,
          env: childEnv,
        });

        let fullStdout = "";
        let fullStderr = "";

        // 实时推送 stdout
        child.stdout.on("data", (chunk) => {
          const text = chunk.toString();
          fullStdout += text;
          // 按行分割推送
          const lines = text.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
              sseEvent(controller, "log", { message: trimmed });
            }
          }
        });

        // 实时推送 stderr
        child.stderr.on("data", (chunk) => {
          const text = chunk.toString();
          fullStderr += text;
          const lines = text.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
              sseEvent(controller, "log", { message: `⚠️ ${trimmed}`, level: "warn" });
            }
          }
        });

        child.on("error", (err) => {
          sseEvent(controller, "error", { message: `进程启动失败: ${err.message}` });
          controller.close();
        });

        child.on("close", async (code) => {
          if (code !== 0) {
            sseEvent(controller, "error", {
              message: `Python 进程退出码 ${code}: ${fullStderr.slice(-500) || fullStdout.slice(-500)}`,
            });
            controller.close();
            return;
          }

          // 解析结果
          const marker = "__RESULT__";
          const markerIndex = fullStdout.lastIndexOf(marker);
          if (markerIndex === -1) {
            sseEvent(controller, "error", { message: "未找到结果输出标记" });
            controller.close();
            return;
          }

          const jsonText = fullStdout.slice(markerIndex + marker.length).trim();
          try {
            const payload = JSON.parse(jsonText);

            // 保存 job 元数据
            const jobMeta = {
              jobId,
              createdAt: new Date().toISOString(),
              outputRoot,
              outputFiles: payload.output_files || [],
              summary: payload.result || {},
            };
            await fs.writeFile(
              path.join(outputRoot, "job.json"),
              JSON.stringify(jobMeta, null, 2),
              "utf-8"
            );

            // 发送最终结果（含评分表 JSON）
            sseEvent(controller, "complete", {
              jobId,
              outputFiles: payload.output_files || [],
              summary: payload.result || {},
              scoreTable: payload.score_table || null,
              downloadBaseUrl: "/api/homework-review/download",
            });
          } catch (err) {
            sseEvent(controller, "error", {
              message: `结果解析失败: ${(err as Error).message}`,
            });
          }

          controller.close();
        });
      } catch (error) {
        console.error("作业批阅失败:", error);
        sseEvent(controller, "error", {
          message: error instanceof Error ? error.message : "作业批阅失败",
        });
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
