import type { ProTrainingConfig } from "./types";

export type PresetDialogueRole = "assistant" | "user";
export interface PresetDialogueMessage {
  role: PresetDialogueRole;
  speaker: string;
  content: string;
}
export interface PresetDialogueStage {
  stageName: string;
  messages: PresetDialogueMessage[];
}
export interface PresetDialogueRecord {
  stages: PresetDialogueStage[];
  configFingerprint: string;
  generatedAt: string;
}

export function getConfigFingerprint(markdown: string): string {
  let hash = 2166136261;
  for (let i = 0; i < markdown.length; i++) {
    hash ^= markdown.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function renderPresetDialogue(record: PresetDialogueRecord): string {
  return record.stages.map((stage) => [
    `## ${stage.stageName}`,
    ...stage.messages.map((message) => `**${message.speaker}：** ${message.content}`),
  ].join("\n\n")).join("\n\n---\n\n");
}

export function buildPresetDialoguePrompt(params: {
  config: ProTrainingConfig;
  stageIndex: number;
  performance: "excellent" | "competent" | "needs_improvement";
  targetRounds?: number | null;
  extraRequirements: string;
  previousSummary: string;
}): string {
  const { config, stageIndex, performance, targetRounds, extraRequirements, previousSummary } = params;
  const stage = config.stages[stageIndex];
  const memberList = config.members.map((member) => ({
    memberName: member.memberName,
    roleDescription: member.roleDescription,
    skills: member.skills,
  }));
  const performanceText = {
    excellent: "表现优秀：理解快、回答准确，适度追问体现迁移能力。",
    competent: "表现合格：基本掌握，偶尔需要提示，最终达到本阶段标准。",
    needs_improvement: "待提升：出现符合场景的常见错误，经智能体分步引导后再达标；不得跳过考核或无条件通关。",
  }[performance];
  return `你正在为能力训练生成一段用于演示的预设对话。只能依据下方配置，不得虚构配置中没有的角色、事实或流程。

## 全局训练配置
${JSON.stringify(config.globalConfig)}
## 全局成员及技能
${JSON.stringify(memberList)}
## 当前阶段（${stageIndex + 1}/${config.stages.length}）
阶段名称：${stage.cardName}
阶段描述：${stage.cardDescription}
用户角色：${stage.userRoleName}；${stage.userRoleDescription}
对用户称呼：${stage.userAssignName || "用户"}
阶段剧本：
${stage.scriptPrompt}
## 生成要求
- 第一条必须由本训练中的智能体发言，不能以用户、旁白、标题或元信息开头。阶段开场要自然说明情境并引出任务。
- 对话只属于当前阶段。智能体角色必须来自成员列表；多成员时 speaker 填成员名，用户 speaker 填用户角色名。
- ${performanceText}
- ${targetRounds ? `目标约 ${targetRounds} 轮（一次智能体发言加一次用户回应为一轮），以满足阶段结束判定为准。` : "未指定目标轮数：根据用户角色的知识水平、职责复杂度和本阶段通关条件，自然安排足够的对话轮数，不为凑轮数延长对话。一次智能体发言加一次用户回应为一轮。"}
- 若学员表现为优秀，必须以满足本阶段全部通关条件所需的最少轮数完成；优秀表现可以回答更准确、更主动，但不得省略必要任务、检查或阶段判定。
- 遵守剧本的引导方式、边界、技能触发条件和结束标准，不写出不符合角色知识的内容。
- 不要声称已真实执行外部查询、提交或其他系统操作；必要时注明是模拟情境。
- ${extraRequirements.trim() || "保持自然、具体、适合真实训练场景。"}
- 前序阶段摘要（仅用于承接，不要复述）：${previousSummary || "无，这是第一个阶段。"}

只输出合法 JSON，不要 Markdown 代码围栏，格式如下：
{"messages":[{"role":"assistant","speaker":"成员名","content":"对话内容"},{"role":"user","speaker":"用户角色名","content":"对话内容"}]}`;
}

export function normalizePresetMessages(value: unknown, allowedSpeakers: string[]): PresetDialogueMessage[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { messages?: unknown }).messages)) {
    throw new Error("模型返回的对话格式无效");
  }
  const messages = (value as { messages: unknown[] }).messages.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("对话消息格式无效");
    const item = raw as Record<string, unknown>;
    const role = item.role === "assistant" || item.role === "user" ? item.role : null;
    const speaker = typeof item.speaker === "string" ? item.speaker.trim() : "";
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (!role || !speaker || !content || !allowedSpeakers.includes(speaker)) {
      throw new Error("对话包含无效角色或空内容");
    }
    if ((role === "assistant") !== allowedSpeakers.slice(0, -1).includes(speaker)) {
      throw new Error("对话角色与发言人不匹配");
    }
    return { role, speaker, content } as PresetDialogueMessage;
  });
  if (messages.length < 2 || messages[0].role !== "assistant") {
    throw new Error("每个阶段必需以智能体发言开场，且至少包含一次用户回应");
  }
  return messages;
}
