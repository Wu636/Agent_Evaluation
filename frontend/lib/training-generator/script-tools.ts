import { isScriptFieldLine, matchStageHeading, normalizeTrainingScriptSource, parseTaskConfig, parseTrainingScript, parseTrainingScriptFlowConfig } from "@/lib/training-injector/parser";
import { ScriptFlowEdge, TRAINING_FLOW_END_NODE_ID, TrainingScriptPlan } from "./types";
import { detectMultiRoleTextSignal } from "./plan-validation";

export interface ScriptStageSection {
    index: number;
    heading: string;
    markdown: string;
    stepName: string;
}

export interface ScriptStructure {
    prefix: string;
    stages: ScriptStageSection[];
    suffix: string;
}

export interface ScriptDiagnosticIssue {
    level: "error" | "warning";
    message: string;
    stageIndex?: number;
    field?: string;
}

export interface ScriptDiagnosticsResult {
    stageCount: number;
    issues: ScriptDiagnosticIssue[];
    canInject: boolean;
}

export const TRAINING_SCRIPT_COMPLETE_MARKER = "<!-- TRAINING_SCRIPT_COMPLETE -->";

function joinLines(lines: string[]): string {
    return lines.join("\n").trim();
}

function getLastContentLine(markdown: string): string {
    const lines = String(markdown || "")
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

    while (lines.length > 0 && /^```/.test(lines[lines.length - 1])) {
        lines.pop();
    }

    return lines[lines.length - 1] || "";
}

function hasOddFenceCount(markdown: string): boolean {
    const fenceCount = String(markdown || "")
        .split("\n")
        .filter((line) => line.trim().startsWith("```"))
        .length;

    return fenceCount % 2 === 1;
}

export function hasTrainingScriptCompleteMarker(markdown: string): boolean {
    const raw = String(markdown || "");
    const normalized = normalizeTrainingScriptSource(raw);
    return [raw, normalized].some((candidate) => getLastContentLine(candidate) === TRAINING_SCRIPT_COMPLETE_MARKER);
}

export function hasUnclosedTrainingScriptFence(markdown: string): boolean {
    const raw = String(markdown || "");
    const normalized = normalizeTrainingScriptSource(raw);
    return [raw, normalized].some((candidate) => hasOddFenceCount(candidate));
}

export function extractStageNumberFromHeading(heading: string): number | null {
    return matchStageHeading(heading)?.stageNumber ?? null;
}

export function extractScriptStructure(markdown: string): ScriptStructure {
    const lines = normalizeTrainingScriptSource(markdown).split("\n");
    const stageStarts: number[] = [];
    const topLevelHeadings: number[] = [];
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
        } else if (/^##+\s+/.test(trimmed) && !isScriptFieldLine(trimmed)) {
            topLevelHeadings.push(index);
        }
    });

    if (stageStarts.length === 0) {
        return {
            prefix: markdown.trim(),
            stages: [],
            suffix: "",
        };
    }

    const stages: ScriptStageSection[] = [];
    const stageEnds: number[] = [];
    const firstStageStart = stageStarts[0];
    const prefix = joinLines(lines.slice(0, firstStageStart));

    stageStarts.forEach((start, index) => {
        const nextStageStart = stageStarts[index + 1];
        const nextTopLevel = topLevelHeadings.find((headingIndex) => headingIndex > start);
        const end = nextStageStart ?? nextTopLevel ?? lines.length;
        const stageLines = lines.slice(start, end);
        const heading = stageLines[0]?.trim() || `### 阶段${index + 1}`;
        const stepName = matchStageHeading(heading)?.stepName || heading.split(/[:：]/).slice(1).join(":").trim() || `阶段${index + 1}`;
        stageEnds.push(end);
        stages.push({
            index,
            heading,
            markdown: joinLines(stageLines),
            stepName,
        });
    });

    const suffixStart = stageEnds[stageEnds.length - 1] ?? lines.length;
    const suffix = joinLines(lines.slice(suffixStart));

    return { prefix, stages, suffix };
}

export function replaceStageInScript(markdown: string, stageIndex: number, nextStageMarkdown: string): string {
    const structure = extractScriptStructure(markdown);
    if (!structure.stages[stageIndex]) return markdown;
    const hadCompletionMarker = hasTrainingScriptCompleteMarker(markdown);

    const updatedStages = structure.stages.map((stage, index) => (
        index === stageIndex ? nextStageMarkdown.trim() : stage.markdown.trim()
    ));

    const updatedMarkdown = [structure.prefix, updatedStages.join("\n\n"), structure.suffix]
        .filter(Boolean)
        .join("\n\n")
        .trim();

    if (hadCompletionMarker && !hasTrainingScriptCompleteMarker(updatedMarkdown)) {
        return `${updatedMarkdown}\n\n${TRAINING_SCRIPT_COMPLETE_MARKER}`;
    }

    return updatedMarkdown;
}

function normalizeEndNodeId(value: string): boolean {
    const normalized = String(value || "").trim().toLowerCase();
    return normalized === TRAINING_FLOW_END_NODE_ID.toLowerCase() ||
        normalized === "end" ||
        normalized === "task_complete" ||
        normalized === "结束" ||
        normalized === "训练结束";
}

function resolveEdgeStageLabel(
    moduleId: string,
    plan: TrainingScriptPlan,
    fallback: "from" | "to"
): string {
    if (normalizeEndNodeId(moduleId)) return "END";
    const index = plan.modules.findIndex((module) => module.id === moduleId);
    if (index >= 0) return `阶段${index + 1}`;
    return fallback === "to" ? "END" : "阶段1";
}

function buildSerializableGraphEdges(plan: TrainingScriptPlan): Array<{
    from: string;
    to: string;
    condition: string;
    conditionDescription: string;
    transitionPrompt: string;
    isDefault: number;
}> {
    const moduleIds = new Set(plan.modules.map((module) => module.id));
    const defaultAssignedBySource = new Set<string>();
    return (plan.edges || [])
        .filter((edge: ScriptFlowEdge) =>
            moduleIds.has(edge.fromModuleId) &&
            (moduleIds.has(edge.toModuleId) || normalizeEndNodeId(edge.toModuleId)) &&
            edge.fromModuleId !== edge.toModuleId &&
            edge.condition.trim()
        )
        .map((edge) => {
            const from = resolveEdgeStageLabel(edge.fromModuleId, plan, "from");
            const isDefault = defaultAssignedBySource.has(from) ? 0 : 1;
            if (isDefault === 1) {
                defaultAssignedBySource.add(from);
            }
            return {
                from,
                to: resolveEdgeStageLabel(edge.toModuleId, plan, "to"),
                condition: edge.condition.trim(),
                conditionDescription: edge.conditionDescription || "",
                transitionPrompt: edge.transitionPrompt || "",
                isDefault,
            };
        });
}

function stripNonlinearFlowConfigBlocks(markdown: string): string {
    const lines = String(markdown || "").split("\n");
    const headingPattern = /^#{1,6}\s*(?:🔀\s*)?(?:非线性|分支|图结构|流程图|多线路)[\s\S]{0,32}(?:跳转|流程|连线|关系)(?:\s|$|[（(])/i;
    const genericSectionPattern = /^#{1,6}\s+\S/;
    const keptLines: string[] = [];
    let inCodeBlock = false;
    let skippingFlowBlock = false;
    let skippingCodeBlock = false;

    for (const line of lines) {
        const trimmed = line.trim();

        if (skippingFlowBlock) {
            if (trimmed.startsWith("```")) {
                skippingCodeBlock = !skippingCodeBlock;
                continue;
            }

            if (!skippingCodeBlock && trimmed === TRAINING_SCRIPT_COMPLETE_MARKER) {
                skippingFlowBlock = false;
                keptLines.push(line);
                continue;
            }

            if (!skippingCodeBlock && genericSectionPattern.test(trimmed)) {
                skippingFlowBlock = false;
                if (headingPattern.test(trimmed)) {
                    skippingFlowBlock = true;
                    skippingCodeBlock = false;
                    continue;
                }
                keptLines.push(line);
            }
            continue;
        }

        if (trimmed.startsWith("```")) {
            inCodeBlock = !inCodeBlock;
            keptLines.push(line);
            continue;
        }

        if (!inCodeBlock && headingPattern.test(trimmed)) {
            skippingFlowBlock = true;
            skippingCodeBlock = false;
            continue;
        }

        keptLines.push(line);
    }

    return keptLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function buildNonlinearFlowConfigMarkdown(plan?: TrainingScriptPlan | null): string {
    if (!plan || plan.flowType !== "graph") return "";
    const edges = buildSerializableGraphEdges(plan);
    if (edges.length === 0) return "";

    return [
        "## 🔀 非线性跳转关系",
        "```json",
        JSON.stringify({ flowType: "graph", edges }, null, 2),
        "```",
    ].join("\n");
}

export function ensureNonlinearFlowConfigMarkdown(
    markdown: string,
    plan?: TrainingScriptPlan | null
): string {
    if (!plan || plan.flowType !== "graph") return markdown;
    const flowBlock = buildNonlinearFlowConfigMarkdown(plan);
    if (!flowBlock) return markdown;

    const raw = stripNonlinearFlowConfigBlocks(markdown);
    if (!raw) return raw;

    const markerPattern = new RegExp(`\\n*${TRAINING_SCRIPT_COMPLETE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
    if (markerPattern.test(raw)) {
        return raw.replace(markerPattern, `\n\n${flowBlock}\n\n${TRAINING_SCRIPT_COMPLETE_MARKER}`);
    }

    return `${raw}\n\n${flowBlock}`;
}

export function diagnoseTrainingScript(markdown: string, modulePlan?: TrainingScriptPlan | null): ScriptDiagnosticsResult {
    const issues: ScriptDiagnosticIssue[] = [];
    const taskConfig = parseTaskConfig(markdown);
    const parsedSteps = parseTrainingScript(markdown);
    const flowConfig = parseTrainingScriptFlowConfig(markdown);
    const structure = extractScriptStructure(markdown);

    if (hasUnclosedTrainingScriptFence(markdown)) {
        issues.push({
            level: "error",
            message: "检测到未闭合的 Markdown 代码块，剧本很可能在某个提示词或衔接语中被截断。",
            field: "markdownFence",
        });
    }
    if (!hasTrainingScriptCompleteMarker(markdown)) {
        issues.push({
            level: "error",
            message: `缺少完整结束标志 ${TRAINING_SCRIPT_COMPLETE_MARKER}，疑似生成未到文档末尾。`,
            field: "completionMarker",
        });
    }

    if (!taskConfig?.trainTaskName) {
        issues.push({ level: "warning", message: "基础配置中未解析到任务名称。", field: "taskName" });
    }
    if (!taskConfig?.description) {
        issues.push({ level: "warning", message: "基础配置中未解析到任务描述。", field: "description" });
    }
    if (parsedSteps.length === 0) {
        issues.push({ level: "error", message: "未解析到任何训练阶段，当前剧本无法注入。" });
        return { stageCount: 0, issues, canInject: false };
    }

    let previousStageNumber: number | null = null;
    structure.stages.forEach((stage, index) => {
        const stageNumber = extractStageNumberFromHeading(stage.heading);
        if (stageNumber === null) {
            issues.push({
                level: "error",
                message: `阶段 ${index + 1} 的标题不是标准格式，需使用“### 阶段N: 名称”。`,
                stageIndex: index,
                field: "stepName",
            });
            return;
        }
        if (previousStageNumber !== null && stageNumber <= previousStageNumber) {
            issues.push({
                level: "error",
                message: `阶段编号出现重复或回卷：阶段${previousStageNumber} 后出现阶段${stageNumber}。`,
                stageIndex: index,
                field: "stepName",
            });
        }
        previousStageNumber = stageNumber;
    });

    parsedSteps.forEach((step, index) => {
        if (!step.stepName.trim()) {
            issues.push({ level: "error", message: `阶段 ${index + 1} 缺少阶段标题。`, stageIndex: index, field: "stepName" });
        }
        if (!step.description.trim()) {
            issues.push({ level: "warning", message: `阶段 ${index + 1} 缺少阶段描述。`, stageIndex: index, field: "description" });
        }
        if (!step.prologue.trim()) {
            issues.push({ level: "warning", message: `阶段 ${index + 1} 缺少开场白。`, stageIndex: index, field: "prologue" });
        }
        if (!step.llmPrompt.trim()) {
            issues.push({ level: "error", message: `阶段 ${index + 1} 缺少提示词。`, stageIndex: index, field: "llmPrompt" });
        }
        const multiRoleSignal = detectMultiRoleTextSignal([step.stepName, step.description, step.llmPrompt].join("\n"));
        if (multiRoleSignal) {
            issues.push({
                level: "warning",
                message: `阶段 ${index + 1} 看起来包含多角色信号（${multiRoleSignal.label}）。同一阶段只允许一个智能体角色，如需不同角色建议拆成不同阶段。`,
                stageIndex: index,
                field: "llmPrompt",
            });
        }
        if (!step.flowCondition.trim()) {
            issues.push({ level: "error", message: `阶段 ${index + 1} 缺少 flowCondition。`, stageIndex: index, field: "flowCondition" });
        }
        if (!step.transitionPrompt.trim() && index < parsedSteps.length - 1) {
            issues.push({ level: "warning", message: `阶段 ${index + 1} 缺少 transitionPrompt。`, stageIndex: index, field: "transitionPrompt" });
        }
        if (!step.interactiveRounds || step.interactiveRounds < 1 || step.interactiveRounds > 10) {
            issues.push({ level: "warning", message: `阶段 ${index + 1} 的互动轮次不合理（建议 1-10 轮）。`, stageIndex: index, field: "interactiveRounds" });
        }
    });

    if (modulePlan?.flowType === "graph" && flowConfig.flowType !== "graph") {
        issues.push({
            level: "error",
            message: "模块规划为非线性图结构，但当前剧本缺少 `## 🔀 非线性跳转关系` 区块，注入后会退化为线性流程。",
            field: "flowConfig",
        });
    }

    if (flowConfig.flowType === "graph") {
        const normalizeEndpoint = (value: string): string => String(value || "")
            .trim()
            .replace(/^第\s*([0-9一二三四五六七八九十]+)\s*阶段/u, "阶段$1")
            .replace(/^stage[_\s-]*(\d+)$/i, "阶段$1")
            .replace(/^step[_\s-]*(\d+)$/i, "阶段$1")
            .replace(/\s+/g, "")
            .toLowerCase();
        const stageKeys = new Map<string, number>();
        parsedSteps.forEach((step, index) => {
            const stageNumber = index + 1;
            [
                `阶段${stageNumber}`,
                `第${stageNumber}阶段`,
                step.stepName,
                step.stepName.replace(/^阶段\s*[0-9一二三四五六七八九十]+[：:、.\-\s]*/u, ""),
            ].forEach((key) => {
                const normalized = normalizeEndpoint(key);
                if (normalized) stageKeys.set(normalized, index);
            });
        });
        const endKeys = new Set(["end", "结束", "训练结束", "task_complete", TRAINING_FLOW_END_NODE_ID.toLowerCase()]);
        const outgoingConditions = new Map<string, Set<string>>();
        const defaultCountBySource = new Map<string, number>();
        let hasEndEdge = false;

        if (flowConfig.edges.length === 0) {
            issues.push({ level: "error", message: "非线性跳转关系区块中没有解析到任何 edges。", field: "flowConfig" });
        }

        flowConfig.edges.forEach((edge, index) => {
            const fromKey = normalizeEndpoint(edge.from);
            const toKey = normalizeEndpoint(edge.to);
            if (!stageKeys.has(fromKey) && fromKey !== "start" && fromKey !== "开始") {
                issues.push({ level: "error", message: `非线性连线 ${index + 1} 的起点无法匹配到阶段：${edge.from}`, field: "flowConfig" });
            }
            if (!stageKeys.has(toKey) && !endKeys.has(toKey)) {
                issues.push({ level: "error", message: `非线性连线 ${index + 1} 的终点无法匹配到阶段或 END：${edge.to}`, field: "flowConfig" });
            }
            if (endKeys.has(toKey)) {
                hasEndEdge = true;
            }
            const condition = edge.condition.trim();
            if (!condition) {
                issues.push({ level: "error", message: `非线性连线 ${index + 1} 缺少 condition。`, field: "flowConfig" });
                return;
            }
            const existing = outgoingConditions.get(fromKey) || new Set<string>();
            if (existing.has(condition)) {
                issues.push({ level: "error", message: `非线性连线存在重复跳转关键词：${condition}`, field: "flowConfig" });
            }
            existing.add(condition);
            outgoingConditions.set(fromKey, existing);

            if (edge.isDefault === 1) {
                const defaultCount = (defaultCountBySource.get(fromKey) || 0) + 1;
                defaultCountBySource.set(fromKey, defaultCount);
                if (defaultCount > 1) {
                    issues.push({ level: "error", message: `非线性连线起点「${edge.from}」存在多条 isDefault=1 的默认出口。`, field: "flowConfig" });
                }
            }
        });

        if (!hasEndEdge) {
            issues.push({ level: "warning", message: "非线性跳转关系未显式连接到 END，注入时会为无后继阶段自动补结束线。", field: "flowConfig" });
        }
    }

    if (modulePlan && modulePlan.modules.length !== parsedSteps.length) {
        issues.push({
            level: "warning",
            message: `模块规划共 ${modulePlan.modules.length} 个模块，但当前剧本解析出 ${parsedSteps.length} 个阶段。`,
            field: "stageCount",
        });
    }

    const summaryIndices = parsedSteps
        .map((step, index) => ({ step, index }))
        .filter(({ step }) => /总结|复盘|答疑|结案/.test(`${step.stepName} ${step.description} ${step.llmPrompt}`))
        .map(({ index }) => index);
    if (summaryIndices.some((index) => index !== parsedSteps.length - 1)) {
        issues.push({ level: "warning", message: "检测到总结/复盘型阶段未放在最后，建议检查阶段顺序。" });
    }

    return {
        stageCount: parsedSteps.length,
        issues,
        canInject: !issues.some((issue) => issue.level === "error"),
    };
}
