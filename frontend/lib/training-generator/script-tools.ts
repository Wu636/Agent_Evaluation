import { collectTrainingScriptStageRanges, isScriptFieldLine, matchStageHeading, normalizeTrainingScriptSource, parseTaskConfig, parseTrainingScript, parseTrainingScriptFlowConfig, repairTrainingScriptForParsing, serializeTrainingStage } from "@/lib/training-injector/parser";
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

export function normalizeTrainingScriptCompletion(markdown: string): string {
    const lines = String(markdown || "").split("\n");
    const markerIndex = lines.findIndex((line) => line.trim() === TRAINING_SCRIPT_COMPLETE_MARKER);
    if (markerIndex < 0) return markdown;

    const truncatedLines = lines.slice(0, markerIndex + 1);
    const truncated = truncatedLines.join("\n").trim();
    if (!hasOddFenceCount(truncated)) return truncated;

    const beforeMarker = truncatedLines.slice(0, markerIndex).join("\n").trimEnd();
    return [
        beforeMarker,
        "```",
        "",
        TRAINING_SCRIPT_COMPLETE_MARKER,
    ].filter((line, index) => index !== 0 || line).join("\n").trim();
}

export function extractStageNumberFromHeading(heading: string): number | null {
    return matchStageHeading(heading)?.stageNumber ?? null;
}

export function extractScriptStructure(markdown: string): ScriptStructure {
    const lines = repairTrainingScriptForParsing(markdown).split("\n");
    const stageRanges = collectTrainingScriptStageRanges(lines);

    if (stageRanges.length === 0) {
        return {
            prefix: markdown.trim(),
            stages: [],
            suffix: "",
        };
    }

    const stages: ScriptStageSection[] = [];
    const firstStageStart = stageRanges[0].start;
    const prefix = joinLines(lines.slice(0, firstStageStart));

    stageRanges.forEach(({ start, end }, index) => {
        const stageLines = lines.slice(start, end);
        const heading = stageLines.find((line) => matchStageHeading(line.trim()))?.trim() || stageLines[0]?.trim() || `### 阶段${index + 1}`;
        const stepName = matchStageHeading(heading)?.stepName || heading.split(/[:：]/).slice(1).join(":").trim() || `阶段${index + 1}`;
        stages.push({
            index,
            heading,
            markdown: joinLines(stageLines),
            stepName,
        });
    });

    const suffixStart = stageRanges[stageRanges.length - 1].end;
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

export function buildSerializableGraphEdges(plan: TrainingScriptPlan): Array<{
    from: string;
    to: string;
    condition: string;
    conditionDescription: string;
    transitionPrompt: string;
    isDefault: number;
}> {
    const moduleIds = new Set(plan.modules.map((module) => module.id));
    const validEdges = (plan.edges || [])
        .filter((edge: ScriptFlowEdge) =>
            moduleIds.has(edge.fromModuleId) &&
            (moduleIds.has(edge.toModuleId) || normalizeEndNodeId(edge.toModuleId)) &&
            edge.fromModuleId !== edge.toModuleId &&
            edge.condition.trim()
        );
    const defaultBySource = new Map<string, ScriptFlowEdge>();
    for (const edge of validEdges) {
        const siblings = validEdges.filter((item) => item.fromModuleId === edge.fromModuleId);
        const explicitDefault = siblings.find((item) => /^(?:1|true)$/i.test(String(item.isDefault)));
        defaultBySource.set(edge.fromModuleId, explicitDefault || siblings[0]);
    }
    return validEdges
        .map((edge) => {
            const from = resolveEdgeStageLabel(edge.fromModuleId, plan, "from");
            return {
                from,
                to: resolveEdgeStageLabel(edge.toModuleId, plan, "to"),
                condition: edge.condition.trim(),
                conditionDescription: edge.conditionDescription || "",
                transitionPrompt: edge.transitionPrompt || "",
                isDefault: defaultBySource.get(edge.fromModuleId) === edge ? 1 : 0,
            };
        });
}

function stripNonlinearFlowConfigBlocks(markdown: string): string {
    const lines = String(markdown || "").split("\n");
    const headingPattern = /^#{1,6}\s*(?:(?:🔀|🔄)\s*)?(?:(?:非线性|分支|图结构|流程图|多线路)[\s\S]{0,32}(?:跳转|流程|连线|关系)|(?:阶段|线性)跳转关系)(?:\s|$|[（(])/i;
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

export function buildPlannedStageRouting(plan: TrainingScriptPlan, stageNumber: number): string {
    if (plan.flowType !== 'graph') return '';
    const from = `阶段${stageNumber}`;
    const edges = buildSerializableGraphEdges(plan).filter((edge) => edge.from === from);
    return [
        `# 阶段${stageNumber}的分支跳转规则（模块规划）`,
        '阶段编号只用于文档定位，实际路径由本节连线决定。保持学生已锁定的角色和路线。',
        '本节是本阶段的完整出口清单；前文出现的其他跳转关键词或按编号依次跳转表述，以本节为准。',
        ...edges.map((edge) => [
            `- 目标：${edge.to}${edge.to === 'END' ? '（结束当前路线）' : `（${plan.modules[Number(edge.to.slice(2)) - 1]?.title || ''}）`}`,
            `  判定：${edge.conditionDescription || '完成本阶段教学要求并满足该规划线路条件。'}`,
            `  命中该分支时单独输出：${JSON.stringify(edge.condition)}`,
        ].join('\n')),
        edges.length === 0 ? '本阶段没有规划的后继模块，完成当前路线后结束实训。' : '',
        '多个出口应互斥判定，每次只选择一个；未达到教学要求时继续本阶段。isDefault 只标记平台默认连线，不代表无条件跳转。',
    ].filter(Boolean).join('\n');
}

/** 完成校验后，把已确认的图连线同步到阶段字段和提示词，避免两套路由互相矛盾。 */
export function alignTrainingScriptWithPlan(markdown: string, plan?: TrainingScriptPlan): string {
    if (!plan || plan.flowType !== 'graph') return markdown;
    const structure = extractScriptStructure(markdown);
    const edges = buildSerializableGraphEdges(plan);
    const generatedEdges = parseTrainingScriptFlowConfig(markdown).edges;
    const stages = structure.stages.map((stage) => {
        const stageNumber = extractStageNumberFromHeading(stage.heading);
        if (!stageNumber || !plan.modules[stageNumber - 1]) return stage.markdown;
        const step = parseTrainingScript(stage.markdown)[0];
        if (!step?.llmPrompt) return stage.markdown;
        const outgoing = edges.filter((edge) => edge.from === `阶段${stageNumber}`);
        const primary = outgoing.find((edge) => edge.isDefault === 1) || outgoing[0];
        let prompt = step.llmPrompt.replace(/\n*<!-- PLANNED_ROUTING_START -->[\s\S]*?<!-- PLANNED_ROUTING_END -->/g, '').trimEnd();
        if (outgoing.length && primary) {
            const staleKeywords = new Set([
                step.flowCondition,
                ...generatedEdges.filter((edge) => edge.from === `阶段${stageNumber}`).map((edge) => edge.condition),
            ]);
            const allowed = outgoing.map((edge) => edge.condition);
            for (const keyword of staleKeywords) {
                if (keyword && !allowed.some((condition) => condition.includes(keyword))) {
                    prompt = prompt.split(keyword).join(outgoing.length === 1
                        ? primary.condition : '本节出口清单中与当前路线匹配的跳转关键词');
                }
            }
        }
        const nextStep = {
            ...step,
            stepName: plan.modules[stageNumber - 1].title,
            flowCondition: primary?.condition || step.flowCondition,
            transitionPrompt: primary?.transitionPrompt || step.transitionPrompt,
            llmPrompt: `${prompt}\n\n<!-- PLANNED_ROUTING_START -->\n${buildPlannedStageRouting(plan, stageNumber)}\n<!-- PLANNED_ROUTING_END -->`,
        };
        return [
            `<!-- STAGE_START:${stageNumber} -->`,
            serializeTrainingStage(nextStep, stageNumber),
            `<!-- STAGE_END:${stageNumber} -->`,
        ].join('\n');
    });
    return ensureNonlinearFlowConfigMarkdown([
        structure.prefix, ...stages, structure.suffix,
    ].filter(Boolean).join('\n\n'), plan);
}

export function diagnoseTrainingScript(markdown: string, modulePlan?: TrainingScriptPlan | null): ScriptDiagnosticsResult {
    const issues: ScriptDiagnosticIssue[] = [];
    const normalizedMarkdown = normalizeTrainingScriptCompletion(markdown);
    const taskConfig = parseTaskConfig(normalizedMarkdown);
    const parsedSteps = parseTrainingScript(normalizedMarkdown);
    const flowConfig = parseTrainingScriptFlowConfig(normalizedMarkdown);
    const structure = extractScriptStructure(normalizedMarkdown);

    if (hasUnclosedTrainingScriptFence(normalizedMarkdown)) {
        issues.push({
            level: "error",
            message: "检测到未闭合的 Markdown 代码块，剧本很可能在某个提示词或衔接语中被截断。",
            field: "markdownFence",
        });
    }
    if (!hasTrainingScriptCompleteMarker(normalizedMarkdown)) {
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
            const expectedTitle = modulePlan?.modules?.[index]?.title?.trim() || "阶段名称";
            issues.push({
                level: "error",
                message: `阶段 ${index + 1} 的标题不是标准格式，请把该阶段标题改成独立一行，例如：### 阶段${index + 1}: ${expectedTitle}`,
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
        if (!step.interactiveRounds || step.interactiveRounds < 1) {
            issues.push({ level: "warning", message: `阶段 ${index + 1} 的互动轮次不合理（应大于等于 1 轮）。`, stageIndex: index, field: "interactiveRounds" });
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
        const expectedCount = modulePlan.modules.length;
        const actualCount = parsedSteps.length;
        const missingStageNumber = actualCount < expectedCount ? actualCount + 1 : null;
        const missingStageTitle = missingStageNumber
            ? modulePlan.modules[missingStageNumber - 1]?.title?.trim() || "阶段名称"
            : "";
        issues.push({
            level: "warning",
            message: missingStageNumber
                ? `模块规划共 ${expectedCount} 个模块，但当前剧本解析出 ${actualCount} 个阶段。请优先检查阶段 ${missingStageNumber} 的标题是否为独立一行标准格式，例如：### 阶段${missingStageNumber}: ${missingStageTitle}`
                : `模块规划共 ${expectedCount} 个模块，但当前剧本解析出 ${actualCount} 个阶段。请检查是否存在重复阶段标题，标准格式示例：### 阶段1: 阶段名称`,
            stageIndex: missingStageNumber ? missingStageNumber - 1 : undefined,
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
