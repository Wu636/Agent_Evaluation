/**
 * 训练配置生成器 - 类型定义
 */

/** 生成请求 */
export interface TrainingGenerateRequest {
    teacherDocContent: string;   // 教师文档内容
    teacherDocName: string;      // 教师文档名称
    generateScript: boolean;     // 是否生成训练剧本配置
    generateRubric: boolean;     // 是否生成评分标准
}

/** SSE 事件类型 */
export type TrainingSSEEvent =
    | { type: 'start'; phase: 'script' | 'rubric'; message: string }
    | { type: 'chunk'; phase: 'script' | 'rubric'; content: string }
    | { type: 'phase_complete'; phase: 'script' | 'rubric'; fullContent: string }
    | { type: 'complete'; script?: string; rubric?: string; taskName: string }
    | { type: 'error'; message: string };

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
