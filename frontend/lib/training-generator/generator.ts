/**
 * 训练配置生成器 - 核心逻辑
 */

import { ApiConfig } from "../llm/types";
import { callLLM, callLLMStream } from "../llm/utils";
import { buildScriptGeneratorPrompt, buildRubricGeneratorPrompt } from "./prompts";
import {
    ConcreteScriptMode,
    ScriptModulePlan,
    ScriptMode,
    ScriptPlanValidationIssue,
    TrainingScriptPlan,
} from "./types";
import { MODEL_NAME_MAPPING } from "../config";

/**
 * 流式生成训练剧本配置
 */
const SCRIPT_SYSTEM_PROMPT = `你是一名专业的实训剧本架构师（Training Script Architect），擅长将非标准化实训任务文档转化为结构清晰、逻辑严密的 Markdown 格式训练剧本配置。
你的输出必须是完整的 Markdown 文档，包含基础配置、训练阶段、提示词、跳转逻辑等。
不要输出 JSON，不要做评分，不要输出与剧本配置无关的内容。`;

const SCRIPT_MODE_CLASSIFIER_SYSTEM_PROMPT = `你是一个训练剧本模式分类器。你的任务是阅读教师任务文档，并且只输出以下四个标签之一：
- general
- sequential
- roleplay
- summary

分类标准：
- sequential：教师希望智能体主动提问、逐步闯关、按顺序推进、答对才进入下一步、强调引导和禁止跳关
- roleplay：教师希望智能体扮演病人、客户、家属、企业角色等，被动等待学生提问，强调问一答一、信息库、模拟人物
- summary：教师希望该阶段做复盘、评价、总结、答疑、结案，强调先总后分、总体评价、查漏补缺
- general：以上都不明显，或是混合型但没有单一主导模式

输出要求：
1. 只输出一个小写标签
2. 不要输出解释，不要输出标点，不要输出多余文字`;

const SCRIPT_PLAN_SYSTEM_PROMPT = `你是一个训练剧本模块规划器。你的任务是阅读教师任务文档，并输出严格合法的 JSON，用于后续生成训练剧本。

输出要求：
1. 只输出 JSON，不要输出解释
2. JSON 结构必须是：
{
  "taskName": "任务名称",
  "audience": "目标受众",
  "overallObjective": "整体训练目标",
  "recommendedMode": "general|sequential|roleplay|summary",
  "modules": [
    {
      "id": "module_1",
      "title": "模块标题",
      "moduleType": "general|sequential|roleplay|summary",
      "objective": "本模块训练目的",
      "description": "本模块场景与执行说明",
      "keyPoints": ["要点1", "要点2"],
      "interactionStyle": "本模块的互动方式说明",
      "transitionGoal": "本模块结束后要进入什么能力目标",
      "suggestedRounds": 3
    }
  ],
  "notes": ["补充说明1", "补充说明2"]
}

规划原则：
- 按教师文档的实际阶段、步骤、环节和任务要求来规划模块；若教师文档明确列出多个阶段，应优先一一对应，不得擅自合并
- 按教师文档实际阶段来（通常 3-8 个模块），模块数量具体参照教师文档要求区分生成，无具体的范围限定
- 若用户已经手动拆分、补充或保留某些模块，应优先保留这些结构
- 同一训练任务可以混合多种模块类型
- 若前段是知识引导与追问，优先 sequential
- 若需要学生主动获取信息，优先 roleplay
- 若用于最后复盘，优先 summary
- 若无法明确归类，再使用 general
- 模块标题与目标必须具体，不能写占位词
- taskName、overallObjective、每个模块的 title、objective、description 必须填写具体内容，不允许空字符串
- 每个模块的 keyPoints 至少输出 2 条具体要点，不允许空数组
- suggestedRounds 取值 1-6 的整数`;

const SCRIPT_PLAN_REPAIR_SYSTEM_PROMPT = `你是一个训练剧本模块规划结果修复器。你的任务是把已有的规划草稿转换为严格合法的 JSON。

输出要求：
1. 只输出 JSON，不要输出解释
2. JSON 结构必须是：
{
  "taskName": "任务名称",
  "audience": "目标受众",
  "overallObjective": "整体训练目标",
  "recommendedMode": "general|sequential|roleplay|summary",
  "modules": [
    {
      "id": "module_1",
      "title": "模块标题",
      "moduleType": "general|sequential|roleplay|summary",
      "objective": "本模块训练目的",
      "description": "本模块场景与执行说明",
      "keyPoints": ["要点1", "要点2"],
      "interactionStyle": "本模块的互动方式说明",
      "transitionGoal": "本模块结束后要进入什么能力目标",
      "suggestedRounds": 3
    }
  ],
  "notes": ["补充说明1", "补充说明2"]
}
3. 如果原文是 Markdown 提纲、项目列表或半结构化文本，请提取信息后补全为上述 JSON
4. suggestedRounds 必须是 1-6 的整数
5. recommendedMode 和 moduleType 只能是 general|sequential|roleplay|summary
6. 若已有规划体现了更细的阶段拆分，修复时不得擅自合并模块或减少模块数量
7. taskName、overallObjective、模块 title、objective、description、keyPoints 不能为空；若原稿缺失，必须根据上下文补全`;

const SCRIPT_PLAN_AUTOFILL_SYSTEM_PROMPT = `你是一个训练剧本模块规划补全器。你的任务是在保留已有模块结构的前提下，自动补全规划中缺失的关键字段，并输出严格合法的 JSON。

输出要求：
1. 只输出 JSON，不要输出解释
2. 必须保留原有模块数量、模块顺序、模块 id
3. 不得擅自合并、删除、新增模块
4. 必须补全以下字段，且不能留空：
   - taskName
   - overallObjective
   - 每个模块的 title
   - 每个模块的 objective
   - 每个模块的 description
   - 每个模块的 keyPoints（至少 2 条）
5. recommendedMode 和 moduleType 只能是 general|sequential|roleplay|summary
6. suggestedRounds 必须是 1-6 的整数`;

const MODULE_REGEN_SYSTEM_PROMPT = `你是一名专业的训练剧本局部修订器。你的任务是只重写目标阶段，不要输出整篇剧本。

输出要求：
1. 只输出一个完整的阶段 Markdown 区块
2. 必须以 \`### 阶段N: ...\` 开头
3. 必须包含以下字段，顺序保持一致：
   - 虚拟训练官名字
   - 模型
   - 声音
   - 形象
   - 阶段描述
   - 背景图
   - 互动轮次
   - flowCondition
   - transitionPrompt（代码块）
   - 开场白
   - 提示词（markdown 代码块）
4. 不要输出解释，不要输出代码块包裹整个结果
5. 不要重写其他阶段`;

function normalizeChatCompletionEndpoint(baseUrl: string): string {
    const trimmed = baseUrl.replace(/\/+$/, "");
    if (trimmed.includes("/chat/completions")) return trimmed;
    return `${trimmed}/chat/completions`;
}

function buildLlmHeaders(apiKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
        "api-key": apiKey || "",
        "Content-Type": "application/json",
    };

    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }

    return headers;
}

function formatLlmConnectivityError(baseUrl: string, error: unknown): Error {
    const endpoint = normalizeChatCompletionEndpoint(baseUrl);
    const anyError = error as {
        message?: string;
        cause?: { message?: string; code?: string };
    };
    const message = String(anyError?.message || error || "");
    const causeMessage = String(anyError?.cause?.message || "");
    const causeCode = String(anyError?.cause?.code || "");
    const combined = `${message} ${causeMessage} ${causeCode}`.toLowerCase();

    if (
        combined.includes("fetch failed") ||
        combined.includes("timeout") ||
        combined.includes("connecttimeouterror") ||
        combined.includes("und_err_connect_timeout") ||
        combined.includes("econnrefused") ||
        combined.includes("enotfound")
    ) {
        return new Error(
            `当前 LLM API 地址不可达：${endpoint}。请检查设置中的 API URL 是否正确、当前网络是否能访问该地址，必要时改为可直连的 HTTPS 地址。`
        );
    }

    return error instanceof Error ? error : new Error(String(error || "LLM 请求失败"));
}

function extractScriptMode(raw: string): ConcreteScriptMode {
    const cleaned = raw.trim().toLowerCase();
    if (cleaned.includes("roleplay")) return "roleplay";
    if (cleaned.includes("summary")) return "summary";
    if (cleaned.includes("sequential")) return "sequential";
    return "general";
}

export function getScriptModeLabel(mode: ScriptMode): string {
    switch (mode) {
        case "sequential":
            return "循序过关型";
        case "roleplay":
            return "模拟人物型";
        case "summary":
            return "总结复盘型";
        case "auto":
            return "自动识别";
        case "general":
        default:
            return "通用";
    }
}

export async function classifyTrainingScriptMode(
    teacherDocContent: string,
    config: ApiConfig & { model: string }
): Promise<ConcreteScriptMode> {
    const { apiKey, baseUrl, model: rawModel } = config;

    if (!baseUrl) throw new Error("未配置 LLM API 地址");

    const model = MODEL_NAME_MAPPING[rawModel] || rawModel;
    const endpoint = normalizeChatCompletionEndpoint(baseUrl);

    let response: Response;
    try {
        response = await fetch(endpoint, {
            method: "POST",
            headers: buildLlmHeaders(apiKey),
            body: JSON.stringify({
                model,
                temperature: 0,
                maxTokens: 8,
                n: 1,
                presence_penalty: 0.0,
                messages: [
                    { role: "system", content: SCRIPT_MODE_CLASSIFIER_SYSTEM_PROMPT },
                    {
                        role: "user",
                        content: `请判断下方教师文档最适合哪一种训练剧本模式。\n\n<teacher_document>\n${teacherDocContent}\n</teacher_document>`,
                    },
                ],
            }),
        });
    } catch (error) {
        throw formatLlmConnectivityError(baseUrl, error);
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`剧本模式识别失败 (HTTP ${response.status}): ${errorText.substring(0, 200)}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    return extractScriptMode(content);
}

function makeModuleId(index: number): string {
    return `module_${index + 1}`;
}

function normalizePlan(raw: unknown): TrainingScriptPlan {
    const obj = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
    const rawModules = Array.isArray(obj.modules) ? obj.modules as Array<Record<string, unknown>> : [];

    return {
        taskName: String(obj.taskName || ""),
        audience: String(obj.audience || ""),
        overallObjective: String(obj.overallObjective || ""),
        recommendedMode: extractScriptMode(String(obj.recommendedMode || "general")),
        modules: rawModules.map((module, index) => ({
            id: String(module.id || makeModuleId(index)),
            title: String(module.title || ""),
            moduleType: extractScriptMode(String(module.moduleType || "general")),
            objective: String(module.objective || ""),
            description: String(module.description || ""),
            keyPoints: Array.isArray(module.keyPoints) ? module.keyPoints.map((item) => String(item || "")).filter(Boolean) : [],
            interactionStyle: String(module.interactionStyle || ""),
            transitionGoal: String(module.transitionGoal || ""),
            suggestedRounds: Math.max(1, Math.min(6, Number(module.suggestedRounds) || 3)),
        })),
        notes: Array.isArray(obj.notes) ? obj.notes.map((item) => String(item || "")).filter(Boolean) : [],
    };
}

function parseBulletList(raw: string): string[] {
    return raw
        .split(/\n+/)
        .map((line) => line.replace(/^[-*•]\s*/, "").trim())
        .filter(Boolean);
}

function extractField(text: string, patterns: RegExp[]): string {
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) return match[1].trim();
    }
    return "";
}

function fallbackParsePlanFromMarkdown(content: string): TrainingScriptPlan {
    const normalized = content
        .replace(/\r\n/g, "\n")
        .replace(/^```(?:markdown|md|json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

    const taskName = extractField(normalized, [
        /(?:^|\n)(?:#\s*)?任务名称[：:]\s*(.+)/i,
        /(?:^|\n)(?:#\s*)?训练任务[：:]\s*(.+)/i,
    ]);
    const audience = extractField(normalized, [
        /(?:^|\n)目标受众[：:]\s*(.+)/i,
        /(?:^|\n)适用对象[：:]\s*(.+)/i,
    ]);
    const overallObjective = extractField(normalized, [
        /(?:^|\n)整体训练目标[：:]\s*([\s\S]*?)(?=\n(?:推荐主导模式|推荐模式|#|##|###|模块\d+|$))/i,
        /(?:^|\n)训练目标[：:]\s*([\s\S]*?)(?=\n(?:推荐主导模式|推荐模式|#|##|###|模块\d+|$))/i,
    ]);
    const recommendedMode = extractScriptMode(extractField(normalized, [
        /(?:^|\n)推荐主导模式[：:]\s*(.+)/i,
        /(?:^|\n)推荐模式[：:]\s*(.+)/i,
    ]) || "general");

    const moduleBlocks = normalized
        .split(/(?=^#{1,3}\s*模块\s*\d+|^模块\s*\d+[：:])/m)
        .filter((block) => /模块\s*\d+/m.test(block));

    const modules = moduleBlocks.map((block, index) => {
        const title = extractField(block, [
            /(?:^|\n)(?:#{1,3}\s*)?模块\s*\d+[：:]\s*(.+)/i,
            /(?:^|\n)标题[：:]\s*(.+)/i,
            /(?:^|\n)模块标题[：:]\s*(.+)/i,
        ]) || `模块 ${index + 1}`;
        const moduleType = extractScriptMode(extractField(block, [
            /(?:^|\n)类型[：:]\s*(.+)/i,
            /(?:^|\n)模块类型[：:]\s*(.+)/i,
        ]) || "general");
        const objective = extractField(block, [
            /(?:^|\n)训练目的[：:]\s*([\s\S]*?)(?=\n(?:模块说明|说明|关键要点|互动方式|建议轮次|#|##|###|$))/i,
            /(?:^|\n)目标[：:]\s*([\s\S]*?)(?=\n(?:模块说明|说明|关键要点|互动方式|建议轮次|#|##|###|$))/i,
        ]);
        const description = extractField(block, [
            /(?:^|\n)模块说明[：:]\s*([\s\S]*?)(?=\n(?:关键要点|互动方式|建议轮次|跳转目标|#|##|###|$))/i,
            /(?:^|\n)说明[：:]\s*([\s\S]*?)(?=\n(?:关键要点|互动方式|建议轮次|跳转目标|#|##|###|$))/i,
        ]);
        const keyPointsRaw = extractField(block, [
            /(?:^|\n)关键要点[：:]\s*([\s\S]*?)(?=\n(?:互动方式|建议轮次|跳转目标|#|##|###|$))/i,
        ]);
        const interactionStyle = extractField(block, [
            /(?:^|\n)互动方式[：:]\s*(.+)/i,
        ]);
        const transitionGoal = extractField(block, [
            /(?:^|\n)跳转目标[：:]\s*(.+)/i,
        ]);
        const roundsRaw = extractField(block, [
            /(?:^|\n)建议轮次[：:]\s*(\d+)/i,
        ]);

        return {
            id: makeModuleId(index),
            title,
            moduleType,
            objective: objective.trim(),
            description: description.trim(),
            keyPoints: parseBulletList(keyPointsRaw),
            interactionStyle,
            transitionGoal,
            suggestedRounds: Math.max(1, Math.min(6, Number(roundsRaw) || 3)),
        };
    });

    return normalizePlan({
        taskName,
        audience,
        overallObjective,
        recommendedMode,
        modules,
        notes: [],
    });
}

function parseTrainingPlanContent(content: string): TrainingScriptPlan {
    const cleaned = content
        .replace(/^```(?:json|markdown|md)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

    try {
        return normalizePlan(JSON.parse(cleaned));
    } catch {
        const fallback = fallbackParsePlanFromMarkdown(cleaned);
        if (fallback.modules.length > 0) return fallback;
        throw new Error("规划结果格式异常：模型未返回合法 JSON，且 Markdown 兜底解析失败。请重试，或缩短教师文档后再规划。");
    }
}

function normalizeTeacherDocForPlanning(teacherDocContent: string): string {
    return teacherDocContent
        .replace(/\r\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function scorePlanningLine(line: string): number {
    const text = line.trim();
    if (!text) return -10;

    let score = 0;
    if (/^#{1,6}\s/.test(text)) score += 10;
    if (/^(一|二|三|四|五|六|七|八|九|十|[0-9]+)[、.．]/.test(text)) score += 5;
    if (/^[-*•]/.test(text)) score += 3;

    const keywords = [
        "任务", "目标", "目的", "流程", "步骤", "阶段", "环节", "场景", "情境", "角色",
        "身份", "学生", "学员", "教师", "病人", "客户", "问诊", "案例", "评分", "考核",
        "要点", "要求", "互动", "复盘", "总结", "答疑", "训练", "能力", "知识点",
    ];
    score += keywords.reduce((sum, keyword) => sum + (text.includes(keyword) ? 2 : 0), 0);

    if (text.length > 220) score -= 3;
    if (/示例|样例|对话示例|参考答案|逐字稿|完整对话/i.test(text)) score -= 4;

    return score;
}

function compressTeacherDocForPlanning(teacherDocContent: string, maxChars: number = 6500): string {
    const normalized = normalizeTeacherDocForPlanning(teacherDocContent);
    if (normalized.length <= maxChars) return normalized;

    const lines = normalized.split("\n");
    const scored = lines.map((line, index) => ({
        index,
        line,
        score: scorePlanningLine(line),
    }));

    const chosen = new Set<number>();

    // 始终保留开头一段，通常包含任务背景和总体要求
    let initialChars = 0;
    for (let i = 0; i < lines.length && initialChars < 1800; i++) {
        chosen.add(i);
        initialChars += lines[i].length + 1;
    }

    // 按分数补充关键行，并保留上下文
    for (const item of scored.sort((a, b) => b.score - a.score)) {
        if (Array.from(chosen).sort((a, b) => a - b).map((i) => lines[i]).join("\n").length >= maxChars) break;
        if (item.score <= 0) break;
        for (let offset = -1; offset <= 1; offset++) {
            const idx = item.index + offset;
            if (idx >= 0 && idx < lines.length) chosen.add(idx);
        }
    }

    const condensed = Array.from(chosen)
        .sort((a, b) => a - b)
        .map((index) => lines[index])
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    if (condensed.length <= maxChars) return condensed;

    return `${condensed.slice(0, maxChars)}\n\n[文档后续内容已为规划自动压缩省略]`;
}

async function requestTrainingPlan(
    prompt: string,
    endpoint: string,
    apiKey: string | undefined,
    model: string,
    maxTokens: number
): Promise<Response> {
    return fetch(endpoint, {
        method: "POST",
        headers: buildLlmHeaders(apiKey),
        body: JSON.stringify({
            model,
            temperature: 0.1,
            maxTokens,
            n: 1,
            presence_penalty: 0.0,
            messages: [
                { role: "system", content: SCRIPT_PLAN_SYSTEM_PROMPT },
                {
                    role: "user",
                    content: prompt,
                },
            ],
        }),
    });
}

function buildPlanningPrompt(
    teacherDocContent: string,
    options?: {
        planningFeedback?: string;
        usePreviousPlan?: boolean;
        currentPlan?: TrainingScriptPlan;
        previousPlan?: TrainingScriptPlan;
    }
): string {
    const segments = [
        "请根据下方教师文档生成训练剧本模块规划。",
        "",
        "<teacher_document>",
        teacherDocContent,
        "</teacher_document>",
    ];

    if (options?.currentPlan) {
        segments.push(
            "",
            "<current_plan>",
            JSON.stringify(options.currentPlan, null, 2),
            "</current_plan>",
            "",
            "以上是用户当前在页面上手动修改后的模块规划。若用户已经新增、拆分、删除、重命名或调整顺序，请优先尊重这些结构调整。",
            "注意：当前规划中若某些字段为空，只表示用户保留了结构或尚未填写，这些空字段必须由你结合教师文档和用户意见重新补全，不能原样保留为空。"
        );
    }

    if (options?.previousPlan) {
        segments.push(
            "",
            "<previous_plan>",
            JSON.stringify(options.previousPlan, null, 2),
            "</previous_plan>",
            "",
            "以上是上一次系统生成的模块规划快照。只有在未提供 current_plan，或用户明确选择参考上一版系统规划时，才应以这份 previous_plan 作为主要参考。"
        );
    }

    if (typeof options?.usePreviousPlan === "boolean") {
        segments.push(
            options.currentPlan
                ? "本次重新规划时，请以 current_plan 为主要参考，不要无故回退到更粗粒度的模块划分。"
                : options.usePreviousPlan
                    ? "本次重新规划时，请参考 previous_plan 的有效结构，但仍要结合教师文档和用户修改意见重新判断。"
                    : "本次重新规划时，不要受旧规划束缚，应以教师文档和用户修改意见为主重新组织模块。"
        );
    }

    if (options?.planningFeedback?.trim()) {
        segments.push(
            "",
            "<planning_feedback>",
            options.planningFeedback.trim(),
            "</planning_feedback>",
            "",
            "请严格结合上述修改意见重新规划模块。若用户要求不要合并某些阶段、需要新增模块或拆分模块，请直接在模块结构中体现。"
        );
    }

    segments.push(
        "",
        "输出提醒：",
        "1. 模块数量优先参照教师文档中明确的阶段、步骤、环节数量。",
        "2. 不要为了压缩篇幅而合并本应独立的模块。",
        "3. taskName、overallObjective、各模块的 title、objective、description、keyPoints 必须完整且非空。",
        "4. 只输出严格合法的 JSON。"
    );

    return segments.join("\n");
}

async function repairTrainingPlanContent(
    rawContent: string,
    endpoint: string,
    apiKey: string | undefined,
    model: string
): Promise<string> {
    const response = await fetch(endpoint, {
        method: "POST",
        headers: buildLlmHeaders(apiKey),
        body: JSON.stringify({
            model,
            temperature: 0,
            maxTokens: 1400,
            n: 1,
            presence_penalty: 0.0,
            messages: [
                { role: "system", content: SCRIPT_PLAN_REPAIR_SYSTEM_PROMPT },
                {
                    role: "user",
                    content: `请把下面的训练剧本规划草稿修复为严格 JSON。\n\n<plan_draft>\n${rawContent}\n</plan_draft>`,
                },
            ],
        }),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`规划结果修复失败 (HTTP ${response.status}): ${errorText.substring(0, 160)}`);
    }

    const data = await response.json();
    return String(data.choices?.[0]?.message?.content || "").trim();
}

async function autofillIncompleteTrainingPlan(
    teacherDocContent: string,
    plan: TrainingScriptPlan,
    endpoint: string,
    apiKey: string | undefined,
    model: string
): Promise<TrainingScriptPlan> {
    const response = await fetch(endpoint, {
        method: "POST",
        headers: buildLlmHeaders(apiKey),
        body: JSON.stringify({
            model,
            temperature: 0,
            maxTokens: 1800,
            n: 1,
            presence_penalty: 0.0,
            messages: [
                { role: "system", content: SCRIPT_PLAN_AUTOFILL_SYSTEM_PROMPT },
                {
                    role: "user",
                    content: [
                        "请基于教师文档，补全下面规划中缺失的关键字段。",
                        "",
                        "<teacher_document>",
                        teacherDocContent,
                        "</teacher_document>",
                        "",
                        "<incomplete_plan>",
                        JSON.stringify(plan, null, 2),
                        "</incomplete_plan>",
                        "",
                        "补全要求：",
                        "1. 保留原有模块数量、顺序和 id。",
                        "2. 若某些字段已存在且合理，尽量保留。",
                        "3. 若字段为空，必须结合教师文档补全为具体内容。",
                        "4. 每个模块 keyPoints 至少补全 2 条。",
                    ].join("\n"),
                },
            ],
        }),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`规划缺失字段补全失败 (HTTP ${response.status}): ${errorText.substring(0, 160)}`);
    }

    const data = await response.json();
    const content = String(data.choices?.[0]?.message?.content || "")
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

    return parseTrainingPlanContent(content);
}

function collectMissingPlanFields(validation: ScriptPlanValidationIssue[]): string[] {
    const fields = validation
        .map((issue) => issue.field)
        .filter((field): field is string => Boolean(field));

    return Array.from(new Set(fields));
}

function collectMissingPlanFieldDetails(validation: ScriptPlanValidationIssue[]): {
    taskFields: string[];
    moduleFields: Record<string, string[]>;
} {
    const taskFields = Array.from(new Set(
        validation
            .filter((issue) => !issue.moduleId && issue.field)
            .map((issue) => issue.field as string)
    ));

    const moduleFieldMap = new Map<string, Set<string>>();
    validation.forEach((issue) => {
        if (!issue.moduleId || !issue.field) return;
        const existing = moduleFieldMap.get(issue.moduleId) || new Set<string>();
        existing.add(issue.field);
        moduleFieldMap.set(issue.moduleId, existing);
    });

    const moduleFields = Object.fromEntries(
        Array.from(moduleFieldMap.entries()).map(([moduleId, fields]) => [moduleId, Array.from(fields)])
    );

    return { taskFields, moduleFields };
}

export function validateTrainingScriptPlan(plan: TrainingScriptPlan): ScriptPlanValidationIssue[] {
    const issues: ScriptPlanValidationIssue[] = [];

    if (!plan.taskName.trim()) {
        issues.push({ level: "error", message: "规划中未提取到任务名称。", field: "taskName" });
    }

    if (!plan.overallObjective.trim()) {
        issues.push({ level: "error", message: "规划中未提取到整体训练目标。", field: "overallObjective" });
    }

    if (plan.modules.length === 0) {
        issues.push({ level: "error", message: "未生成任何模块，请重新规划。" });
        return issues;
    }

    if (plan.modules.length < 2) {
        issues.push({ level: "warning", message: "模块数偏少，可能导致剧本层次不足。" });
    }

    plan.modules.forEach((module, index) => {
        if (!module.title.trim()) {
            issues.push({ level: "error", message: `模块 ${index + 1} 缺少标题。`, moduleId: module.id, field: "title" });
        }
        if (!module.objective.trim()) {
            issues.push({ level: "error", message: `模块 ${index + 1} 缺少训练目的。`, moduleId: module.id, field: "objective" });
        }
        if (!module.description.trim()) {
            issues.push({ level: "error", message: `模块 ${index + 1} 缺少场景说明。`, moduleId: module.id, field: "description" });
        }
        if (module.keyPoints.length < 2) {
            issues.push({ level: "error", message: `模块 ${index + 1} 的关键要点不足 2 条。`, moduleId: module.id, field: "keyPoints" });
        }
        if (module.suggestedRounds < 1 || module.suggestedRounds > 6) {
            issues.push({ level: "warning", message: `模块 ${index + 1} 的建议轮次超出合理范围。`, moduleId: module.id, field: "suggestedRounds" });
        }
    });

    const summaryModules = plan.modules.filter((module) => module.moduleType === "summary");
    if (summaryModules.length > 0 && plan.modules[plan.modules.length - 1].moduleType !== "summary") {
        issues.push({ level: "warning", message: "存在总结模块但未放在最后，建议检查模块顺序。" });
    }

    return issues;
}

export async function planTrainingScriptModules(
    teacherDocContent: string,
    config: ApiConfig & { model: string },
    options?: {
        planningFeedback?: string;
        usePreviousPlan?: boolean;
        currentPlan?: TrainingScriptPlan;
        previousPlan?: TrainingScriptPlan;
    }
): Promise<{
    plan: TrainingScriptPlan;
    autofillApplied: boolean;
    autofillFields: string[];
    autofillTaskFields: string[];
    autofillModuleFields: Record<string, string[]>;
}> {
    const { apiKey, baseUrl, model: rawModel } = config;

    if (!baseUrl) throw new Error("未配置 LLM API 地址");

    const model = MODEL_NAME_MAPPING[rawModel] || rawModel;
    const endpoint = normalizeChatCompletionEndpoint(baseUrl);
    const normalizedDoc = normalizeTeacherDocForPlanning(teacherDocContent);
    const compressedDoc = compressTeacherDocForPlanning(normalizedDoc);
    const prompt = buildPlanningPrompt(normalizedDoc, options);

    let response: Response;
    try {
        response = await requestTrainingPlan(prompt, endpoint, apiKey, model, 2000);
    } catch (error) {
        throw formatLlmConnectivityError(baseUrl, error);
    }

    if (response.status === 504 && compressedDoc !== normalizedDoc) {
        console.warn("[training-generate/plan] 首次规划超时，改用压缩文档自动重试");
        try {
            const compressedPrompt = buildPlanningPrompt(
                `${compressedDoc}\n\n[系统说明] 上述教师文档已为规划自动压缩，仅保留任务目标、流程、角色和关键考核点。`,
                options
            );
            response = await requestTrainingPlan(
                compressedPrompt,
                endpoint,
                apiKey,
                model,
                1200
            );
        } catch (error) {
            throw formatLlmConnectivityError(baseUrl, error);
        }
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        if (response.status === 504) {
            throw new Error("剧本规划超时（HTTP 504）。系统已自动尝试压缩教师文档后重试，但仍然超时。建议进一步删去冗长案例、逐字稿或长篇示例后再规划。");
        }
        throw new Error(`剧本规划失败 (HTTP ${response.status}): ${errorText.substring(0, 200)}`);
    }

    const data = await response.json();
    const content = String(data.choices?.[0]?.message?.content || "")
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

    let parsedPlan: TrainingScriptPlan;
    try {
        parsedPlan = parseTrainingPlanContent(content);
    } catch (error) {
        console.warn("[training-generate/plan] 首次规划结果格式异常，尝试自动修复输出格式");
        try {
            const repairedContent = await repairTrainingPlanContent(content, endpoint, apiKey, model);
            parsedPlan = parseTrainingPlanContent(repairedContent);
        } catch (repairError) {
            if (error instanceof Error) {
                throw error;
            }
            throw repairError;
        }
    }

    const validation = validateTrainingScriptPlan(parsedPlan);
    const missingFieldErrors = validation.filter((issue) =>
        issue.field === "taskName" ||
        issue.field === "overallObjective" ||
        issue.field === "title" ||
        issue.field === "objective" ||
        issue.field === "description" ||
        issue.field === "keyPoints"
    );

    const autofillFields = collectMissingPlanFields(missingFieldErrors);
    const autofillDetails = collectMissingPlanFieldDetails(missingFieldErrors);
    let autofillApplied = false;

    if (missingFieldErrors.length > 0) {
        console.warn("[training-generate/plan] 检测到关键字段缺失，尝试自动补全:", missingFieldErrors);
        try {
            parsedPlan = await autofillIncompleteTrainingPlan(normalizedDoc, parsedPlan, endpoint, apiKey, model);
            autofillApplied = true;
        } catch (autofillError) {
            console.warn("[training-generate/plan] 自动补全缺失字段失败:", autofillError);
        }
    }

    return {
        plan: parsedPlan,
        autofillApplied,
        autofillFields,
        autofillTaskFields: autofillDetails.taskFields,
        autofillModuleFields: autofillDetails.moduleFields,
    };
}

function stripMarkdownFence(content: string): string {
    let cleaned = content.trim();
    if (cleaned.startsWith("```markdown")) cleaned = cleaned.slice(11).trim();
    else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3).trim();
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3).trim();
    return cleaned;
}

export async function regenerateTrainingScriptModule(
    teacherDocContent: string,
    config: ApiConfig & { model: string },
    modulePlan: TrainingScriptPlan,
    targetModule: ScriptModulePlan,
    targetStageNumber: number,
    feedback: string,
    usePreviousResult: boolean,
    currentStageMarkdown?: string
): Promise<string> {
    const nextFlowCondition = targetStageNumber < modulePlan.modules.length
        ? `NEXT_TO_STAGE${targetStageNumber + 1}`
        : "TASK_COMPLETE";
    const previousModule = modulePlan.modules[targetStageNumber - 2];
    const nextModule = modulePlan.modules[targetStageNumber];
    const teacherDocWithPlan = buildTeacherDocWithPlan(teacherDocContent, modulePlan);

    const prompt = [
        "请重写下方目标阶段。",
        "",
        `目标阶段编号：阶段${targetStageNumber}`,
        `目标模块标题：${targetModule.title}`,
        `目标模块类型：${targetModule.moduleType}`,
        `目标模块训练目的：${targetModule.objective}`,
        `目标模块说明：${targetModule.description}`,
        `目标模块关键要点：${targetModule.keyPoints.join("；") || "无"}`,
        `建议互动轮次：${targetModule.suggestedRounds}`,
        `本阶段应输出的 flowCondition：${nextFlowCondition}`,
        previousModule ? `上一模块参考：${previousModule.title}｜${previousModule.objective}` : "上一模块参考：无",
        nextModule ? `下一模块参考：${nextModule.title}｜${nextModule.objective}` : "下一模块参考：训练结束",
        "",
        "用户修改建议：",
        feedback,
        "",
        usePreviousResult
            ? "请参考下面的当前阶段版本进行修订，保留有效结构，修正不符合用户建议的部分。"
            : "不要参考旧阶段内容，直接根据教师文档、模块规划和用户建议重新生成该阶段。",
        usePreviousResult && currentStageMarkdown
            ? `\n当前阶段版本：\n${currentStageMarkdown}`
            : "",
        "",
        "教师文档与模块规划：",
        teacherDocWithPlan,
        "",
        "请只输出目标阶段 Markdown。",
    ].join("\n");

    const content = await callLLM(prompt, config, 0.2);
    return stripMarkdownFence(content);
}

function formatModulePlanForPrompt(plan?: TrainingScriptPlan): string {
    if (!plan || plan.modules.length === 0) return "";

    const moduleLines = plan.modules.map((module, index) => [
        `### 模块${index + 1}: ${module.title}`,
        `- 类型: ${module.moduleType}`,
        `- 训练目的: ${module.objective}`,
        `- 模块说明: ${module.description}`,
        `- 关键要点: ${module.keyPoints.join("；") || "无"}`,
        `- 互动方式: ${module.interactionStyle || "无"}`,
        `- 跳转目标: ${module.transitionGoal || "无"}`,
        `- 建议轮次: ${module.suggestedRounds}`,
    ].join("\n"));

    return [
        "\n\n<module_plan>",
        `任务名称: ${plan.taskName || "未提取"}`,
        `目标受众: ${plan.audience || "未提取"}`,
        `整体目标: ${plan.overallObjective || "未提取"}`,
        `推荐主模式: ${plan.recommendedMode}`,
        "",
        moduleLines.join("\n\n"),
        plan.notes.length > 0 ? `\n补充说明:\n- ${plan.notes.join("\n- ")}` : "",
        "</module_plan>",
        "",
        "生成要求补充：请严格按照上述模块规划输出阶段结构，阶段数量必须与模块数量一致，不得擅自合并、删除或新增阶段；如果教师文档与规划冲突，以教师文档中的明确要求为准，但不要偏离规划的整体模块划分。",
    ].join("\n");
}

export function buildTeacherDocWithPlan(
    teacherDocContent: string,
    modulePlan?: TrainingScriptPlan
): string {
    return modulePlan ? `${teacherDocContent}${formatModulePlanForPrompt(modulePlan)}` : teacherDocContent;
}

export async function* generateTrainingScriptStream(
    teacherDocContent: string,
    config: ApiConfig & { model: string },
    promptTemplate?: string,
    scriptMode: ScriptMode = "general",
    modulePlan?: TrainingScriptPlan
): AsyncGenerator<string, void, unknown> {
    const prompt = buildScriptGeneratorPrompt(buildTeacherDocWithPlan(teacherDocContent, modulePlan), promptTemplate, scriptMode);
    yield* callLLMStream(prompt, config, 0.3, SCRIPT_SYSTEM_PROMPT);
}

/**
 * 流式生成评分标准
 */
const RUBRIC_SYSTEM_PROMPT = `你是一个专业的训练评价标准生成器。你的任务是根据实训任务文档，生成层级化的评价标准。
采用“主评分项-子得分点”结构，以 Markdown 格式输出。
不要输出 JSON，不要做对话评分，不要输出与评价标准无关的内容。`;

const SCRIPT_CONTINUE_SYSTEM_PROMPT = `你是训练剧本续写助手。你会基于已有的半成品剧本继续向后补全，保持同一风格和结构。
只输出“新增补全部分”，不要重复已有内容，不要解释说明。`;

const RUBRIC_CONTINUE_SYSTEM_PROMPT = `你是评分标准续写助手。你会基于已有的半成品评分标准继续向后补全，保持同一格式。
只输出“新增补全部分”，不要重复已有内容，不要解释说明。`;

export async function* generateTrainingRubricStream(
    teacherDocContent: string,
    config: ApiConfig & { model: string },
    promptTemplate?: string
): AsyncGenerator<string, void, unknown> {
    const prompt = buildRubricGeneratorPrompt(teacherDocContent, promptTemplate);
    yield* callLLMStream(prompt, config, 0.2, RUBRIC_SYSTEM_PROMPT);
}

export async function continueTrainingScript(
    teacherDocContent: string,
    partialContent: string,
    config: ApiConfig & { model: string },
    promptTemplate?: string,
    scriptMode: ScriptMode = "general",
    modulePlan?: TrainingScriptPlan
): Promise<string> {
    const basePrompt = buildScriptGeneratorPrompt(buildTeacherDocWithPlan(teacherDocContent, modulePlan), promptTemplate, scriptMode);
    const prompt = [
        SCRIPT_CONTINUE_SYSTEM_PROMPT,
        "",
        "你需要对一个被中断的训练剧本进行断点续写。",
        "",
        "【原始生成要求】",
        basePrompt,
        "",
        "【已生成内容（不要重复）】",
        partialContent,
        "",
        "请从断点处继续输出后续内容，直到文档完整结束。只输出新增续写部分。",
    ].join("\n");

    const content = await callLLM(prompt, config, 0.2);
    return stripMarkdownFence(content);
}

export async function* continueTrainingScriptStream(
    teacherDocContent: string,
    partialContent: string,
    config: ApiConfig & { model: string },
    promptTemplate?: string,
    scriptMode: ScriptMode = "general",
    modulePlan?: TrainingScriptPlan
): AsyncGenerator<string, void, unknown> {
    const basePrompt = buildScriptGeneratorPrompt(buildTeacherDocWithPlan(teacherDocContent, modulePlan), promptTemplate, scriptMode);
    const prompt = [
        SCRIPT_CONTINUE_SYSTEM_PROMPT,
        "",
        "你需要对一个被中断的训练剧本进行断点续写。",
        "",
        "【原始生成要求】",
        basePrompt,
        "",
        "【已生成内容（不要重复）】",
        partialContent,
        "",
        "请从断点处继续输出后续内容，直到文档完整结束。只输出新增续写部分。",
    ].join("\n");

    yield* callLLMStream(prompt, config, 0.2, SCRIPT_CONTINUE_SYSTEM_PROMPT);
}

export async function continueTrainingRubric(
    teacherDocContent: string,
    partialContent: string,
    config: ApiConfig & { model: string },
    promptTemplate?: string
): Promise<string> {
    const basePrompt = buildRubricGeneratorPrompt(teacherDocContent, promptTemplate);
    const prompt = [
        RUBRIC_CONTINUE_SYSTEM_PROMPT,
        "",
        "你需要对一个被中断的评分标准进行断点续写。",
        "",
        "【原始生成要求】",
        basePrompt,
        "",
        "【已生成内容（不要重复）】",
        partialContent,
        "",
        "请从断点处继续输出后续内容，直到文档完整结束。只输出新增续写部分。",
    ].join("\n");

    const content = await callLLM(prompt, config, 0.2);
    return stripMarkdownFence(content);
}

export async function* continueTrainingRubricStream(
    teacherDocContent: string,
    partialContent: string,
    config: ApiConfig & { model: string },
    promptTemplate?: string
): AsyncGenerator<string, void, unknown> {
    const basePrompt = buildRubricGeneratorPrompt(teacherDocContent, promptTemplate);
    const prompt = [
        RUBRIC_CONTINUE_SYSTEM_PROMPT,
        "",
        "你需要对一个被中断的评分标准进行断点续写。",
        "",
        "【原始生成要求】",
        basePrompt,
        "",
        "【已生成内容（不要重复）】",
        partialContent,
        "",
        "请从断点处继续输出后续内容，直到文档完整结束。只输出新增续写部分。",
    ].join("\n");

    yield* callLLMStream(prompt, config, 0.2, RUBRIC_CONTINUE_SYSTEM_PROMPT);
}
