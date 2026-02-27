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
