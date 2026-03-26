/**
 * 训练配置生成器 - 类型定义
 */

export type ScriptMode = "general" | "sequential" | "roleplay" | "summary" | "auto";
export type ConcreteScriptMode = Exclude<ScriptMode, "auto">;
export type ScriptModuleType = ConcreteScriptMode;

/** 生成请求 */
export interface TrainingGenerateRequest {
    teacherDocContent: string;   // 教师文档内容
    teacherDocName: string;      // 教师文档名称
    generateScript: boolean;     // 是否生成训练剧本配置
    generateRubric: boolean;     // 是否生成评分标准
    scriptMode?: ScriptMode;     // 剧本模式
    modulePlan?: TrainingScriptPlan; // 模块规划
}

/** SSE 事件类型 */
export type TrainingSSEEvent =
    | { type: 'start'; phase: 'script' | 'rubric'; message: string }
    | { type: 'script_mode_detected'; requestedMode: ScriptMode; resolvedMode: ConcreteScriptMode; label: string }
    | { type: 'chunk'; phase: 'script' | 'rubric'; content: string }
    | { type: 'phase_complete'; phase: 'script' | 'rubric'; fullContent: string }
    | { type: 'complete'; script?: string; rubric?: string; taskName: string; resolvedScriptMode?: ConcreteScriptMode }
    | { type: 'error'; message: string };

// ─── V2/V3 模块规划 ───────────────────────────────────────────────────────

export interface ScriptModulePlan {
    id: string;
    title: string;
    moduleType: ScriptModuleType;
    objective: string;
    description: string;
    keyPoints: string[];
    interactionStyle: string;
    transitionGoal: string;
    suggestedRounds: number;
}

export interface TrainingScriptPlan {
    taskName: string;
    audience: string;
    overallObjective: string;
    recommendedMode: ConcreteScriptMode;
    modules: ScriptModulePlan[];
    notes: string[];
}

export interface ScriptPlanValidationIssue {
    level: "error" | "warning";
    message: string;
    moduleId?: string;
    field?: string;
}

export interface TrainingScriptPlanResponse {
    plan: TrainingScriptPlan;
    validation: ScriptPlanValidationIssue[];
    autofillApplied?: boolean;
    autofillFields?: string[];
    autofillTaskFields?: string[];
    autofillModuleFields?: Record<string, string[]>;
}

export interface TrainingPlanRequestOptions {
    planningFeedback?: string;
    usePreviousPlan?: boolean;
    currentPlan?: TrainingScriptPlan;
    previousPlan?: TrainingScriptPlan;
}

// ─── Prompt 模板市场 ───────────────────────────────────────────────────────

/** Prompt 模板类型 */
export type PromptTemplateType = 'script' | 'rubric';

/** Prompt 模板（数据库记录） */
export interface PromptTemplate {
    id: string;
    user_id: string | null;
    name: string;
    description: string | null;
    type: PromptTemplateType;
    prompt_template: string;
    system_prompt: string | null;
    is_public: boolean;
    is_default: boolean;
    use_count: number;
    tags: string[];
    created_at: string;
    updated_at: string;
    creator_name: string | null;
}

/** 创建/更新 Prompt 模板的请求体 */
export interface PromptTemplatePayload {
    name: string;
    description?: string;
    type: PromptTemplateType;
    prompt_template: string;
    system_prompt?: string;
    is_public?: boolean;
    tags?: string[];
}

/** Prompt 模板列表响应 */
export interface PromptTemplateListResponse {
    templates: PromptTemplate[];
}

/** 单个 Prompt 模板响应 */
export interface PromptTemplateResponse {
    template: PromptTemplate;
}
