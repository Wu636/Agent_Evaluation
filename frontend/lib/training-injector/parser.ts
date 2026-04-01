/**
 * 训练配置注入器 - Markdown 解析器
 *
 * 从 create_task_from_markdown.py 和 create_score_items_from_rubric.py 翻译为 TypeScript
 */

import { ParsedStep, ParsedScoreItem } from "./types";

// ─── 基础配置提取 ─────────────────────────────────────────────────────

export interface ParsedTaskConfig {
    trainTaskName: string;
    description: string;
}

const SCRIPT_FIELD_LABELS = [
    "虚拟训练官名字",
    "模型",
    "声音",
    "形象",
    "阶段描述",
    "背景图",
    "互动轮次",
    "flowCondition",
    "transitionPrompt",
    "开场白",
    "提示词",
] as const;

function escapeRegex(source: string): string {
    return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getFieldLineValue(line: string, label: string): string | null {
    const match = line.match(new RegExp(`^(?:\\*{2})?${escapeRegex(label)}(?:\\*{2})?\\s*[：:]\\s*(.*)$`, "i"));
    return match ? match[1] : null;
}

function isScriptFieldLine(line: string): boolean {
    return SCRIPT_FIELD_LABELS.some((label) => getFieldLineValue(line, label) !== null);
}

function normalizeScriptMarkdownForParsing(markdown: string): string {
    const lines = markdown.split("\n");
    const normalizedLines: string[] = [];
    const fieldPattern = new RegExp(
        `(?:^|\\s)(?:\\*{2})?(?:${SCRIPT_FIELD_LABELS.map((label) => escapeRegex(label)).join("|")})(?:\\*{2})?\\s*[：:]`,
        "gi"
    );
    let inCodeBlock = false;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("```")) {
            inCodeBlock = !inCodeBlock;
            normalizedLines.push(line);
            continue;
        }

        if (inCodeBlock) {
            normalizedLines.push(line);
            continue;
        }

        const matches = Array.from(line.matchAll(fieldPattern));
        if (matches.length <= 1) {
            normalizedLines.push(line);
            continue;
        }

        for (let index = 0; index < matches.length; index++) {
            const start = matches[index].index ?? 0;
            const end = matches[index + 1]?.index ?? line.length;
            const segment = line.slice(start, end).trim();
            if (segment) {
                normalizedLines.push(segment);
            }
        }
    }

    return normalizedLines.join("\n");
}

/**
 * 从训练剧本 Markdown 中提取基础配置（任务名称、任务描述）
 * 匹配 ## 📋 基础配置 区块中的字段
 */
export function parseTaskConfig(markdown: string): ParsedTaskConfig | null {
    // 匹配基础配置区块：从 ## 📋 基础配置 / ## 基础配置 开始，到下一个 ## 结束
    const configMatch = markdown.match(
        /^##\s*(?:📋\s*)?基础配置[\s\S]*?(?=^##\s|$(?!\n))/m
    );
    if (!configMatch) return null;

    const block = configMatch[0];
    let trainTaskName = "";
    let description = "";

    // 提取 **任务名称**: xxx
    const nameMatch = block.match(/\*{2}任务名称\*{2}\s*[：:]\s*(.+)/)
    if (nameMatch) trainTaskName = nameMatch[1].trim();

    // 提取 **任务描述**: xxx（可能跨行）
    const descMatch = block.match(/\*{2}任务描述\*{2}\s*[：:]\s*(.+)/);
    if (descMatch) description = descMatch[1].trim();

    if (!trainTaskName && !description) return null;
    return { trainTaskName, description };
}

// ─── 工具函数 ────────────────────────────────────────────────────────

/** 清理 Markdown 值中的"选填"标注、引号等 */
export function normalizeValue(raw: string): string {
    let value = raw.trim();
    if (!value) return "";

    // 移除 （选填）、(选填)、（默认为空）等标注
    value = value.replace(/（[^）]*选填[^）]*）/g, "");
    value = value.replace(/\([^)]*选填[^)]*\)/g, "");
    value = value.replace(/（[^）]*默认为空[^）]*）/g, "");
    value = value.replace(/\([^)]*默认为空[^)]*\)/g, "");
    value = value.trim();

    if (!value) return "";

    // 去除引号
    if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
    ) {
        value = value.slice(1, -1).trim();
    }
    if (value.startsWith("\u201c") && value.endsWith("\u201d")) {
        value = value.slice(1, -1).trim();
    }

    return value;
}

// ─── 训练剧本 Markdown 解析 ──────────────────────────────────────────

/**
 * 解析训练剧本配置 Markdown，提取各阶段信息
 *
 * 对应 Python: parse_markdown()
 */
export function parseTrainingScript(markdown: string): ParsedStep[] {
    const lines = normalizeScriptMarkdownForParsing(markdown).split("\n");
    const steps: ParsedStep[] = [];

    let currentStep: Partial<ParsedStep> | null = null;
    let inCodeBlock = false;
    let currentCodeBlock: string[] = [];
    let codeBlockType: "prologue" | "llmPrompt" | "transitionPrompt" | null = null;

    for (const line of lines) {
        const stripped = line.trim();

        if (stripped.startsWith("```")) {
            if (inCodeBlock) {
                const content = currentCodeBlock.join("\n").trim();
                if (codeBlockType === "prologue") {
                    currentStep && (currentStep.prologue = content);
                } else if (codeBlockType === "llmPrompt") {
                    currentStep && (currentStep.llmPrompt = content);
                } else if (codeBlockType === "transitionPrompt") {
                    currentStep && (currentStep.transitionPrompt = content);
                }
                inCodeBlock = false;
                currentCodeBlock = [];
                codeBlockType = null;
            } else {
                inCodeBlock = true;
                currentCodeBlock = [];
            }
            continue;
        }

        if (inCodeBlock) {
            currentCodeBlock.push(line);
            continue;
        }

        // 新阶段开始：### 阶段N: 名称
        if (stripped.startsWith("### 阶段")) {
            if (currentStep) {
                steps.push(makeStep(currentStep));
            }
            currentStep = {};
            if (stripped.includes(":") || stripped.includes("：")) {
                const sep = stripped.includes(":") ? ":" : "：";
                currentStep.stepName = stripped.split(sep).slice(1).join(sep).trim();
            }
            codeBlockType = null;
            continue;
        }

        if (!currentStep) continue;

        // 字段提取
        const trainerName = getFieldLineValue(stripped, "虚拟训练官名字");
        if (trainerName !== null) {
            currentStep.trainerName = normalizeValue(trainerName);
            continue;
        }
        const modelId = getFieldLineValue(stripped, "模型");
        if (modelId !== null) {
            currentStep.modelId = normalizeValue(modelId);
            continue;
        }
        const agentId = getFieldLineValue(stripped, "声音");
        if (agentId !== null) {
            currentStep.agentId = normalizeValue(agentId);
            continue;
        }
        const avatarNid = getFieldLineValue(stripped, "形象");
        if (avatarNid !== null) {
            currentStep.avatarNid = normalizeValue(avatarNid);
            continue;
        }
        const description = getFieldLineValue(stripped, "阶段描述");
        if (description !== null) {
            currentStep.description = normalizeValue(description);
            continue;
        }
        const backgroundImage = getFieldLineValue(stripped, "背景图");
        if (backgroundImage !== null) {
            currentStep.backgroundImage = normalizeValue(backgroundImage);
            continue;
        }
        const roundsValue = getFieldLineValue(stripped, "互动轮次");
        if (roundsValue !== null) {
            const roundsStr = roundsValue;
            const match = roundsStr.match(/\d+/);
            if (match) {
                currentStep.interactiveRounds = parseInt(match[0], 10);
            }
            continue;
        }
        const flowCondition = getFieldLineValue(stripped, "flowCondition");
        if (flowCondition !== null) {
            currentStep.flowCondition = normalizeValue(flowCondition);
            continue;
        }

        // 代码块开始标记 或 开场白 blockquote
        const prologueValue = getFieldLineValue(stripped, "开场白");
        if (prologueValue !== null) {
            const inline = normalizeValue(prologueValue);
            if (inline) {
                currentStep.prologue = inline;
                codeBlockType = null;
            } else {
                codeBlockType = "prologue";
            }
            continue;
        }
        const llmPromptValue = getFieldLineValue(stripped, "提示词");
        if (llmPromptValue !== null) {
            codeBlockType = "llmPrompt";
            continue;
        }
        const transitionPromptValue = getFieldLineValue(stripped, "transitionPrompt");
        if (transitionPromptValue !== null) {
            const inline = normalizeValue(transitionPromptValue);
            if (inline) {
                currentStep.transitionPrompt = inline;
                codeBlockType = null;
            } else {
                codeBlockType = "transitionPrompt";
            }
            continue;
        }

        if (codeBlockType === "prologue" && stripped.startsWith(">")) {
            // 开场白 blockquote 格式：> 内容
            const prologueLine = line.replace(/^\s*>\s?/, "");
            if (!currentStep.prologue) currentStep.prologue = "";
            if (currentStep.prologue) currentStep.prologue += "\n";
            currentStep.prologue += prologueLine;
            continue;
        }

        if (codeBlockType === "prologue" && stripped && !isScriptFieldLine(stripped) && !stripped.startsWith("### ")) {
            currentStep.prologue = currentStep.prologue
                ? `${currentStep.prologue}\n${stripped}`
                : stripped;
            continue;
        }

        if (codeBlockType === "prologue" && stripped !== "") {
            codeBlockType = null;
        }
    }

    // 最后一个阶段
    if (currentStep) {
        steps.push(makeStep(currentStep));
    }

    return steps;
}

// ─── 评分标准 Markdown 解析 ──────────────────────────────────────────

/**
 * 解析评分标准 Markdown，提取评分项列表
 *
 * 对应 Python: parse_rubric_markdown()
 */
export function parseRubricMarkdown(markdown: string): ParsedScoreItem[] {
    // 匹配 ## 名称（N分） 或 ## 名称(N分)
    const sectionPattern = /^##\s+(.+?)\s*[（(](\d+)\s*分[）)]/gm;
    const matches = Array.from(markdown.matchAll(sectionPattern));

    if (matches.length === 0) return [];

    const items: ParsedScoreItem[] = [];

    for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        // 清理中文序号前缀：一、二、三、…
        const rawName = m[1].trim();
        const itemName = rawName.replace(/^[一二三四五六七八九十]+、\s*/, "");
        const score = parseInt(m[2], 10);

        // 该段的文本范围
        const bodyStart = m.index! + m[0].length;
        const bodyEnd = i + 1 < matches.length ? matches[i + 1].index! : markdown.length;
        const body = markdown.slice(bodyStart, bodyEnd);

        // 优先使用显式标记：**评价描述：** 和 **评分区间：**
        const explicitDescMatch = body.match(/\*{2}评价描述[：:]\*{2}\s*([\s\S]*?)(?=\*{2}评分区间[：:]\*{2}|$)/i);
        const explicitReqMatch = body.match(/\*{2}评分区间[：:]\*{2}\s*([\s\S]*?)$/i);

        let description: string;
        let requireDetail: string;

        if (explicitDescMatch && explicitReqMatch) {
            // 新格式：有显式标记
            description = explicitDescMatch[1].trim();
            requireDetail = explicitReqMatch[1].trim();
        } else {
            // 兼容旧格式：按分数档次行分割
            const scoreTierPattern = /^[-*]?\s*\*{0,2}(\d{2,3}[–—-]\d{2,3}\s*分|\d{2,3}\s*分以[下上])[：:：]?\*{0,2}/;
            const descLines: string[] = [];
            const requireLines: string[] = [];
            let inRequire = false;

            for (const line of body.split("\n")) {
                const s = line.trim();
                if (!s || s === "---") continue;
                if (scoreTierPattern.test(s)) {
                    inRequire = true;
                }
                if (inRequire) {
                    requireLines.push(s);
                } else {
                    descLines.push(s);
                }
            }

            description = descLines.join("\n").trim();
            requireDetail = requireLines.join("\n\n").trim();
        }

        items.push({ itemName, score, description, requireDetail });
    }

    return items;
}

// ─── 辅助函数 ────────────────────────────────────────────────────────

/** 从 **字段名**: 值 中提取值部分 */
function splitField(line: string): string {
    const colonIdx = line.indexOf(":");
    const fullWidthColonIdx = line.indexOf("：");

    let idx: number;
    if (colonIdx === -1) idx = fullWidthColonIdx;
    else if (fullWidthColonIdx === -1) idx = colonIdx;
    else idx = Math.min(colonIdx, fullWidthColonIdx);

    if (idx === -1) return "";
    return line.slice(idx + 1);
}

/** 将 Partial<ParsedStep> 转换为完整的 ParsedStep */
function makeStep(partial: Partial<ParsedStep>): ParsedStep {
    return {
        stepName: partial.stepName || "",
        trainerName: partial.trainerName || "",
        modelId: partial.modelId || "",
        agentId: partial.agentId || "",
        avatarNid: partial.avatarNid || "",
        description: partial.description || "",
        prologue: partial.prologue || "",
        llmPrompt: partial.llmPrompt || "",
        interactiveRounds: partial.interactiveRounds || 0,
        backgroundImage: partial.backgroundImage || "",
        flowCondition: partial.flowCondition || "",
        transitionPrompt: partial.transitionPrompt || "",
        scriptStepCover: partial.scriptStepCover || {},
    };
}
