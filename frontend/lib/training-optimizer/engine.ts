import { jsonrepair } from "jsonrepair";

import { MODEL_NAME_MAPPING } from "@/lib/config";
import { formatDialogueForLLM } from "@/lib/llm/evaluator";
import { summarizeLlmHttpError } from "@/lib/llm/error-utils";
import { ApiConfig, DialogueData, EvaluationReport, IssueItem } from "@/lib/llm/types";
import { evaluateWithTemplate } from "@/lib/llm/template-evaluator";
import { parseTxtDialogue } from "@/lib/txt-converter";
import { parseTaskConfig, parseTrainingScript } from "@/lib/training-injector/parser";
import { diagnoseTrainingScript, extractScriptStructure, replaceStageInScript } from "@/lib/training-generator/script-tools";
import {
    generateTrainingScriptStream,
    planTrainingScriptModules,
    regenerateTrainingScriptModule,
    repairTrainingScriptStructure,
} from "@/lib/training-generator/generator";
import { ConcreteScriptMode, ScriptModulePlan, TrainingScriptPlan } from "@/lib/training-generator/types";
import { DEFAULT_DIMENSIONS, TemplateDimensionsConfig } from "@/lib/templates";

import {
    OptimizationAction,
    OptimizationActionType,
    OptimizationEvidence,
    OptimizationLoopResult,
    OptimizationPlan,
    OptimizationPriority,
    OptimizationProgressEvent,
} from "./types";

const OPTIMIZATION_SYSTEM_PROMPT = `你是“能力训练闭环优化器”。
你的职责不是重新设计整套课程，而是根据【教师文档】【当前训练剧本】【实际对话记录】【评测报告】做最小必要修改。

优化原则：
1. 优先局部修复，能改单阶段就不要整篇重写
2. 先修高严重度、强证据、可落地的问题
3. 修改指令必须可直接交给“单模块重生成器”执行
4. 不要脱离教师文档原始目标
5. 输出必须是严格 JSON，不要解释，不要 Markdown`;

type DialogueInput = {
    dialogueRecordContent: string;
    dialogueRecordName: string;
};

type OptimizationEngineInput = {
    teacherDocContent: string;
    teacherDocName: string;
    dialogueInput: DialogueInput;
    scriptMarkdown: string;
    rubricMarkdown?: string;
    modulePlan?: TrainingScriptPlan;
    apiConfig: ApiConfig & { model: string };
    maxActions?: number;
    optimizationFeedback?: string;
    evaluationTemplateId?: string;
    evaluationTemplateName?: string;
    evaluationTemplateDimensions?: TemplateDimensionsConfig;
    onProgress?: (event: OptimizationProgressEvent) => void;
};

function normalizeChatCompletionEndpoint(baseUrl: string): string {
    const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!trimmed) return "";
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

function clampIterations(value: number | undefined): number {
    if (!Number.isFinite(value)) return 1;
    return Math.max(1, Math.min(3, Math.round(value as number)));
}

function emitProgress(
    callback: OptimizationEngineInput["onProgress"],
    stage: string,
    message: string,
    current?: number,
    total?: number
) {
    callback?.({
        type: "progress",
        stage,
        message,
        current,
        total,
    });
}

function trimContent(content: string, maxLength: number, label: string): string {
    const value = String(content || "").trim();
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength)}\n\n[${label} 过长，已截断剩余 ${value.length - maxLength} 字符]`;
}

function resolveMaxOptimizationActions(requested: number | undefined, modulePlan: TrainingScriptPlan): number {
    const moduleCount = Math.max(1, modulePlan.modules.length || 0);
    const normalizedRequested = Number.isFinite(requested) ? Math.round(requested as number) : 2;
    return Math.max(1, Math.min(normalizedRequested, moduleCount));
}

function stripMarkdownFence(content: string): string {
    let cleaned = String(content || "").trim();
    if (cleaned.startsWith("```markdown")) cleaned = cleaned.slice(11).trim();
    else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3).trim();
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3).trim();
    return cleaned;
}

async function regenerateFullScriptFromPlan(
    teacherDocContent: string,
    apiConfig: ApiConfig & { model: string },
    modulePlan: TrainingScriptPlan,
    onProgress?: OptimizationEngineInput["onProgress"]
): Promise<string> {
    emitProgress(onProgress, "replan", "正在按新模块规划重生成完整训练剧本...");

    let combined = "";
    for await (const chunk of generateTrainingScriptStream(
        teacherDocContent,
        apiConfig,
        undefined,
        modulePlan.recommendedMode,
        modulePlan
    )) {
        combined += chunk;
    }

    let scriptMarkdown = stripMarkdownFence(combined);
    let diagnostics = diagnoseTrainingScript(scriptMarkdown, modulePlan);
    const stageCountMismatch = modulePlan.modules.length > 0 && diagnostics.stageCount !== modulePlan.modules.length;
    if (diagnostics.stageCount === 0 || diagnostics.issues.some((issue) => issue.level === "error") || stageCountMismatch) {
        emitProgress(onProgress, "replan", "新剧本结构需要修复，正在执行自动结构修复...");
        scriptMarkdown = stripMarkdownFence(await repairTrainingScriptStructure(
            teacherDocContent,
            scriptMarkdown,
            apiConfig,
            undefined,
            modulePlan.recommendedMode,
            modulePlan
        ));
        diagnostics = diagnoseTrainingScript(scriptMarkdown, modulePlan);
    }

    if (diagnostics.stageCount === 0 || diagnostics.issues.some((issue) => issue.level === "error")) {
        const firstError = diagnostics.issues.find((issue) => issue.level === "error")?.message || "结构诊断未通过";
        throw new Error(`按新规划重生成剧本后仍存在结构问题：${firstError}`);
    }

    return scriptMarkdown;
}

function inferModuleType(step: ReturnType<typeof parseTrainingScript>[number]): ConcreteScriptMode {
    const text = `${step.stepName} ${step.description} ${step.llmPrompt}`.toLowerCase();
    if (/复盘|总结|答疑|结案/.test(text)) return "summary";
    if (/病人|客户|家属|角色|模拟人物|问一答一/.test(text)) return "roleplay";
    if (/闯关|逐步|顺序|准入|准出|通关|禁止跳关/.test(text)) return "sequential";
    return "general";
}

function pickKeyPoints(step: ReturnType<typeof parseTrainingScript>[number]): string[] {
    const source = `${step.description}\n${step.llmPrompt}`.split("\n");
    const candidates = source
        .map((line) => line.trim())
        .filter((line) => Boolean(line))
        .filter((line) => /^[-*]\s+/.test(line) || /^\d+[.)、]/.test(line) || /步骤|要点|判定|策略/.test(line))
        .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+[.)、]\s*/, "").trim())
        .filter((line) => line.length >= 6);

    if (candidates.length >= 2) {
        return candidates.slice(0, 3);
    }

    const fallbacks = [
        step.description.trim(),
        step.prologue.trim(),
        step.flowCondition ? `完成后触发 ${step.flowCondition}` : "",
    ].filter(Boolean);

    while (fallbacks.length < 2) {
        fallbacks.push("结合教师文档补强本阶段训练目标");
    }

    return fallbacks.slice(0, 3);
}

export function ensureModulePlanFromScript(
    scriptMarkdown: string,
    existingPlan?: TrainingScriptPlan
): TrainingScriptPlan {
    if (existingPlan?.modules?.length) {
        return existingPlan;
    }

    const taskConfig = parseTaskConfig(scriptMarkdown);
    const steps = parseTrainingScript(scriptMarkdown);

    const modules: ScriptModulePlan[] = steps.map((step, index) => ({
        id: `module_${index + 1}`,
        title: step.stepName || `阶段 ${index + 1}`,
        moduleType: inferModuleType(step),
        objective: step.description || `完成${step.stepName || `阶段 ${index + 1}`}的训练目标`,
        description: step.description || step.prologue || `自动从当前训练剧本推断的阶段 ${index + 1}`,
        keyPoints: pickKeyPoints(step),
        interactionStyle: step.llmPrompt.slice(0, 160) || "根据当前阶段提示词进行交互",
        transitionGoal: step.flowCondition || "完成当前阶段目标",
        suggestedRounds: Math.max(1, Math.round(step.interactiveRounds || 3)),
    }));

    return {
        taskName: taskConfig?.trainTaskName || "当前训练任务",
        audience: "待补充",
        overallObjective: taskConfig?.description || "根据教师文档和当前训练剧本自动推断的整体目标",
        recommendedMode: modules[0]?.moduleType || "general",
        modules,
        notes: ["此模块规划由当前训练剧本自动反推，仅用于闭环优化过程。"],
    };
}

function serializeModulePlan(plan: TrainingScriptPlan): string {
    return JSON.stringify({
        taskName: plan.taskName,
        overallObjective: plan.overallObjective,
        recommendedMode: plan.recommendedMode,
        modules: plan.modules.map((module, index) => ({
            id: module.id,
            stageNumber: index + 1,
            title: module.title,
            moduleType: module.moduleType,
            objective: module.objective,
            description: module.description,
            keyPoints: module.keyPoints,
            suggestedRounds: module.suggestedRounds,
            transitionGoal: module.transitionGoal,
        })),
    }, null, 2);
}

function serializeScriptSummary(scriptMarkdown: string): string {
    const steps = parseTrainingScript(scriptMarkdown);
    return JSON.stringify(steps.map((step, index) => ({
        stageNumber: index + 1,
        title: step.stepName,
        description: step.description,
        rounds: step.interactiveRounds,
        flowCondition: step.flowCondition,
        opening: step.prologue.slice(0, 240),
        promptExcerpt: step.llmPrompt.slice(0, 1200),
    })), null, 2);
}

function simplifyIssues(dimension: string, subDimension: string, issues: IssueItem[]): OptimizationEvidence[] {
    return issues.slice(0, 3).map((issue) => ({
        dimension,
        sub_dimension: subDimension,
        description: issue.description,
        location: issue.location,
        quote: issue.quote,
        impact: issue.impact,
        severity: issue.severity,
    }));
}

function serializeReportForOptimizer(report: EvaluationReport): string {
    const dimensions = (report.dimensions || []).map((dimension) => ({
        dimension: dimension.dimension,
        score: dimension.score,
        full_score: dimension.full_score,
        level: dimension.level,
        weak_sub_dimensions: (dimension.sub_scores || [])
            .filter((sub) => sub.score < sub.full_score * 0.75 || ["不足", "较差", "评估失败", "解析失败"].includes(sub.rating))
            .map((sub) => ({
                sub_dimension: sub.sub_dimension,
                score: sub.score,
                full_score: sub.full_score,
                rating: sub.rating,
                judgment_basis: trimContent(sub.judgment_basis || "", 700, `${sub.sub_dimension} 判据`),
                issues: simplifyIssues(dimension.dimension, sub.sub_dimension, sub.issues || []),
            })),
    }));

    return JSON.stringify({
        total_score: report.total_score,
        final_level: report.final_level,
        issues: report.issues,
        suggestions: report.suggestions,
        dimensions,
    }, null, 2);
}

export function parseDialogueInput(input: DialogueInput): DialogueData {
    const { dialogueRecordContent, dialogueRecordName } = input;
    const normalizedName = String(dialogueRecordName || "").toLowerCase();

    if (normalizedName.endsWith(".json")) {
        return JSON.parse(dialogueRecordContent) as DialogueData;
    }

    return parseTxtDialogue(dialogueRecordContent);
}

async function callPlannerJson(
    prompt: string,
    config: ApiConfig & { model: string }
): Promise<string> {
    const endpoint = normalizeChatCompletionEndpoint(config.baseUrl || "");
    if (!endpoint) throw new Error("未配置 LLM API 地址");

    const response = await fetch(endpoint, {
        method: "POST",
        headers: buildLlmHeaders(config.apiKey),
        body: JSON.stringify({
            model: MODEL_NAME_MAPPING[config.model] || config.model,
            temperature: 0.1,
            maxTokens: 3200,
            n: 1,
            presence_penalty: 0.0,
            messages: [
                { role: "system", content: OPTIMIZATION_SYSTEM_PROMPT },
                { role: "user", content: prompt },
            ],
        }),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`训练优化分析失败：${summarizeLlmHttpError(response.status, errorText)}`);
    }

    const data = await response.json();
    return String(data.choices?.[0]?.message?.content || "").trim();
}

function parsePlannerOutput(raw: string): OptimizationPlan {
    const cleaned = String(raw || "")
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    const jsonText = firstBrace >= 0 && lastBrace > firstBrace
        ? cleaned.slice(firstBrace, lastBrace + 1)
        : cleaned;

    const parsed = JSON.parse(jsonrepair(jsonText)) as Partial<OptimizationPlan>;
    const actions = Array.isArray(parsed.actions) ? parsed.actions : [];

    return {
        summary: String(parsed.summary || "已完成训练优化分析。"),
        root_causes: Array.isArray(parsed.root_causes) ? parsed.root_causes.map((item) => String(item)) : [],
        recommended_iterations: clampIterations(parsed.recommended_iterations),
        stop_condition: String(parsed.stop_condition || "当高优先级问题已被覆盖，或无法继续在当前剧本内局部修复时停止。"),
        actions: actions.map((action, index) => normalizeAction(action, index)),
    };
}

function normalizePriority(value: unknown): OptimizationPriority {
    return value === "high" || value === "medium" || value === "low" ? value : "medium";
}

function normalizeActionType(value: unknown): OptimizationActionType {
    const valid: OptimizationActionType[] = [
        "rewrite_module",
        "revise_opening",
        "adjust_rounds",
        "tighten_entry_check",
        "strengthen_exit_check",
        "improve_transition",
        "enhance_followup",
        "persona_alignment",
        "reduce_leakage",
        "refine_rubric",
        "replan",
    ];

    return valid.includes(value as OptimizationActionType)
        ? value as OptimizationActionType
        : "rewrite_module";
}

function normalizeEvidence(rawEvidence: unknown[]): OptimizationEvidence[] {
    return rawEvidence.map((item) => {
        const record = (item && typeof item === "object") ? item as Record<string, unknown> : {};
        return {
            dimension: String(record.dimension || ""),
            sub_dimension: String(record.sub_dimension || ""),
            description: String(record.description || ""),
            location: String(record.location || "未定位"),
            quote: String(record.quote || ""),
            impact: String(record.impact || ""),
            severity: record.severity === "high" || record.severity === "low" ? record.severity : "medium",
        };
    });
}

function normalizeAction(rawAction: unknown, index: number): OptimizationAction {
    const record = (rawAction && typeof rawAction === "object") ? rawAction as Record<string, unknown> : {};
    return {
        id: String(record.id || `action_${index + 1}`),
        title: String(record.title || `优化动作 ${index + 1}`),
        scope: record.scope === "global" || record.scope === "rubric" ? record.scope : "module",
        priority: normalizePriority(record.priority),
        action_type: normalizeActionType(record.action_type),
        target_module_id: record.target_module_id ? String(record.target_module_id) : undefined,
        target_stage_number: Number.isFinite(record.target_stage_number) ? Number(record.target_stage_number) : undefined,
        module_title: record.module_title ? String(record.module_title) : undefined,
        instruction: String(record.instruction || ""),
        rationale: String(record.rationale || ""),
        expected_gain: Array.isArray(record.expected_gain) ? record.expected_gain.map((item) => String(item)) : [],
        evidence: normalizeEvidence(Array.isArray(record.evidence) ? record.evidence : []),
    };
}

function buildOptimizationPrompt(params: {
    teacherDocContent: string;
    dialogueText: string;
    scriptMarkdown: string;
    rubricMarkdown?: string;
    modulePlan: TrainingScriptPlan;
    baselineReport: EvaluationReport;
    maxActions: number;
    optimizationFeedback?: string;
}): string {
    const weakDimensionCount = params.baselineReport.dimensions
        .flatMap((dimension) => dimension.sub_scores || [])
        .filter((sub) => sub.score < sub.full_score * 0.75 || ["不足", "较差", "评估失败", "解析失败"].includes(sub.rating))
        .length;

    return [
        "请基于以下材料，为当前能力训练剧本生成“最小必要修改”的优化计划。",
        "",
        `最多输出 ${Math.max(1, params.maxActions)} 条动作；若可以合并，请优先合并到同一个模块动作中。`,
        `当前低分/风险子维度数量：${weakDimensionCount}`,
        "",
        "<teacher_document>",
        trimContent(params.teacherDocContent, 18000, "教师文档"),
        "</teacher_document>",
        "",
        "<dialogue_record>",
        trimContent(params.dialogueText, 22000, "对话记录"),
        "</dialogue_record>",
        "",
        "<module_plan>",
        serializeModulePlan(params.modulePlan),
        "</module_plan>",
        "",
        "<script_summary>",
        serializeScriptSummary(params.scriptMarkdown),
        "</script_summary>",
        params.rubricMarkdown
            ? ["", "<rubric_summary>", trimContent(params.rubricMarkdown, 9000, "评分标准"), "</rubric_summary>"].join("\n")
            : "",
        "",
        "<evaluation_report>",
        serializeReportForOptimizer(params.baselineReport),
        "</evaluation_report>",
        params.optimizationFeedback?.trim()
            ? ["", "<user_feedback>", params.optimizationFeedback.trim(), "</user_feedback>"].join("\n")
            : "",
        "",
        "输出要求：",
        "1. 只输出严格 JSON。",
        "2. 优先输出 scope=module 的动作，除非你有充分理由判定必须重做全局结构。",
        "3. 若 scope=module，则必须尽量提供 target_module_id 与 target_stage_number。",
        "4. instruction 字段必须能直接交给单模块重生成器执行，必须具体说明要改哪些地方，例如：开场白、互动轮次、准入条件、准出检查、追问策略、transitionPrompt、禁止泄题约束。",
        "5. evidence 必须从评测报告中的问题证据归纳，不要编造新的轮次引用。",
        "6. 如果提供了 user_feedback，请把它作为额外优化约束一并考虑，但不能违背教师文档和实际证据。",
        "7. 若问题涉及“流程推进过快/过早跳转/学生还没完成就进入下一阶段”，必须同时检查两类根因：",
        "   - 准入/准出条件是否过松",
        "   - 互动轮次是否过小。系统按“学生一次发言 + AI 一次回复”为 1 轮，到达预设轮次后会强制流转，不能只盯准入准出条件。",
        "8. 单阶段互动轮次上限为 10。若你判断某阶段合理完成目标需要超过 10 轮，必须输出 scope=global 且 action_type=replan 的动作，明确要求把该模块拆成两个相邻阶段，而不是继续堆高单阶段轮次。",
        "9. 只有在需要拆分阶段、调整模块数或重排全局结构时，才使用 scope=global / action_type=replan；否则优先用 module 动作局部修补。",
        "",
        "JSON 结构如下：",
        "{",
        '  "summary": "总体判断",',
        '  "root_causes": ["根因1", "根因2"],',
        '  "recommended_iterations": 1,',
        '  "stop_condition": "停止条件",',
        '  "actions": [',
        "    {",
        '      "id": "action_1",',
        '      "title": "动作标题",',
        '      "scope": "module",',
        '      "priority": "high",',
        '      "action_type": "rewrite_module",',
        '      "target_module_id": "module_2",',
        '      "target_stage_number": 2,',
        '      "module_title": "模块标题",',
        '      "instruction": "直接给模块修订器的具体中文指令",',
        '      "rationale": "为什么这么改",',
        '      "expected_gain": ["环节准入条件", "深度追问技巧"],',
        '      "evidence": [',
        "        {",
        '          "dimension": "流程遵循度",',
        '          "sub_dimension": "环节准入条件",',
        '          "description": "问题描述",',
        '          "location": "第3轮对话",',
        '          "quote": "原文引用",',
        '          "impact": "影响",',
        '          "severity": "high"',
        "        }",
        "      ]",
        "    }",
        "  ]",
        "}",
    ].filter(Boolean).join("\n");
}

function enrichEvaluationReport(
    report: EvaluationReport,
    teacherDocName: string,
    teacherDocContent: string,
    dialogueRecordName: string,
    dialogueRecordContent: string
): EvaluationReport {
    return {
        ...report,
        teacher_doc_name: teacherDocName,
        teacher_doc_content: teacherDocContent,
        dialogue_doc_name: dialogueRecordName,
        dialogue_doc_content: dialogueRecordContent,
    };
}

function getActionOrder(priority: OptimizationPriority): number {
    switch (priority) {
        case "high":
            return 0;
        case "medium":
            return 1;
        case "low":
        default:
            return 2;
    }
}

function resolveStageIndex(action: OptimizationAction, modulePlan: TrainingScriptPlan): number {
    if (action.target_module_id) {
        const index = modulePlan.modules.findIndex((module) => module.id === action.target_module_id);
        if (index >= 0) return index;
    }

    if (Number.isFinite(action.target_stage_number)) {
        const index = Number(action.target_stage_number) - 1;
        if (index >= 0 && index < modulePlan.modules.length) return index;
    }

    return -1;
}

function buildFeedbackFromActions(actions: OptimizationAction[]): string {
    return [
        "请优先修复以下问题，并尽量保留当前阶段中已经有效的内容：",
        ...actions.map((action, index) => [
            `${index + 1}. ${action.title}`,
            `- 具体修改要求：${action.instruction}`,
            action.rationale ? `- 修改原因：${action.rationale}` : "",
            action.expected_gain.length > 0 ? `- 预期改善：${action.expected_gain.join("、")}` : "",
            action.evidence.length > 0
                ? `- 证据摘要：${action.evidence.map((item) => `${item.sub_dimension}(${item.location})`).join("；")}`
                : "",
        ].filter(Boolean).join("\n")),
        "附加要求：",
        "- 不要偏离教师文档的原始训练目标。",
        "- 满足跳转条件时保持 flowCondition 输出纯净。",
        "- 优先修订开场白、互动轮次、准入准出检查、追问路径和提示词中的约束逻辑。",
        "- 学生一次发言 + AI 一次回复记为 1 轮；达到预设轮次后系统会强制推进，因此遇到“流程推进过快”时必须同步检查互动轮次，而不是只收紧准入准出条件。",
        "- 单阶段互动轮次最高为 10；若当前阶段合理完成目标预计超过 10 轮，请改写为可在 10 轮内完成的范围，或明确提示需要拆分阶段。",
    ].join("\n");
}

function buildFeedbackFromActionsWithUserInput(
    actions: OptimizationAction[],
    optimizationFeedback?: string
): string {
    const base = buildFeedbackFromActions(actions);
    const userFeedback = optimizationFeedback?.trim();
    if (!userFeedback) return base;

    return [
        base,
        "",
        "用户额外修订建议：",
        userFeedback,
        "",
        "处理要求：",
        "- 在不违背教师文档与现有问题证据的前提下，尽量吸收上述用户建议。",
        "- 若用户建议与教师文档冲突，以教师文档为准；若与当前问题修复目标冲突，以问题修复为准。",
    ].join("\n");
}

function buildPlanningFeedbackFromActions(
    actions: OptimizationAction[],
    optimizationFeedback?: string
): string {
    const stageSpecificHints = actions.map((action, index) => {
        const target = Number.isFinite(action.target_stage_number)
            ? `模块${action.target_stage_number}`
            : action.module_title
                ? `模块「${action.module_title}」`
                : "目标模块";

        const splitHint = Number.isFinite(action.target_stage_number)
            ? `请将模块${action.target_stage_number}拆分成两个模块。`
            : "";

        return [
            `${index + 1}. ${action.title}`,
            splitHint,
            `- 目标位置：${target}`,
            `- 结构修订要求：${action.instruction}`,
            action.rationale ? `- 修订原因：${action.rationale}` : "",
            action.expected_gain.length > 0 ? `- 预期改善：${action.expected_gain.join("、")}` : "",
        ].filter(Boolean).join("\n");
    });

    return [
        "请在尽量保留现有模块顺序、有效内容和训练目标的前提下，重规划当前训练剧本结构。",
        "重点结构修订如下：",
        ...stageSpecificHints,
        "",
        "结构修订硬约束：",
        "- 学生一次发言 + AI 一次回复记为 1 轮；达到预设轮次后系统会强制流转。",
        "- 若问题是流程推进过快，必须同时处理准入条件、准出检查和建议轮次，不能只收紧准入准出。",
        "- 每个模块的建议轮次最高为 10。",
        "- 若某个模块合理完成目标预计超过 10 轮，必须拆分成两个相邻模块分阶段推进。",
        "- 非必要不要减少模块数量，也不要打乱原有整体训练逻辑。",
        optimizationFeedback?.trim()
            ? ["", "用户额外修订建议：", optimizationFeedback.trim()].join("\n")
            : "",
    ].filter(Boolean).join("\n");
}

export async function generateOptimizationPlan(
    params: OptimizationEngineInput & {
        baselineReport: EvaluationReport;
        modulePlanUsed: TrainingScriptPlan;
    }
): Promise<OptimizationPlan> {
    const dialogueData = parseDialogueInput(params.dialogueInput);
    const maxActions = resolveMaxOptimizationActions(params.maxActions, params.modulePlanUsed);
    const prompt = buildOptimizationPrompt({
        teacherDocContent: params.teacherDocContent,
        dialogueText: formatDialogueForLLM(dialogueData),
        scriptMarkdown: params.scriptMarkdown,
        rubricMarkdown: params.rubricMarkdown,
        modulePlan: params.modulePlanUsed,
        baselineReport: params.baselineReport,
        maxActions,
        optimizationFeedback: params.optimizationFeedback,
    });

    const raw = await callPlannerJson(prompt, params.apiConfig);
    return parsePlannerOutput(raw);
}

export async function runTrainingOptimizationLoop(
    params: OptimizationEngineInput
): Promise<OptimizationLoopResult> {
    params.onProgress?.({
        type: "start",
        stage: "prepare",
        message: "正在解析对话记录与当前训练剧本...",
    });

    const dialogueData = parseDialogueInput(params.dialogueInput);
    emitProgress(
        params.onProgress,
        "baseline_evaluation",
        params.evaluationTemplateName
            ? `正在使用评测模板「${params.evaluationTemplateName}」评估当前对话表现...`
            : "正在使用默认评测模板评估当前对话表现..."
    );

    const baselineRaw = params.evaluationTemplateDimensions
        ? await evaluateWithTemplate(
            params.teacherDocContent,
            dialogueData,
            params.evaluationTemplateDimensions,
            params.apiConfig,
            {
                onProgress: (progress) => {
                    emitProgress(
                        params.onProgress,
                        "baseline_evaluation",
                        `正在评测：${progress.dimensionName} / ${progress.subDimensionName}`,
                        progress.current,
                        progress.total
                    );
                },
                preferStaticPrompts: false,
            }
        )
        : await evaluateWithTemplate(
            params.teacherDocContent,
            dialogueData,
            DEFAULT_DIMENSIONS,
            params.apiConfig,
            {
                onProgress: (progress) => {
                    emitProgress(
                        params.onProgress,
                        "baseline_evaluation",
                        `正在评测：${progress.dimensionName} / ${progress.subDimensionName}`,
                        progress.current,
                        progress.total
                    );
                },
                preferStaticPrompts: true,
            }
        );

    const baselineReport = enrichEvaluationReport(
        baselineRaw,
        params.teacherDocName,
        params.teacherDocContent,
        params.dialogueInput.dialogueRecordName,
        params.dialogueInput.dialogueRecordContent
    );

    emitProgress(params.onProgress, "analysis", "正在分析低分原因并生成修订方案...");
    let activeModulePlan = ensureModulePlanFromScript(params.scriptMarkdown, params.modulePlan);
    const optimizationPlan = await generateOptimizationPlan({
        ...params,
        baselineReport,
        modulePlanUsed: activeModulePlan,
    });

    const sortedActions = [...optimizationPlan.actions].sort((a, b) => {
        const priorityDiff = getActionOrder(a.priority) - getActionOrder(b.priority);
        if (priorityDiff !== 0) return priorityDiff;
        return (a.target_stage_number || 999) - (b.target_stage_number || 999);
    });

    const maxActions = resolveMaxOptimizationActions(params.maxActions, activeModulePlan);
    const limitedActions = sortedActions.slice(0, maxActions);

    let optimizedScriptMarkdown = params.scriptMarkdown;
    const appliedActions: OptimizationAction[] = [];
    const skippedActions: OptimizationAction[] = [];
    const runtimeWarnings: string[] = [];
    const groupedActions = new Map<number, OptimizationAction[]>();

    const structuralActions = limitedActions.filter((action) => action.scope === "global" || action.action_type === "replan");
    if (structuralActions.length > 0) {
        try {
            emitProgress(
                params.onProgress,
                "replan",
                `检测到 ${structuralActions.length} 条结构性修订动作，正在重规划模块结构...`,
                1,
                Math.max(1, limitedActions.length)
            );

            const replanned = await planTrainingScriptModules(
                params.teacherDocContent,
                params.apiConfig,
                {
                    planningFeedback: buildPlanningFeedbackFromActions(structuralActions, params.optimizationFeedback),
                    usePreviousPlan: true,
                    currentPlan: activeModulePlan,
                    previousPlan: activeModulePlan,
                }
            );

            activeModulePlan = replanned.plan;
            optimizedScriptMarkdown = await regenerateFullScriptFromPlan(
                params.teacherDocContent,
                params.apiConfig,
                activeModulePlan,
                params.onProgress
            );
            appliedActions.push(...structuralActions);
        } catch (error) {
            skippedActions.push(...structuralActions);
            runtimeWarnings.push(
                error instanceof Error
                    ? `结构性重规划未成功应用：${error.message}`
                    : "结构性重规划未成功应用。"
            );
        }
    }

    for (const action of limitedActions) {
        if (appliedActions.some((item) => item.id === action.id) || skippedActions.some((item) => item.id === action.id)) {
            continue;
        }

        if (action.scope !== "module" || action.action_type === "replan") {
            skippedActions.push(action);
            continue;
        }

        const stageIndex = resolveStageIndex(action, activeModulePlan);
        if (stageIndex < 0 || !activeModulePlan.modules[stageIndex]) {
            skippedActions.push(action);
            continue;
        }

        const existing = groupedActions.get(stageIndex) || [];
        existing.push(action);
        groupedActions.set(stageIndex, existing);
    }

    const stageIndexes = Array.from(groupedActions.keys()).sort((a, b) => a - b);
    for (const stageIndex of stageIndexes) {
        const targetModule = activeModulePlan.modules[stageIndex];
        const actionGroup = groupedActions.get(stageIndex) || [];
        if (!targetModule || actionGroup.length === 0) continue;

        emitProgress(
            params.onProgress,
            "apply_actions",
            `正在修订阶段 ${stageIndex + 1}：${targetModule.title}`,
            appliedActions.length + 1,
            limitedActions.length
        );

        const currentMarkdown = extractScriptStructure(optimizedScriptMarkdown).stages[stageIndex]?.markdown || "";

        const regenerated = await regenerateTrainingScriptModule(
            params.teacherDocContent,
            params.apiConfig,
            activeModulePlan,
            targetModule,
            stageIndex + 1,
            buildFeedbackFromActionsWithUserInput(actionGroup, params.optimizationFeedback),
            true,
            currentMarkdown
        );

        if (!/^#{3,}\s*阶段/i.test(regenerated.trim())) {
            skippedActions.push(...actionGroup);
            runtimeWarnings.push(`阶段 ${stageIndex + 1}「${targetModule.title}」的自动修订结果结构异常，已跳过本轮替换，建议稍后手动单模块重生成。`);
            continue;
        }

        optimizedScriptMarkdown = replaceStageInScript(optimizedScriptMarkdown, stageIndex, regenerated);
        appliedActions.push(...actionGroup);
    }

    for (const action of optimizationPlan.actions) {
        if (!appliedActions.some((item) => item.id === action.id) && !skippedActions.some((item) => item.id === action.id)) {
            skippedActions.push(action);
        }
    }

    const diagnostics = diagnoseTrainingScript(optimizedScriptMarkdown, activeModulePlan);
    const warnings = [...runtimeWarnings, ...diagnostics.issues.map((issue) => issue.message)];

    const result: OptimizationLoopResult = {
        baseline_report: baselineReport,
        optimization_plan: optimizationPlan,
        optimized_script_markdown: optimizedScriptMarkdown,
        optimized_rubric_markdown: params.rubricMarkdown,
        module_plan_used: activeModulePlan,
        applied_actions: appliedActions,
        skipped_actions: skippedActions,
        next_step: "当前版本已自动完成“评测 -> 归因 -> 剧本修订”。下一步请将优化后的剧本重新注入智慧树平台，获取新的对话记录后再发起下一轮闭环优化。",
        warnings,
        evaluation_template_id: params.evaluationTemplateId,
        evaluation_template_name: params.evaluationTemplateName,
        evaluation_template_dimensions: params.evaluationTemplateDimensions,
    };

    params.onProgress?.({
        type: "complete",
        stage: "complete",
        message: "闭环优化完成，结果已生成。",
        result,
    });

    return result;
}
