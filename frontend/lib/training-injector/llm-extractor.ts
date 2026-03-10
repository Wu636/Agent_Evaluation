/**
 * 训练配置注入器 - LLM 智能提取器
 *
 * 使用 LLM 从任意格式的 Markdown 中提取训练剧本和评分标准的结构化数据。
 * 相比正则解析器 (parser.ts)，LLM 提取器能够处理各种格式变体。
 */

import { ParsedStep, ParsedScoreItem } from "./types";
import { MODEL_NAME_MAPPING } from "@/lib/config";

export interface LLMSettings {
    apiKey: string;
    apiUrl: string;
    model: string;
}

/** LLM 提取的训练剧本配置（含基础配置 + 各阶段） */
export interface ExtractedScriptConfig {
    taskConfig: {
        trainTaskName: string;
        description: string;
    };
    steps: ParsedStep[];
}

// ─── 通用 LLM 调用 ──────────────────────────────────────────────────

async function callLLM(
    prompt: string,
    llmSettings: LLMSettings
): Promise<string> {
    const { apiKey, apiUrl, model: rawModel } = llmSettings;
    const model = MODEL_NAME_MAPPING[rawModel] || rawModel;

    const baseUrl = apiUrl.replace(/\/+$/, "");
    const endpoint = baseUrl.includes("/chat/completions")
        ? baseUrl
        : `${baseUrl}/chat/completions`;

    console.log("[llm-extractor] Calling LLM:", { endpoint, model, promptLength: prompt.length });

    let res: Response;
    try {
        res = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages: [
                    {
                        role: "system",
                        content:
                            "你是一个精确的 JSON 数据提取器。你的任务是从 Markdown 文档中提取结构化数据，严格按照要求的 JSON 格式输出。不要输出任何额外的说明文字，只输出纯 JSON。",
                    },
                    { role: "user", content: prompt },
                ],
                temperature: 0,
                max_tokens: 16000,
            }),
        });
    } catch (fetchErr) {
        console.error("[llm-extractor] fetch 网络错误:", fetchErr);
        throw new Error(`LLM API 网络连接失败: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
    }

    if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.error("[llm-extractor] API 返回错误:", res.status, errText);
        throw new Error(`LLM API 调用失败 (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";

    // 清理 markdown 代码块包裹
    return content
        .replace(/^```(?:json)?\s*\n?/i, "")
        .replace(/\n?```\s*$/i, "")
        .trim();
}

// ─── 训练剧本提取 ───────────────────────────────────────────────────

const SCRIPT_EXTRACTION_PROMPT = `请从以下 Markdown 文档中提取训练剧本配置，按照下面的 JSON 格式输出。

**输出 JSON 格式（严格遵循，不要增减字段）：**
{
  "taskConfig": {
    "trainTaskName": "任务名称",
    "description": "任务描述（完整文本，不要截断）"
  },
  "steps": [
    {
      "stepName": "阶段名称",
      "trainerName": "虚拟训练官名字",
      "modelId": "模型（如果为空或未指定则填空字符串）",
      "agentId": "声音ID（如果为空或未指定则填空字符串）",
      "avatarNid": "形象ID（如果为空或未指定则填空字符串）",
      "description": "阶段描述",
      "prologue": "开场白的完整内容文本（见下方详细说明）",
      "llmPrompt": "提示词的完整内容文本（见下方详细说明）",
      "interactiveRounds": 4,
      "backgroundImage": "背景图URL（如果为空则填空字符串）",
      "flowCondition": "flowCondition值",
      "transitionPrompt": "transitionPrompt的完整内容文本"
    }
  ]
}

**关键提取规则（必须严格遵循）：**

1. **prologue（开场白）**：提取的是 "开场白" 标签/标题下面的实际内容文本，而不是"开场白"这三个字本身！
   - 开场白内容可能在引用块（> 开头）中，也可能是普通段落
   - 例如文档中写：
     **开场白**:
     > 嘿，散热设计顾问！我是安控...
     则 prologue 应该是 "嘿，散热设计顾问！我是安控..." 这段完整的内容文本
   - ❌ 错误示例：prologue = "开场白"（这只是标签名，不是内容！）
   - ✅ 正确示例：prologue = "嘿，散热设计顾问！我是安控,大家都叫我..."（这才是实际内容）

2. **llmPrompt（提示词）**：提取 "提示词" 标签下面代码块（\`\`\`markdown ... \`\`\`）中的完整文本内容，保留所有 Markdown 格式，不要截断
   - ❌ 错误：llmPrompt = "提示词"
   - ✅ 正确：llmPrompt = "# Role\\n你是安控,数据中心散热系统监测专员..."（代码块内的完整内容）

3. **transitionPrompt**：提取 "transitionPrompt" 标签下面代码块中的完整文本内容
   - ❌ 错误：transitionPrompt = "transitionPrompt"
   - ✅ 正确：transitionPrompt = "【输入参数】\\n    - 下一阶段原始开场白..."

4. taskConfig 从 "基础配置" 中提取任务名称和任务描述
5. steps 从各个 "阶段" 中提取，按阶段顺序排列
6. interactiveRounds 是整数
7. 如果某个字段在文档中未找到，填空字符串（字符串字段）或 0（数字字段）
8. 输出纯 JSON，不要包含任何其他文字

**文档内容：**
`;

/**
 * 使用 LLM 从 Markdown 中提取训练剧本配置
 */
export async function extractScriptConfig(
    markdown: string,
    llmSettings: LLMSettings
): Promise<ExtractedScriptConfig> {
    const prompt = SCRIPT_EXTRACTION_PROMPT + markdown;
    const jsonStr = await callLLM(prompt, llmSettings);
    const parsed = JSON.parse(jsonStr);

    // 结构校验和归一化
    const result: ExtractedScriptConfig = {
        taskConfig: {
            trainTaskName: parsed.taskConfig?.trainTaskName || "",
            description: parsed.taskConfig?.description || "",
        },
        steps: [],
    };

    if (Array.isArray(parsed.steps)) {
        result.steps = parsed.steps.map((s: Record<string, unknown>) => ({
            stepName: String(s.stepName || ""),
            trainerName: String(s.trainerName || ""),
            modelId: String(s.modelId || ""),
            agentId: String(s.agentId || ""),
            avatarNid: String(s.avatarNid || ""),
            description: String(s.description || ""),
            prologue: String(s.prologue || ""),
            llmPrompt: String(s.llmPrompt || ""),
            interactiveRounds: Number(s.interactiveRounds) || 0,
            backgroundImage: String(s.backgroundImage || ""),
            flowCondition: String(s.flowCondition || ""),
            transitionPrompt: String(s.transitionPrompt || ""),
            scriptStepCover: {},
        }));
    }

    if (result.steps.length === 0) {
        throw new Error("LLM 未能从文档中提取出任何训练阶段");
    }

    return result;
}

// ─── 评分标准提取 ───────────────────────────────────────────────────

const RUBRIC_EXTRACTION_PROMPT = `请从以下 Markdown 文档中提取评分标准配置，按照下面的 JSON 格式输出。

**输出 JSON 格式（严格遵循）：**
[
  {
    "itemName": "评分项名称（不含序号和分数）",
    "score": 40,
    "description": "该评分项的总体概述段落",
    "requireDetail": "各分数档次的详细评分标准"
  }
]

**关键提取规则（必须严格遵循，这非常重要）：**

1. **description 和 requireDetail 必须严格分开！**

2. **description（评价描述）**：只提取每个评分项标题下的第一个概述性段落，通常以"本评分项考查..."开头
   - 例如："本评分项考查学生综合分析机房约束条件、对比风冷与液冷系统性能差异、得出合理选型结论的能力。要求学生能够识别机房的热流密度、空间、噪音等关键约束..."
   - ❌ 不要把分数档次描述放进 description

3. **requireDetail（评价项详细要求）**：提取所有分数档次的描述，完整保留每一个档次
   - 把所有档次（90-100分、80-89分、70-79分、60-69分、60分以下等）的描述合并成一个长字符串
   - 每个档次之间用 \\n\\n 分隔
   - 例如：
     "90–100 分：全面分析机房所有约束条件，系统对比风冷、液冷的散热效率...\\n\\n80–89 分：较全面分析机房主要约束条件...\\n\\n70–79 分：分析机房基本约束条件...\\n\\n60–69 分：初步分析部分约束条件...\\n\\n60 分以下：无法有效分析机房约束条件..."
   - ❌ 不要把概述段落放进 requireDetail
   - ❌ 不要让 requireDetail 为空
   - ✅ requireDetail 必须包含具体的分数档次评判描述

4. **itemName**：提取评分项名称，去掉序号（如"一、""二、"等）和分数标注（如"（40分）"）
   - 例如标题 "## 一、散热系统选型分析（40 分）" → itemName = "散热系统选型分析"

5. score 是该评分项的满分值（整数）
6. 不要包含"评价标准概述"或"评分说明"等总体性说明段落作为评分项，只提取具体的评分项
7. 输出纯 JSON 数组，不要包含任何其他文字

**文档内容：**
`;

/**
 * 使用 LLM 从 Markdown 中提取评分标准
 */
export async function extractRubricConfig(
    markdown: string,
    llmSettings: LLMSettings
): Promise<ParsedScoreItem[]> {
    const prompt = RUBRIC_EXTRACTION_PROMPT + markdown;
    const jsonStr = await callLLM(prompt, llmSettings);
    const parsed = JSON.parse(jsonStr);

    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error("LLM 未能从文档中提取出任何评分项");
    }

    return parsed.map((item: Record<string, unknown>) => ({
        itemName: String(item.itemName || ""),
        score: Number(item.score) || 0,
        description: String(item.description || ""),
        requireDetail: String(item.requireDetail || ""),
    }));
}
