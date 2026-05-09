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

export interface SerializeTrainingScriptOptions {
    taskConfig?: Partial<ParsedTaskConfig> | null;
    steps: ParsedStep[];
    sourceMarkdown?: string;
}

const TASK_CONFIG_FIELD_LABELS = [
    "任务名称",
    "任务描述",
] as const;

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

const CHINESE_NUMERAL_MAP: Record<string, number> = {
    "零": 0,
    "一": 1,
    "二": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
};

export interface StageHeadingMatch {
    rawNumber: string;
    stageNumber: number | null;
    stepName: string;
    normalizedHeading: string;
}

function escapeRegex(source: string): string {
    return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildScriptFieldStartPattern(label: string): string {
    return `(?:\\*{1,2}\\s*)?${escapeRegex(label)}(?:\\s*\\*{1,2}\\s*[：:]|\\s*[：:]\\s*\\*{1,2}|\\s*[：:])`;
}

function getFieldLineValue(line: string, label: string): string | null {
    const match = line.match(new RegExp(`^(?:#{1,6}\\s*)?(?:[-*+•]>?\\s*)?${buildScriptFieldStartPattern(label)}\\s*(.*)$`, "i"));
    return match ? match[1] : null;
}

function isStandaloneScriptFieldHeading(line: string, label: string): boolean {
    const stripped = String(line || "").trim();
    if (!stripped) return false;

    const pattern = new RegExp(
        `^(?:#{1,6}\\s*)?(?:[-*+•]\\s*)?(?:\\*{1,2}\\s*)?${escapeRegex(label)}(?:\\s*\\*{1,2})?(?:\\s*#{1,6})?\\s*$`,
        "i"
    );
    return pattern.test(stripped);
}

function getTaskConfigFieldLineValue(line: string, label: string): string | null {
    return getFieldLineValue(line, label);
}

function looksLikeBasicConfigFieldLine(line: string): boolean {
    return /^(?:[-*+•]\s*)?(?:\*{1,2}\s*)?[\u4e00-\u9fa5A-Za-z0-9（）()\/\s_-]{1,30}(?:\s*\*{1,2})?\s*[：:]/.test(line);
}

function findBasicConfigBlock(markdown: string): string {
    const lines = normalizeTrainingScriptSource(markdown).split("\n");
    const basicConfigHeadingPattern = /^(?:#+\s*)?(?:📋\s*)?基础配置\b/i;
    const nextSectionPattern = /^(?:#+\s*)?(?:📝\s*)?训练阶段\b/i;
    const genericHeadingPattern = /^##+\s+\S/;

    let startIndex = lines.findIndex((line) => basicConfigHeadingPattern.test(line.trim()));
    if (startIndex < 0) {
        startIndex = 0;
    }

    let endIndex = lines.length;
    for (let index = startIndex + 1; index < lines.length; index++) {
        const trimmed = lines[index].trim();
        if (!trimmed) continue;
        if (nextSectionPattern.test(trimmed) || matchStageHeading(trimmed)) {
            endIndex = index;
            break;
        }
        if (startIndex > 0 && genericHeadingPattern.test(trimmed) && !basicConfigHeadingPattern.test(trimmed)) {
            endIndex = index;
            break;
        }
    }

    return lines.slice(startIndex, endIndex).join("\n").trim();
}

export function isScriptFieldLine(line: string): boolean {
    return SCRIPT_FIELD_LABELS.some(
        (label) =>
            getFieldLineValue(line, label) !== null ||
            isStandaloneScriptFieldHeading(line, label)
    );
}

function normalizeScriptMarkdownForParsing(markdown: string): string {
    const lines = markdown.split("\n");
    const normalizedLines: string[] = [];
    const fieldPattern = new RegExp(
        `(?:^|\\s)(?:${SCRIPT_FIELD_LABELS.map((label) => buildScriptFieldStartPattern(label)).join("|")})`,
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

function parseStageOrdinal(raw: string): number | null {
    const value = String(raw || "").trim();
    if (!value) return null;

    if (/^\d+$/.test(value)) {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : null;
    }

    if (value === "十") return 10;
    if (value.includes("十")) {
        const [tensPart, onesPart] = value.split("十");
        const tens = tensPart ? CHINESE_NUMERAL_MAP[tensPart] : 1;
        const ones = onesPart ? CHINESE_NUMERAL_MAP[onesPart] : 0;
        if (tens === undefined || ones === undefined) return null;
        return tens * 10 + ones;
    }

    const digit = CHINESE_NUMERAL_MAP[value];
    return digit === undefined ? null : digit;
}

function looksLikeTrainingScriptContent(content: string): boolean {
    return (
        /(?:^|\n)\s*(?:#{1,6}\s*)?(?:📋\s*)?基础配置\b/i.test(content) ||
        /(?:^|\n)\s*(?:[-*+•]\s*)?(?:#{2,6}\s*)?(?:第?\s*[0-9一二三四五六七八九十]+\s*阶段|阶段\s*[0-9一二三四五六七八九十]+)/i.test(content)
    );
}

export function normalizeTrainingScriptSource(markdown: string): string {
    let raw = String(markdown || "");
    const initialLines = raw.split("\n");
    const firstContentIndex = initialLines.findIndex((line) => line.trim().length > 0);
    if (firstContentIndex >= 0 && /^```(?:markdown|md)?\s*$/i.test(initialLines[firstContentIndex].trim())) {
        const firstClosingIndex = initialLines.findIndex((line, index) => index > firstContentIndex && line.trim().startsWith("```"));
        if (firstClosingIndex > firstContentIndex) {
            const firstFenceBody = initialLines.slice(firstContentIndex + 1, firstClosingIndex).join("\n");
            const remainingBody = initialLines.slice(firstClosingIndex + 1).join("\n");
            if (looksLikeTrainingScriptContent(firstFenceBody) && /(?:^|\n)\s*(?:[-*+•]\s*)?(?:#{2,6}\s*)?(?:第?\s*[0-9一二三四五六七八九十]+\s*阶段|阶段\s*[0-9一二三四五六七八九十]+)/.test(remainingBody)) {
                initialLines.splice(firstContentIndex, 1);
                raw = initialLines.join("\n");
            }
        }
    }

    const outerFenceMatch = raw.match(/^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
    if (outerFenceMatch?.[1]) {
        return outerFenceMatch[1].trim();
    }

    const unwrappedScriptLikeFences = raw.replace(
        /```(?:markdown|md)?\s*\n([\s\S]*?)\n```/gi,
        (fullMatch, innerContent: string) => {
            if (!looksLikeTrainingScriptContent(innerContent)) {
                return fullMatch;
            }
            return `\n${innerContent.trim()}\n`;
        }
    );

    const fenceMatches = Array.from(
        unwrappedScriptLikeFences.matchAll(/```(?:markdown|md)?\s*\n([\s\S]*?)\n```/gi)
    );

    if (fenceMatches.length === 0) {
        return unwrappedScriptLikeFences.trim();
    }

    const rawLines = unwrappedScriptLikeFences.split("\n");
    let inCodeBlock = false;
    let hasStageOutsideCodeBlock = false;
    for (const line of rawLines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("```")) {
            inCodeBlock = !inCodeBlock;
            continue;
        }
        if (inCodeBlock) continue;
        if (matchStageHeading(trimmed)) {
            hasStageOutsideCodeBlock = true;
            break;
        }
    }

    if (hasStageOutsideCodeBlock) {
        return unwrappedScriptLikeFences.trim();
    }

    const bestFence = fenceMatches
        .map((match) => (match[1] || "").trim())
        .sort((a, b) => b.length - a.length)
        .find((block) =>
            /(?:^|\n)\s*(?:#{2,6}\s*)?(?:第?\s*[0-9一二三四五六七八九十]+\s*阶段|阶段\s*[0-9一二三四五六七八九十]+)/.test(block) ||
            /(?:^|\n)\s*##+\s*(?:📋\s*)?基础配置\b/i.test(block)
        );

    return (bestFence || unwrappedScriptLikeFences).trim();
}

export function matchStageHeading(line: string): StageHeadingMatch | null {
    const stripped = String(line || "").trim();
    if (!stripped) return null;

    const patterns = [
        /^(?:[-*+•]\s*)?#{2,6}\s*阶段\s*([0-9一二三四五六七八九十]+)(?:\s*[：:\-]\s*(.+))?$/i,
        /^(?:[-*+•]\s*)?#{2,6}\s*第\s*([0-9一二三四五六七八九十]+)\s*阶段(?:\s*[：:\-]\s*(.+))?$/i,
        /^(?:[-*+•]\s*)?阶段\s*([0-9一二三四五六七八九十]+)\s*[：:\-]\s*(.+)$/i,
        /^(?:[-*+•]\s*)?第\s*([0-9一二三四五六七八九十]+)\s*阶段\s*[：:\-]\s*(.+)$/i,
    ];

    for (const pattern of patterns) {
        const match = stripped.match(pattern);
        if (!match) continue;

        const rawNumber = String(match[1] || "").trim();
        const stageNumber = parseStageOrdinal(rawNumber);
        const stepName = normalizeValue(String(match[2] || "").trim()) || `阶段${rawNumber}`;

        return {
            rawNumber,
            stageNumber,
            stepName,
            normalizedHeading: `### 阶段${stageNumber ?? rawNumber}: ${stepName}`,
        };
    }

    return null;
}

export function repairTrainingScriptForParsing(markdown: string): string {
    const normalized = normalizeTrainingScriptSource(markdown);
    const lines = normalized.split("\n");
    const repairedLines: string[] = [];
    let inCodeBlock = false;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("```")) {
            inCodeBlock = !inCodeBlock;
            repairedLines.push(line);
            continue;
        }

        if (!inCodeBlock) {
            const stageHeading = matchStageHeading(trimmed);
            if (stageHeading) {
                repairedLines.push(stageHeading.normalizedHeading);
                continue;
            }
        }

        repairedLines.push(line);
    }

    return repairedLines.join("\n").trim();
}

function collectStageBlockRanges(lines: string[]): Array<{ start: number; end: number }> {
    const stageStarts: number[] = [];
    const sectionHeadings: number[] = [];
    let inCodeBlock = false;

    lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("```")) {
            inCodeBlock = !inCodeBlock;
            return;
        }
        if (inCodeBlock) return;

        if (matchStageHeading(trimmed)) {
            stageStarts.push(index);
            return;
        }

        if (/^##+\s+\S/.test(trimmed) && !isScriptFieldLine(trimmed)) {
            sectionHeadings.push(index);
        }
    });

    return stageStarts.map((start, index) => {
        const nextStageStart = stageStarts[index + 1];
        const nextSectionHeading = sectionHeadings.find((headingIndex) => headingIndex > start);
        return {
            start,
            end: nextStageStart ?? nextSectionHeading ?? lines.length,
        };
    });
}

function parseStageBlock(stageMarkdown: string): ParsedStep {
    const lines = normalizeScriptMarkdownForParsing(stageMarkdown).split("\n");
    const currentStep: Partial<ParsedStep> = {};
    let inCodeBlock = false;
    let currentCodeBlock: string[] = [];
    let codeBlockType: "prologue" | "llmPrompt" | "transitionPrompt" | null = null;

    for (const line of lines) {
        const stripped = line.trim();

        const stageHeading = matchStageHeading(stripped);
        if (stageHeading && !currentStep.stepName) {
            currentStep.stepName = stageHeading.stepName;
            continue;
        }

        if (stripped.startsWith("```")) {
            if (inCodeBlock) {
                const content = currentCodeBlock.join("\n").trim();
                if (codeBlockType === "prologue") {
                    currentStep.prologue = content;
                } else if (codeBlockType === "llmPrompt") {
                    currentStep.llmPrompt = content;
                } else if (codeBlockType === "transitionPrompt") {
                    currentStep.transitionPrompt = content;
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
            const match = roundsValue.match(/\d+/);
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
        if (isStandaloneScriptFieldHeading(stripped, "开场白")) {
            codeBlockType = "prologue";
            continue;
        }
        const llmPromptValue = getFieldLineValue(stripped, "提示词");
        if (llmPromptValue !== null) {
            const inline = normalizeValue(llmPromptValue);
            if (inline) {
                currentStep.llmPrompt = inline;
                codeBlockType = null;
            } else {
                codeBlockType = "llmPrompt";
            }
            continue;
        }
        if (isStandaloneScriptFieldHeading(stripped, "提示词")) {
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
        if (isStandaloneScriptFieldHeading(stripped, "transitionPrompt")) {
            codeBlockType = "transitionPrompt";
            continue;
        }

        if (codeBlockType === "prologue" && stripped.startsWith(">")) {
            const prologueLine = line.replace(/^\s*>\s?/, "");
            if (!currentStep.prologue) currentStep.prologue = "";
            if (currentStep.prologue) currentStep.prologue += "\n";
            currentStep.prologue += prologueLine;
            continue;
        }

        if (codeBlockType === "prologue" && stripped && !isScriptFieldLine(stripped) && !matchStageHeading(stripped)) {
            currentStep.prologue = currentStep.prologue
                ? `${currentStep.prologue}\n${stripped}`
                : stripped;
            continue;
        }
        if (codeBlockType === "llmPrompt" && !isScriptFieldLine(stripped) && !matchStageHeading(stripped)) {
            if (stripped || currentStep.llmPrompt) {
                currentStep.llmPrompt = currentStep.llmPrompt
                    ? `${currentStep.llmPrompt}\n${line}`
                    : line;
            }
            continue;
        }
        if (codeBlockType === "transitionPrompt" && !isScriptFieldLine(stripped) && !matchStageHeading(stripped)) {
            if (stripped || currentStep.transitionPrompt) {
                currentStep.transitionPrompt = currentStep.transitionPrompt
                    ? `${currentStep.transitionPrompt}\n${line}`
                    : line;
            }
            continue;
        }

        if (codeBlockType === "prologue" && stripped !== "") {
            codeBlockType = null;
        }
        if ((codeBlockType === "llmPrompt" || codeBlockType === "transitionPrompt") && isScriptFieldLine(stripped)) {
            codeBlockType = null;
        }
    }

    if (inCodeBlock && currentCodeBlock.length > 0) {
        const content = currentCodeBlock.join("\n").trim();
        if (codeBlockType === "prologue") {
            currentStep.prologue = content;
        } else if (codeBlockType === "llmPrompt") {
            currentStep.llmPrompt = content;
        } else if (codeBlockType === "transitionPrompt") {
            currentStep.transitionPrompt = content;
        }
    }

    return makeStep(currentStep);
}

/**
 * 从训练剧本 Markdown 中提取基础配置（任务名称、任务描述）
 * 匹配 ## 📋 基础配置 区块中的字段
 */
export function parseTaskConfig(markdown: string): ParsedTaskConfig | null {
    const block = findBasicConfigBlock(markdown);
    if (!block) return null;
    const blockLines = block.split("\n");
    const startsWithHeading = /^(?:#+\s*)?(?:📋\s*)?基础配置\b/i.test(blockLines[0]?.trim() || "");
    const lines = startsWithHeading ? blockLines.slice(1) : blockLines;
    let trainTaskName = "";
    let description = "";
    let activeField: "trainTaskName" | "description" | null = null;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const nameValue = getTaskConfigFieldLineValue(trimmed, "任务名称");
        if (nameValue !== null) {
            trainTaskName = normalizeValue(nameValue);
            activeField = "trainTaskName";
            continue;
        }

        const descriptionValue = getTaskConfigFieldLineValue(trimmed, "任务描述");
        if (descriptionValue !== null) {
            description = normalizeValue(descriptionValue);
            activeField = "description";
            continue;
        }

        if (activeField === "description" && !looksLikeBasicConfigFieldLine(trimmed)) {
            const continuation = normalizeValue(trimmed.replace(/^(?:[-*+•]\s*)/, ""));
            if (continuation) {
                description = description
                    ? `${description}\n${continuation}`
                    : continuation;
            }
            continue;
        }

        if (TASK_CONFIG_FIELD_LABELS.some((label) => getTaskConfigFieldLineValue(trimmed, label) !== null)) {
            continue;
        }

        activeField = null;
    }

    if (!trainTaskName) {
        const titleMatch = markdown.match(/^#\s+(.+?)(?:\s*-\s*训练剧本配置)?\s*$/m);
        if (titleMatch?.[1]) {
            trainTaskName = normalizeValue(titleMatch[1]);
        }
    }

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
    const normalized = normalizeTrainingScriptSource(markdown);
    const lines = normalized.split("\n");
    const stageRanges = collectStageBlockRanges(lines);

    if (stageRanges.length > 0) {
        return stageRanges
            .map((range) => parseStageBlock(lines.slice(range.start, range.end).join("\n")))
            .filter((step) => Boolean(step.stepName || step.description || step.llmPrompt));
    }

    return [];
}

function formatInlineScriptField(label: string, value: string): string {
    return `**${label}**: ${String(value || "").trim()}`;
}

function formatFencedScriptField(label: string, value: string): string {
    const trimmed = String(value || "").trim();
    if (!trimmed) {
        return `**${label}**:`;
    }
    return `**${label}**:\n\`\`\`markdown\n${trimmed}\n\`\`\``;
}

function formatBlockquoteScriptField(label: string, value: string): string {
    const trimmed = String(value || "").trim();
    if (!trimmed) {
        return `**${label}**:`;
    }
    const body = trimmed
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    return `**${label}**:\n${body}`;
}

export function serializeTrainingStage(step: ParsedStep, stageNumber: number): string {
    const normalizedStepName = normalizeValue(step.stepName || "") || `阶段${stageNumber}`;
    const normalizedRounds = Number.isFinite(step.interactiveRounds) && step.interactiveRounds > 0
        ? String(step.interactiveRounds)
        : "";

    return [
        `### 阶段${stageNumber}: ${normalizedStepName}`,
        formatInlineScriptField("虚拟训练官名字", step.trainerName),
        formatInlineScriptField("模型", step.modelId),
        formatInlineScriptField("声音", step.agentId),
        formatInlineScriptField("形象", step.avatarNid),
        formatInlineScriptField("阶段描述", step.description),
        formatInlineScriptField("背景图", step.backgroundImage),
        formatInlineScriptField("互动轮次", normalizedRounds),
        formatInlineScriptField("flowCondition", step.flowCondition),
        formatFencedScriptField("transitionPrompt", step.transitionPrompt),
        "",
        formatBlockquoteScriptField("开场白", step.prologue),
        "",
        formatFencedScriptField("提示词", step.llmPrompt),
    ].join("\n").trim();
}

function splitScriptDocumentStructure(markdown?: string): {
    prefix: string;
    suffix: string;
} {
    const normalized = normalizeTrainingScriptSource(String(markdown || ""));
    if (!normalized) {
        return { prefix: "", suffix: "" };
    }

    const lines = normalized.split("\n");
    const stageRanges = collectStageBlockRanges(lines);
    if (stageRanges.length === 0) {
        return {
            prefix: normalized.trim(),
            suffix: "",
        };
    }

    const prefix = lines.slice(0, stageRanges[0].start).join("\n").trim();
    const suffix = lines.slice(stageRanges[stageRanges.length - 1].end).join("\n").trim();
    return { prefix, suffix };
}

function upsertTaskConfigPrefix(prefix: string, taskConfig?: Partial<ParsedTaskConfig> | null): string {
    const trainTaskName = normalizeValue(taskConfig?.trainTaskName || "") || "训练任务";
    const description = normalizeValue(taskConfig?.description || "");
    const lines = String(prefix || "").split("\n");

    const titleLine = `# ${trainTaskName} - 训练剧本配置`;
    const titleIndex = lines.findIndex((line) => /^#\s+/.test(line.trim()));
    if (titleIndex >= 0) {
        lines[titleIndex] = titleLine;
    } else {
        lines.unshift(titleLine, "");
    }

    const basicConfigHeadingPattern = /^(?:#+\s*)?(?:📋\s*)?基础配置\b/i;
    const trainingSectionPattern = /^(?:#+\s*)?(?:📝\s*)?训练阶段\b/i;
    let basicStart = lines.findIndex((line) => basicConfigHeadingPattern.test(line.trim()));
    let trainingStart = lines.findIndex((line) => trainingSectionPattern.test(line.trim()));

    if (basicStart < 0) {
        const insertAt = trainingStart >= 0 ? trainingStart : lines.length;
        lines.splice(insertAt, 0, "## 📋 基础配置", `- **任务名称**: ${trainTaskName}`, `- **任务描述**: ${description}`, "");
        basicStart = insertAt;
        trainingStart = lines.findIndex((line) => trainingSectionPattern.test(line.trim()));
    } else {
        if (trainingStart < 0) {
            trainingStart = lines.length;
        }
        const sectionLines = lines.slice(basicStart + 1, trainingStart);
        const preserved: string[] = [];

        for (let index = 0; index < sectionLines.length; index++) {
            const currentLine = sectionLines[index];
            const trimmed = currentLine.trim();

            if (getTaskConfigFieldLineValue(trimmed, "任务名称") !== null) {
                continue;
            }
            if (getTaskConfigFieldLineValue(trimmed, "任务描述") !== null) {
                while (
                    index + 1 < sectionLines.length &&
                    sectionLines[index + 1].trim() &&
                    !looksLikeBasicConfigFieldLine(sectionLines[index + 1].trim()) &&
                    !/^#+\s+/.test(sectionLines[index + 1].trim())
                ) {
                    index += 1;
                }
                continue;
            }
            preserved.push(currentLine);
        }

        const nextSection = [
            `- **任务名称**: ${trainTaskName}`,
            `- **任务描述**: ${description}`,
            ...preserved.filter((line, index, arr) => {
                if (line.trim()) return true;
                const prev = arr[index - 1]?.trim();
                const next = arr[index + 1]?.trim();
                return Boolean(prev && next);
            }),
        ];

        lines.splice(basicStart + 1, trainingStart - basicStart - 1, ...nextSection, "");
    }

    if (!lines.some((line) => trainingSectionPattern.test(line.trim()))) {
        if (lines.length > 0 && lines[lines.length - 1].trim()) {
            lines.push("");
        }
        lines.push("## 📝 训练阶段");
    }

    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function serializeTrainingScriptMarkdown(options: SerializeTrainingScriptOptions): string {
    const steps = Array.isArray(options.steps) ? options.steps : [];
    const { prefix, suffix } = splitScriptDocumentStructure(options.sourceMarkdown);
    const nextPrefix = upsertTaskConfigPrefix(prefix, options.taskConfig);
    const serializedStages = steps
        .map((step, index) => serializeTrainingStage(step, index + 1))
        .filter(Boolean)
        .join("\n\n---\n\n");

    return [nextPrefix, serializedStages, suffix]
        .filter((part) => Boolean(String(part || "").trim()))
        .join("\n\n")
        .trim();
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
