import { parseTaskConfig, parseTrainingScript } from "@/lib/training-injector/parser";
import { TrainingScriptPlan } from "./types";

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

function joinLines(lines: string[]): string {
    return lines.join("\n").trim();
}

export function extractStageNumberFromHeading(heading: string): number | null {
    const match = heading.trim().match(/^#{3,}\s*阶段\s*(\d+)(?:\b|[：:])/i);
    if (!match) return null;
    const value = Number.parseInt(match[1], 10);
    return Number.isFinite(value) ? value : null;
}

export function extractScriptStructure(markdown: string): ScriptStructure {
    const lines = markdown.split("\n");
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
        if (/^#{3,}\s*阶段/.test(trimmed)) {
            stageStarts.push(index);
        } else if (/^##+\s+/.test(trimmed)) {
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
        const stepName = heading.split(/[:：]/).slice(1).join(":").trim() || `阶段${index + 1}`;
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

    const updatedStages = structure.stages.map((stage, index) => (
        index === stageIndex ? nextStageMarkdown.trim() : stage.markdown.trim()
    ));

    return [structure.prefix, updatedStages.join("\n\n"), structure.suffix]
        .filter(Boolean)
        .join("\n\n")
        .trim();
}

export function diagnoseTrainingScript(markdown: string, modulePlan?: TrainingScriptPlan | null): ScriptDiagnosticsResult {
    const issues: ScriptDiagnosticIssue[] = [];
    const taskConfig = parseTaskConfig(markdown);
    const parsedSteps = parseTrainingScript(markdown);
    const structure = extractScriptStructure(markdown);

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
        if (!step.flowCondition.trim()) {
            issues.push({ level: "error", message: `阶段 ${index + 1} 缺少 flowCondition。`, stageIndex: index, field: "flowCondition" });
        }
        if (!step.transitionPrompt.trim() && index < parsedSteps.length - 1) {
            issues.push({ level: "warning", message: `阶段 ${index + 1} 缺少 transitionPrompt。`, stageIndex: index, field: "transitionPrompt" });
        }
        if (!step.interactiveRounds || step.interactiveRounds < 1 || step.interactiveRounds > 10) {
            issues.push({ level: "warning", message: `阶段 ${index + 1} 的互动轮次不合理（建议 1-10 轮）。`, stageIndex: index, field: "interactiveRounds" });
        }
        if (index < parsedSteps.length - 1 && !/^NEXT_TO_STAGE\d+$/i.test(step.flowCondition.trim())) {
            issues.push({ level: "warning", message: `阶段 ${index + 1} 的 flowCondition 不是标准阶段跳转格式。`, stageIndex: index, field: "flowCondition" });
        }
        if (index === parsedSteps.length - 1 && !/TASK_COMPLETE|END|本次实训到此结束/i.test(step.flowCondition.trim())) {
            issues.push({ level: "warning", message: "最后阶段的 flowCondition 看起来不像结束态。", stageIndex: index, field: "flowCondition" });
        }
    });

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
