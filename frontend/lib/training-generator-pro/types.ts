/**
 * 能力训练 Pro - 类型定义
 * 与基础版完全独立，无评价标准模块
 */

// ─── 全局配置 ─────────────────────────────────────────────────────────────

/** 训练方式 */
export type ProTrainingMode = "student_choice" | "voice" | "text";

/** 训练总时长 */
export type ProDurationType = "unlimited" | "auto" | number;

/** 全局配置 */
export interface ProGlobalConfig {
  abilityName: string; // 能力名称
  description: string; // 描述
  trainingMode: ProTrainingMode; // 训练方式
  subtitleEnabled: boolean; // 默认打开字幕
  cameraEnabled: boolean; // 全程开启摄像头
  totalDuration: ProDurationType; // 训练总时长(分钟)
  entranceVoiceName: string; // 入场音色名称（如"灿灿"）
  coverImageDescription: string; // 封面图描述（用于AI生图）
}

// ─── 技能配置 ─────────────────────────────────────────────────────────────

/** 技能配置（绑定在成员上） */
export interface ProSkillConfig {
  skillName: string; // 技能名称
  skillType: string; // 技能类型
  skillDescription: string; // 技能描述（触发条件）
  skillInstruction: string; // 技能指令（触发后的规则、输出和示例）
}

// ─── 全局成员配置 ──────────────────────────────────────────────────────────

/** 全局成员配置 */
export interface ProMemberConfig {
  memberName: string; // 角色名
  roleDescription: string; // 角色描述（用于平台 prompt 字段，必填）
  modelId: string; // 模型
  voiceName: string; // 声音名称（如"灿灿"）
  avatarDescription: string; // 形象描述（用于AI生图）
  skills: ProSkillConfig[]; // 技能列表
}

// ─── 阶段剧本配置 ─────────────────────────────────────────────────────────

/** 对话结束策略 */
export type ProDialogueEndStrategy = "goal_achieved" | "timeout" | "manual";

/** 阶段剧本配置 */
export interface ProStageConfig {
  cardName: string; // 卡片名称
  cardDescription: string; // 卡片描述
  userRoleName: string; // 用户扮演角色名称
  userAssignName?: string; // AI 对用户的指定称呼
  userRoleDescription: string; // 用户扮演角色描述
  scriptModel: string; // 剧本模型（剧本提示词模型）
  scriptPrompt: string; // 阶段剧本提示词（长文本，5维度结构）
  dialogueEndStrategy: ProDialogueEndStrategy; // 对话结束策略
  skippable: boolean; // 是否可跳过
  backgroundImageDescription: string; // 背景图描述（用于AI生图）
}

// ─── 完整配置 ──────────────────────────────────────────────────────────────

/** 完整 Pro 训练配置 */
export interface ProTrainingConfig {
  globalConfig: ProGlobalConfig;
  members: ProMemberConfig[];
  stages: ProStageConfig[];
}

// ─── SSE 事件类型 ──────────────────────────────────────────────────────────

/** Pro 版 SSE 事件 */
export type ProTrainingSSEEvent =
  | { type: "start"; message: string }
  | { type: "chunk"; content: string }
  | { type: "complete"; fullContent: string; taskName: string }
  | { type: "error"; message: string };

// ─── 生成请求 ──────────────────────────────────────────────────────────────

/** Pro 版生成请求 */
export interface ProTrainingGenerateRequest {
  teacherDocContent: string; // 教师文档内容
  teacherDocName: string; // 教师文档名称
  userGenerationAdvice?: string; // 用户对本次配置生成的补充建议
}
