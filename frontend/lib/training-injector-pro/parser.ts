/**
 * 能力训练 Pro - Markdown 解析器
 * 将生成的 Pro 格式 Markdown 解析为结构化数据
 *
 * 解析器设计原则：
 * - 不依赖 emoji 前缀（LLM 可能不输出 emoji）
 * - 兼容半角 `:` 和全角 `：` 冒号
 * - 兼容外层代码块包裹（自动剥离）
 * - 兼容 ``` ``` 和 <script_prompt> </script_prompt> 包裹剧本提示词
 */

import {
  ProGlobalConfig,
  ProMemberConfig,
  ProSkillConfig,
  ProStageConfig,
  ProTrainingMode,
  ProDialogueEndStrategy,
  ProDurationType,
} from "../training-generator-pro/types";
import { ParsedProConfig } from "./types";

/**
 * 解析完整 Pro 格式 Markdown
 */
export function parseProMarkdown(markdown: string): ParsedProConfig {
  // 预处理：剥离外层代码块
  const cleaned = stripOuterCodeFence(markdown);

  return {
    globalConfig: parseProGlobalConfig(cleaned),
    members: parseProMembers(cleaned),
    stages: parseProStages(cleaned),
  };
}

// ─── 预处理 ──────────────────────────────────────────────────────────────────

/**
 * 剥离外层 markdown 代码块
 * 如果整个内容被 ```markdown ... ``` 或 ``` ... ``` 包裹，则去掉外层包裹
 */
function stripOuterCodeFence(markdown: string): string {
  let text = markdown.trim();

  // 去除开头的 ```markdown 或 ```
  const startMatch = text.match(/^```(?:markdown)?\s*\n([\s\S]*)$/);
  if (startMatch) {
    text = startMatch[1];
    // 去除末尾的 ```
    const endMatch = text.match(/^([\s\S]*?)```\s*$/);
    if (endMatch) {
      text = endMatch[1];
    }
  }

  return text.trim();
}

// ─── 全局配置 ──────────────────────────────────────────────────────────────────

/**
 * 解析全局配置节
 */
export function parseProGlobalConfig(markdown: string): ProGlobalConfig {
  const globalSection = extractSection(markdown, "全局配置");

  return {
    abilityName: extractField(globalSection, "能力名称") || "未命名",
    description: extractField(globalSection, "描述") || "",
    trainingMode: parseTrainingMode(extractField(globalSection, "训练方式")),
    subtitleEnabled: parseBoolean(extractField(globalSection, "默认打开字幕")),
    cameraEnabled: parseBoolean(extractField(globalSection, "全程开启摄像头")),
    totalDuration: parseDuration(extractField(globalSection, "训练总时长")),
    entranceVoiceName: extractField(globalSection, "入场音色") || "",
    coverImageDescription: extractField(globalSection, "封面图描述") || "",
  };
}

// ─── 全局成员 ──────────────────────────────────────────────────────────────────

/**
 * 解析全局成员配置
 */
export function parseProMembers(markdown: string): ProMemberConfig[] {
  const membersSection = extractSection(markdown, "全局成员配置");
  if (!membersSection) return [];

  const members: ProMemberConfig[] = [];

  // 匹配 ### 成员N: 名称 或 ### 成员N：名称 格式
  // 也兼容 ### 1. 成员名 等变体
  const memberHeaderRegex =
    /###\s*(?:成员\s*\d+\s*[:：]\s*|成员\s*[:：]\s*|成员\s+)(.+)/g;

  let match;
  const memberBlocks: { name: string; content: string }[] = [];
  let lastEnd = membersSection.length;

  // 先收集所有成员头部的位置
  const headers: { name: string; start: number; contentStart: number }[] = [];
  while ((match = memberHeaderRegex.exec(membersSection)) !== null) {
    const name = match[1].trim();
    const contentStart = match.index + match[0].length;
    headers.push({ name, start: match.index, contentStart });
  }

  // 提取每个成员的内容块
  for (let i = 0; i < headers.length; i++) {
    const contentEnd = i + 1 < headers.length ? headers[i + 1].start : lastEnd;
    const block = membersSection.substring(headers[i].contentStart, contentEnd);
    memberBlocks.push({ name: headers[i].name, content: block });
  }

  for (const { name, content: block } of memberBlocks) {
    const skills = parseSkills(block);

    members.push({
      memberName: name,
      roleDescription:
        extractField(block, "角色描述") ||
        extractField(block, "描述") ||
        `你是${name}，在实训中承担相应职责。`,
      modelId: extractField(block, "模型") || "Doubao-Seed-2.0-pro",
      voiceName: extractField(block, "声音") || "",
      avatarDescription:
        extractField(block, "形象描述") || extractField(block, "形象") || "",
      skills,
    });
  }

  return members;
}

// ─── 训练剧本（阶段） ────────────────────────────────────────────────────────────

/**
 * 解析阶段剧本配置
 */
export function parseProStages(markdown: string): ProStageConfig[] {
  const scriptSection = extractSection(markdown, "训练剧本");
  if (!scriptSection) return [];

  const stages: ProStageConfig[] = [];

  // 匹配 ### 阶段N: 名称 或 ### 阶段N：名称 格式
  const stageHeaderRegex =
    /###\s*(?:阶段\s*\d+\s*[:：]\s*|阶段\s*[:：]\s*|阶段\s+)(.+)/g;

  let match;
  const headers: { name: string; contentStart: number }[] = [];

  while ((match = stageHeaderRegex.exec(scriptSection)) !== null) {
    const name = match[1].trim();
    const contentStart = match.index + match[0].length;
    headers.push({ name, contentStart });
  }

  for (let i = 0; i < headers.length; i++) {
    const contentEnd =
      i + 1 < headers.length
        ? headers[i + 1].contentStart - headers[i].contentStart
        : undefined;
    const block =
      contentEnd !== undefined
        ? scriptSection.substring(
            headers[i].contentStart,
            headers[i].contentStart + contentEnd,
          )
        : scriptSection.substring(headers[i].contentStart);

    const cardName = headers[i].name;

    // 提取剧本提示词
    const scriptPrompt = extractScriptPrompt(block);

    stages.push({
      cardName,
      cardDescription: extractField(block, "卡片描述") || "",
      userRoleName: extractField(block, "用户扮演角色名称") || "",
      userAssignName:
        extractField(block, "AI 对用户称呼") ||
        extractField(block, "AI对用户称呼") ||
        extractField(block, "用户称呼") ||
        "",
      userRoleDescription: extractField(block, "用户扮演角色描述") || "",
      scriptModel: extractField(block, "剧本模型") || "Doubao-Seed-2.0-pro",
      scriptPrompt: scriptPrompt || "",
      dialogueEndStrategy: parseEndStrategy(
        extractField(block, "对话结束策略"),
      ),
      skippable: parseBoolean(extractField(block, "是否可跳过")),
      backgroundImageDescription:
        extractField(block, "背景图描述") ||
        extractField(block, "背景图") ||
        "",
    });
  }

  return stages;
}

// ─── 辅助函数 ──────────────────────────────────────────────────────────────────

/**
 * 提取指定标题下的内容节
 * 不依赖 emoji，只匹配中文标题文字
 */
function extractSection(markdown: string, sectionTitle: string): string {
  // 匹配 ## 标题（可能包含 emoji）到下一个 ## 之间的内容
  const escapedTitle = sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // ## 后面可能有 emoji 和空格，然后是标题文字
  // 不用 m 标志！因为 $ 在 m 模式下匹配每行行尾，会导致非贪婪的 [\s\S]*? 匹配零字符就满足条件
  const regex = new RegExp(
    `##\\s*[^\\n]*?${escapedTitle}[\\s\\S]*?(?=\\n##\\s|$)`,
  );
  const match = markdown.match(regex);
  return match ? match[0] : "";
}

/**
 * 提取 **字段名**: 值 格式的字段
 * 兼容半角 `:` 和全角 `：`
 */
function extractField(text: string, fieldName: string): string {
  const escapedName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 支持 **字段**: 值、- **字段**: 值、**字段**：值 等格式
  // 用 m 标志使 ^ 匹配行首；行尾用 \n 匹配而非 $（避免非贪婪问题）
  const regex = new RegExp(
    `(?:^|\\n)\\s*-?\\s*\\*\\*${escapedName}\\*\\*\\s*[:：]\\s*(.+?)(?=\\n|$)`,
    "m",
  );
  const match = text.match(regex);
  if (!match) return "";
  const value = match[1].trim();
  // 去除选填标记
  if (value === "(选填)" || value === "（选填）") return "";
  return value;
}

/**
 * 提取剧本提示词内容
 * 兼容三种格式：
 * 1. <script_prompt> ... </script_prompt>
 * 2. ``` ... ``` 代码块
 * 3. 直接文本（在"阶段剧本提示词"标签后）
 */
function extractScriptPrompt(text: string): string {
  const promptIndex = text.indexOf("阶段剧本提示词");
  if (promptIndex === -1) return "";

  const afterPrompt = text.substring(promptIndex);

  // 1. 先尝试 <script_prompt> 标签
  const tagMatch = afterPrompt.match(
    /<script_prompt>\s*\n?([\s\S]*?)<\/script_prompt>/,
  );
  if (tagMatch) return tagMatch[1].trim();

  // 2. 再尝试代码块 ```
  const codeBlockMatch = afterPrompt.match(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  // 3. 最后尝试直接文本（取到下一个 ### 或文件末尾）
  // 找到冒号后的第一行开始
  const colonMatch = afterPrompt.match(/[:：]\s*\n([\s\S]*?)(?=\n###\s|$)/);
  if (colonMatch) return colonMatch[1].trim();

  return "";
}

/**
 * 解析技能列表
 */
function parseSkills(memberBlock: string): ProSkillConfig[] {
  const skills: ProSkillConfig[] = [];
  // 匹配 - 技能名称 | 类型: xxx | 描述: xxx 格式
  const skillRegex =
    /^\s*-\s+(.+?)\s*\|\s*类型\s*[:：]\s*(.+?)\s*\|\s*描述\s*[:：]\s*(.+?)$/gm;
  const matches: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;

  while ((match = skillRegex.exec(memberBlock)) !== null) {
    matches.push(match);
  }

  for (let index = 0; index < matches.length; index++) {
    const current = matches[index];
    const followingStart =
      index + 1 < matches.length
        ? matches[index + 1].index
        : memberBlock.length;
    const instructionBlock = memberBlock.slice(
      current.index + current[0].length,
      followingStart,
    );
    const instructionMatch = instructionBlock.match(
      /<skill_instruction>\s*([\s\S]*?)<\/skill_instruction>/i,
    );
    skills.push({
      skillName: current[1].trim(),
      skillType: current[2].trim(),
      skillDescription: current[3].trim(),
      skillInstruction: instructionMatch
        ? instructionMatch[1]
            .split("\n")
            .map((line) => line.replace(/^\s{0,4}/, ""))
            .join("\n")
            .trim()
        : "",
    });
  }

  return skills;
}

/**
 * 解析训练方式
 */
function parseTrainingMode(value: string): ProTrainingMode {
  if (!value) return "student_choice";
  if (value.includes("语音")) return "voice";
  if (value.includes("文本")) return "text";
  return "student_choice";
}

/**
 * 解析对话结束策略
 */
function parseEndStrategy(value: string): ProDialogueEndStrategy {
  if (!value) return "goal_achieved";
  if (value.includes("超时")) return "timeout";
  if (value.includes("手动")) return "manual";
  return "goal_achieved";
}

/**
 * 解析布尔值
 */
function parseBoolean(value: string): boolean {
  if (!value) return false;
  return value === "是" || value === "true" || value === "开启";
}

/**
 * 解析训练时长
 */
function parseDuration(value: string): ProDurationType {
  if (!value) return "unlimited";
  if (value.includes("不限") || value.includes("unlimited")) return "unlimited";
  if (value.includes("自动") || value.includes("auto")) return "auto";
  const num = parseInt(value, 10);
  return isNaN(num) ? "unlimited" : num;
}
