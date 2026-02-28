import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

export const runtime = "nodejs";
export const maxDuration = 300;

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
        // 如果配置了Railway API，使用远程服务
        if (USE_REMOTE_API) {
          const formData = await request.formData();

          // 重新构建FormData，只包含Railway API需要的字段
          const railwayFormData = new FormData();

          // 文件或路径
          const files = formData.getAll("files") as File[];
          const serverPaths = formData.get("server_paths") as string;

          if (files && files.length > 0 && files[0].size > 0) {
            // 用户直接上传的文件 → 直接转发
            files.forEach(file => railwayFormData.append("files", file));
          } else if (serverPaths) {
            // server_paths 是 Railway 内部路径，需要先从 Railway 下载文件再上传
            try {
              const paths: string[] = JSON.parse(serverPaths);
              sseEvent(controller, "log", { message: `📥 正在从服务器下载 ${paths.length} 份生成文件...` });

              for (const filePath of paths) {
                const downloadUrl = `${RAILWAY_API_URL}/api/files?path=${encodeURIComponent(filePath)}`;
                const fileResp = await fetch(downloadUrl);

                if (!fileResp.ok) {
                  sseEvent(controller, "error", {
                    message: `❌ 无法下载文件: ${filePath.split('/').pop()}\n可能服务已重新部署，临时文件已丢失。请重新“生成答案”后再批阅。`
                  });
                  controller.close();
                  return;
                }

                const blob = await fileResp.blob();
                const fileName = filePath.split('/').pop() || 'file.docx';
                railwayFormData.append("files", blob, fileName);
              }

              sseEvent(controller, "log", { message: `✅ 文件下载完成，开始批阅...` });
            } catch (e: any) {
              sseEvent(controller, "error", { message: `文件下载失败: ${e.message}` });
              controller.close();
              return;
            }
          }

          // 必需参数
          railwayFormData.append("authorization", (formData.get("authorization") as string) || "");
          railwayFormData.append("cookie", (formData.get("cookie") as string) || "");
          railwayFormData.append("instance_nid", (formData.get("instance_nid") as string) || "");
          railwayFormData.append("task_id", (formData.get("task_id") as string) || "");
          railwayFormData.append("attempts", (formData.get("attempts") as string) || "5");
          railwayFormData.append("max_workers", "3");

          // 可选参数
          const llmApiKey = formData.get("llm_api_key") as string;
          const llmApiUrl = formData.get("llm_api_url") as string;
          const llmModel = formData.get("llm_model") as string;
          const skipLlmFiles = formData.get("skip_llm_files") as string;
          if (llmApiKey) railwayFormData.append("llm_api_key", llmApiKey);
          if (llmApiUrl) railwayFormData.append("llm_api_url", llmApiUrl);
          if (llmModel) railwayFormData.append("llm_model", llmModel);
          if (skipLlmFiles) railwayFormData.append("skip_llm_files", skipLlmFiles);

          const fileGroupsJson = formData.get("file_groups") as string;
          if (fileGroupsJson) railwayFormData.append("file_groups", fileGroupsJson);

          // 转发到Railway API
          const response = await fetch(`${RAILWAY_API_URL}/api/review`, {
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

        const skipLlmFilesJson = (formData.get("skip_llm_files") as string || "").trim();
        if (skipLlmFilesJson) {
          scriptArgs.push("--skip-llm-files", skipLlmFilesJson);
        }

        const fileGroupsJson = (formData.get("file_groups") as string || "").trim();
        if (fileGroupsJson) {
          scriptArgs.push("--file-groups", fileGroupsJson);
        }

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
