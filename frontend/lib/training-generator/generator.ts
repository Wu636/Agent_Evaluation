/**
 * 训练配置生成器 - 核心逻辑
 */

import { ApiConfig } from "../llm/types";
import { callLLMStream } from "../llm/utils";
import { buildScriptGeneratorPrompt, buildRubricGeneratorPrompt } from "./prompts";

/**
 * 流式生成训练剧本配置
 */
const SCRIPT_SYSTEM_PROMPT = `你是一名专业的实训剧本架构师（Training Script Architect），擅长将非标准化实训任务文档转化为结构清晰、逻辑严密的 Markdown 格式训练剧本配置。
你的输出必须是完整的 Markdown 文档，包含基础配置、训练阶段、提示词、跳转逻辑等。
不要输出 JSON，不要做评分，不要输出与剧本配置无关的内容。`;

export async function* generateTrainingScriptStream(
    teacherDocContent: string,
    config: ApiConfig & { model: string },
    promptTemplate?: string
): AsyncGenerator<string, void, unknown> {
    const prompt = buildScriptGeneratorPrompt(teacherDocContent, promptTemplate);
    yield* callLLMStream(prompt, config, 0.3, SCRIPT_SYSTEM_PROMPT);
}

/**
 * 流式生成评分标准
 */
const RUBRIC_SYSTEM_PROMPT = `你是一个专业的训练评价标准生成器。你的任务是根据实训任务文档，生成层级化的评价标准。
采用“主评分项-子得分点”结构，以 Markdown 格式输出。
不要输出 JSON，不要做对话评分，不要输出与评价标准无关的内容。`;

export async function* generateTrainingRubricStream(
    teacherDocContent: string,
    config: ApiConfig & { model: string },
    promptTemplate?: string
): AsyncGenerator<string, void, unknown> {
    const prompt = buildRubricGeneratorPrompt(teacherDocContent, promptTemplate);
    yield* callLLMStream(prompt, config, 0.2, RUBRIC_SYSTEM_PROMPT);
}
