/**
 * 训练配置注入器 - 类型定义
 */

/** polymas 平台凭证 */
export interface PolymasCredentials {
    authorization: string;
    cookie: string;
}

/** 解析后的训练阶段（从 Markdown 剧本配置提取） */
export interface ParsedStep {
    stepName: string;
    trainerName: string;
    modelId: string;
    agentId: string;         // 声音 ID
    avatarNid: string;       // 形象 ID
    description: string;
    prologue: string;        // 开场白
    llmPrompt: string;       // 提示词
    interactiveRounds: number;
    backgroundImage: string;
    flowCondition: string;
    transitionPrompt: string;
    scriptStepCover: Record<string, string>;
}

/** 解析后的评分项（从 Markdown 评分标准提取） */
export interface ParsedScoreItem {
    itemName: string;
    score: number;
    description: string;
    requireDetail: string;
}

/** 注入请求 */
export interface InjectRequest {
    trainTaskId: string;
    credentials: PolymasCredentials;
    scriptMarkdown?: string;     // 训练剧本 Markdown 内容
    rubricMarkdown?: string;     // 评分标准 Markdown 内容
    coverStylePrompt?: string;   // 课程封面图风格提示
    injectMode: 'replace' | 'append';  // 全新创建 / 追加
}

/** 注入进度 SSE 事件 */
export type InjectProgressEvent =
    | { type: 'start'; phase: 'script' | 'rubric'; message: string; total: number }
    | { type: 'progress'; phase: 'script' | 'rubric'; message: string; current: number; total: number }
    | { type: 'phase_complete'; phase: 'script' | 'rubric'; message: string }
    | { type: 'complete'; message: string; summary: InjectSummary }
    | { type: 'error'; message: string };

/** 注入结果汇总 */
export interface InjectSummary {
    stepsCreated: number;
    flowsCreated: number;
    scoreItemsCreated: number;
    stepsDeleted: number;
    flowsDeleted: number;
}

/** polymas API 中的脚本节点 */
export interface PolymasScriptStep {
    stepId: string;
    stepDetailDTO: {
        nodeType: string;     // 'SCRIPT_NODE' | 'SCRIPT_START' | 'SCRIPT_END'
        stepName: string;
        description?: string;
        prologue?: string;
        modelId?: string;
        llmPrompt?: string;
        trainerName?: string;
        interactiveRounds?: number;
        agentId?: string;
        avatarNid?: string;
        scriptStepCover?: Record<string, string>;
        backgroundTheme?: string | null;
    };
    positionDTO?: {
        x?: number;
        y?: number;
    };
}

/** polymas API 中的连线 */
export interface PolymasScriptFlow {
    flowId: string;
    scriptStepStartId: string;
    scriptStepEndId: string;
    flowCondition: string;
    transitionPrompt: string;
}
