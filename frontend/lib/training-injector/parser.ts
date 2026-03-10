/**
 * 训练配置注入器 - Markdown 解析器
 *
 * 从 create_task_from_markdown.py 和 create_score_items_from_rubric.py 翻译为 TypeScript
 */

import { ParsedStep, ParsedScoreItem } from "./types";

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
    const lines = markdown.split("\n");
    const steps: ParsedStep[] = [];

    let currentStep: Partial<ParsedStep> | null = null;
    let inCodeBlock = false;
    let currentCodeBlock: string[] = [];
    let codeBlockType: "prologue" | "llmPrompt" | "transitionPrompt" | null = null;

    for (const line of lines) {
        const stripped = line.trim();

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
            continue;
        }

        if (!currentStep) continue;

        // 字段提取
        if (stripped.startsWith("**虚拟训练官名字**:") || stripped.startsWith("**虚拟训练官名字**：")) {
            currentStep.trainerName = normalizeValue(splitField(stripped));
            continue;
        }
        if (stripped.startsWith("**模型**:") || stripped.startsWith("**模型**：")) {
            currentStep.modelId = normalizeValue(splitField(stripped));
            continue;
        }
        if (stripped.startsWith("**声音**:") || stripped.startsWith("**声音**：")) {
            currentStep.agentId = normalizeValue(splitField(stripped));
            continue;
        }
        if (stripped.startsWith("**形象**:") || stripped.startsWith("**形象**：")) {
            currentStep.avatarNid = normalizeValue(splitField(stripped));
            continue;
        }
        if (stripped.startsWith("**阶段描述**:") || stripped.startsWith("**阶段描述**：")) {
            currentStep.description = normalizeValue(splitField(stripped));
            continue;
        }
        if (stripped.startsWith("**背景图**:") || stripped.startsWith("**背景图**：")) {
            currentStep.backgroundImage = normalizeValue(splitField(stripped));
            continue;
        }
        if (stripped.startsWith("**互动轮次**:") || stripped.startsWith("**互动轮次**：")) {
            const roundsStr = splitField(stripped);
            const match = roundsStr.match(/\d+/);
            if (match) {
                currentStep.interactiveRounds = parseInt(match[0], 10);
            }
            continue;
        }
        if (stripped.startsWith("**flowCondition**:") || stripped.startsWith("**flowCondition**：")) {
            currentStep.flowCondition = normalizeValue(splitField(stripped));
            continue;
        }

        // 代码块开始标记 或 开场白 blockquote
        if (stripped.startsWith("**开场白**:") || stripped.startsWith("**开场白**：")) {
            // 检查是否有行内内容（某些格式直接写在同一行）
            const inline = normalizeValue(splitField(stripped));
            if (inline) {
                currentStep.prologue = inline;
                codeBlockType = null;
            } else {
                codeBlockType = "prologue";
            }
            continue;
        }
        if (stripped.startsWith("**提示词**:") || stripped.startsWith("**提示词**：")) {
            codeBlockType = "llmPrompt";
            continue;
        }
        if (stripped.startsWith("**transitionPrompt**:") || stripped.startsWith("**transitionPrompt**：")) {
            const inline = normalizeValue(splitField(stripped));
            if (inline) {
                currentStep.transitionPrompt = inline;
                codeBlockType = null;
            } else {
                codeBlockType = "transitionPrompt";
            }
            continue;
        }

        // 代码块处理
        if (stripped.startsWith("```")) {
            if (inCodeBlock) {
                // 代码块结束
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
                // 代码块开始
                inCodeBlock = true;
                currentCodeBlock = [];
            }
            continue;
        }

        if (inCodeBlock) {
            currentCodeBlock.push(line);
        } else if (codeBlockType === "prologue" && stripped.startsWith(">")) {
            // 开场白 blockquote 格式：> 内容
            const prologueLine = line.replace(/^\s*>\s?/, "");
            if (!currentStep.prologue) currentStep.prologue = "";
            if (currentStep.prologue) currentStep.prologue += "\n";
            currentStep.prologue += prologueLine;
        } else if (codeBlockType === "prologue" && !stripped.startsWith(">") && currentStep.prologue !== undefined && stripped !== "") {
            // blockquote 结束（遇到非 > 非空行），清除 codeBlockType
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
        const itemName = m[1].trim();
        const score = parseInt(m[2], 10);

        // 该段的文本范围
        const bodyStart = m.index! + m[0].length;
        const bodyEnd = i + 1 < matches.length ? matches[i + 1].index! : markdown.length;
        const body = markdown.slice(bodyStart, bodyEnd);

        // 提取 description 和 requireDetail
        // description = 第一个纯描述段落（不含分数档次）
        // requireDetail = 所有分数档次行（90–100分、80–89分、70–79分 等）
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

        const description = descLines.join("\n").trim();
        const requireDetail = requireLines.join("\n\n").trim();

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
