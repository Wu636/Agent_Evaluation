import { EvaluationReport } from "@/lib/llm/types";
import { TrainingScriptPlan } from "@/lib/training-generator/types";
import { TemplateDimensionsConfig } from "@/lib/templates";

export type OptimizationScope = "module" | "global" | "rubric";
export type OptimizationPriority = "high" | "medium" | "low";
export type OptimizationActionType =
    | "rewrite_module"
    | "revise_opening"
    | "adjust_rounds"
    | "tighten_entry_check"
    | "strengthen_exit_check"
    | "improve_transition"
    | "enhance_followup"
    | "persona_alignment"
    | "reduce_leakage"
    | "refine_rubric"
    | "replan";

export interface OptimizationEvidence {
    dimension: string;
    sub_dimension: string;
    description: string;
    location: string;
    quote: string;
    impact: string;
    severity: "high" | "medium" | "low";
}

export interface OptimizationAction {
    id: string;
    title: string;
    scope: OptimizationScope;
    priority: OptimizationPriority;
    action_type: OptimizationActionType;
    target_module_id?: string;
    target_stage_number?: number;
    module_title?: string;
    instruction: string;
    rationale: string;
    expected_gain: string[];
    evidence: OptimizationEvidence[];
}

export interface OptimizationPlan {
    summary: string;
    root_causes: string[];
    recommended_iterations: number;
    stop_condition: string;
    actions: OptimizationAction[];
}

export interface OptimizationLoopResult {
    baseline_report: EvaluationReport;
    optimization_plan: OptimizationPlan;
    optimized_script_markdown: string;
    optimized_rubric_markdown?: string;
    module_plan_used: TrainingScriptPlan;
    applied_actions: OptimizationAction[];
    skipped_actions: OptimizationAction[];
    next_step: string;
    warnings: string[];
    evaluation_template_id?: string;
    evaluation_template_name?: string;
    evaluation_template_dimensions?: TemplateDimensionsConfig;
}

export interface OptimizationProgressEvent {
    type: "start" | "progress" | "complete" | "error";
    stage: string;
    message: string;
    current?: number;
    total?: number;
    result?: OptimizationLoopResult;
}
