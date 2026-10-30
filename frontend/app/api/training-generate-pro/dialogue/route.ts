import { NextRequest, NextResponse } from "next/server";
import { MODEL_NAME_MAPPING } from "@/lib/config";
import { callLLM } from "@/lib/llm/utils";
import { jsonrepair } from "jsonrepair";
import type { ApiConfig } from "@/lib/llm/types";
import { parseProMarkdown } from "@/lib/training-injector-pro/parser";
import { buildPresetDialoguePrompt, normalizePresetMessages, getConfigFingerprint } from "@/lib/training-generator-pro/dialogue";

export const runtime = "nodejs";
export const maxDuration = 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function callLlmWithRetry(prompt: string, apiConfig: ApiConfig & { model: string }, temperature: number, systemPrompt: string, stageName: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await callLLM(prompt, apiConfig, temperature, systemPrompt);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /HTTP (?:429|502|503|504)|请求超时|网络错误|fetch failed|temporarily unavailable/i.test(message);
      if (!retryable || attempt === 3) {
        throw new Error(`阶段「${stageName}」调用模型失败${retryable ? `（已重试 ${attempt - 1} 次）` : ""}：${message}`);
      }
      await sleep(attempt * 1200);
    }
  }
  throw lastError;
}

function extractJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    return JSON.parse(candidate);
  } catch {
    return JSON.parse(jsonrepair(candidate));
  }
}

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();
  try {
    const body = await request.json();
    const markdown = String(body.markdown || "");
    const config = parseProMarkdown(markdown);
    if (!config.stages.length) return NextResponse.json({ error: "剧本中没有可生成的阶段" }, { status: 400 });
    if (!config.members.length) return NextResponse.json({ error: "剧本中没有配置全局成员" }, { status: 400 });
    const stageIndexes = Array.isArray(body.stageIndexes) ? body.stageIndexes.map(Number) : config.stages.map((_, i) => i);
    if (!stageIndexes.length || stageIndexes.some((i: number) => !Number.isInteger(i) || i < 0 || i >= config.stages.length)) {
      return NextResponse.json({ error: "所选阶段无效" }, { status: 400 });
    }
    const performance = ["excellent", "competent", "needs_improvement"].includes(body.performance) ? body.performance : "competent";
    const requestedRounds = Number(body.targetRounds);
    const targetRounds = Number.isFinite(requestedRounds) && requestedRounds > 0
      ? Math.max(2, Math.min(12, requestedRounds))
      : null;
    const apiConfig: ApiConfig & { model: string } = {
      apiKey: String(body.apiKey || process.env.LLM_API_KEY || ""),
      baseUrl: String(body.apiUrl || process.env.LLM_BASE_URL || "https://llm-service.polymas.com/api/openai/v1/chat/completions"),
      model: MODEL_NAME_MAPPING[String(body.model || "")] || String(body.model || process.env.LLM_MODEL || "gpt-4o"),
    };
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        const stages = [];
        let previousSummary = "";
        try {
        send({ type: "start", total: stageIndexes.length });
        for (let position = 0; position < stageIndexes.length; position++) {
      const stageIndex = stageIndexes[position];
      const stage = config.stages[stageIndex];
      send({ type: "progress", stageName: stage.cardName, current: position + 1, total: stageIndexes.length, message: `正在生成阶段「${stage.cardName}」（${position + 1}/${stageIndexes.length}）` });
      const prompt = buildPresetDialoguePrompt({
        config, stageIndex, performance, targetRounds,
        extraRequirements: String(body.extraRequirements || ""), previousSummary,
      });
      let messages;
      let lastStageError: unknown;
      for (let generationAttempt = 1; generationAttempt <= 3; generationAttempt++) {
        try {
          const repairInstruction = generationAttempt === 1
            ? ""
            : `\n\n此前本阶段输出未通过 JSON/角色校验（${lastStageError instanceof Error ? lastStageError.message : "格式错误"}）。请缩短每条发言、减少对话轮数但覆盖关键通关条件，重新生成完整合法 JSON。不得截断，第一条 role 必须为 assistant。`;
          const response = await callLlmWithRetry(`${prompt}${repairInstruction}`, apiConfig, generationAttempt === 1 ? 0.65 : 0.2, "你是能力训练对话编写助手。只输出完整、合法的 JSON，不要输出 Markdown 或解释。", stage.cardName);
          messages = normalizePresetMessages(extractJson(response), [...config.members.map((m) => m.memberName), stage.userRoleName]);
          break;
        } catch (error) {
          lastStageError = error;
          if (generationAttempt === 3) {
            throw new Error(`阶段「${stage.cardName}」连续生成 3 次仍未通过校验：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      if (!messages) throw new Error(`阶段「${stage.cardName}」没有生成有效对话`);
      stages.push({ stageName: stage.cardName, messages });
      send({ type: "stage_complete", stage: stages[stages.length - 1], configFingerprint: getConfigFingerprint(markdown), generatedAt: new Date().toISOString() });
      const tail = messages.slice(-4).map((m) => `${m.speaker}：${m.content}`).join("\n");
      previousSummary = `${stage.cardName}已完成。近期对话：\n${tail}`;
    }
        send({ type: "complete", stages, configFingerprint: getConfigFingerprint(markdown), generatedAt: new Date().toISOString() });
        } catch (error) {
          send({ type: "error", error: error instanceof Error ? error.message : "预设对话生成失败", partialStages: stages, configFingerprint: getConfigFingerprint(markdown), generatedAt: new Date().toISOString() });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "预设对话生成失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
