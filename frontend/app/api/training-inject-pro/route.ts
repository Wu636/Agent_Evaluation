/**
 * POST /api/training-inject-pro
 * 能力训练 Pro - 配置注入 API（SSE 流式进度）
 */

import { NextRequest } from "next/server";
import {
  ProGlobalConfig,
  ProMemberConfig,
  ProSkillConfig,
  ProStageConfig,
} from "@/lib/training-generator-pro/types";
import { parseProMarkdown } from "@/lib/training-injector-pro/parser";
import { encodePromptRoleTags } from "@/lib/training-injector-pro/prompt-role-tags";
import { generateAndSyncDigitalHumanAvatar } from "@/lib/training-injector/api";
import type { PolymasCredentials } from "@/lib/training-injector/types";
import {
  selectBestVoiceCandidate,
  toVoiceCandidates,
  type VoiceCandidate,
} from "@/lib/training-injector/voice-selection";

export const runtime = "nodejs";
export const maxDuration = 300;

const CLOUDAPI_BASE_URL = "https://cloudapi.polymas.com";
const DEFAULT_IMAGE_MODEL = "doubao-seedream-5-0-260128";
const DEFAULT_CUSTOM_SKILL_TYPE_NID =
  process.env.POLYMAS_PRO_CUSTOM_SKILL_TYPE_NID || "a1b2c3d4e5";
const POLYMAS_COMPAT_IMAGE_ENDPOINT =
  process.env.POLYMAS_COMPAT_IMAGE_ENDPOINT ||
  process.env.POLYMAS_OPENAI_IMAGE_ENDPOINT ||
  "https://llm-service-beta.polymas.com/api/openai/v1/images/generations";
const POLYMAS_IMAGE_FALLBACK_API_KEY =
  process.env.POLYMAS_IMAGE_FALLBACK_API_KEY ||
  "sk-jqzsYB7vjZ6NEdfsP7oZ17Gti45cSMrHSCxQJzq7hz8Coq7h";

const STAGE_POSITION_X = 0;
const STAGE_POSITION_Y_GAP = 220;

type InjectMode = "fresh" | "append";
type ImageProviderMode = "cloudapi" | "openai";

interface InjectProRequestBody {
  action?:
    | "inject"
    | "list-skills"
    | "delete-skills"
    | "list-digital-humans"
    | "delete-digital-humans";
  markdown?: string;
  targetUrl?: string;
  authorization?: string;
  cookie?: string;
  credentials?: {
    authorization?: string;
    cookie?: string;
    userNid?: string;
  };
  mode?: InjectMode;
  coverStylePrompt?: string;
  backgroundStylePrompt?: string;
  digitalHumanAvatarMode?: "existing" | "ai";
  digitalHumanAvatarStylePrompt?: string;
  imageProviderMode?: ImageProviderMode;
  imageModel?: string;
  injectCoverImage?: boolean;
  injectBackgroundImage?: boolean;
  skillIds?: string[];
  digitalHumanIds?: string[];
}

interface InjectOptions {
  coverStylePrompt: string;
  backgroundStylePrompt: string;
  digitalHumanAvatarMode: "existing" | "ai";
  digitalHumanAvatarStylePrompt: string;
  imageProviderMode: ImageProviderMode;
  imageModel: string;
  injectCoverImage: boolean;
  injectBackgroundImage: boolean;
}

interface PlatformApiEnvelope<T = unknown> {
  code?: number | string;
  success?: boolean;
  data?: T;
  msg?: string;
  message?: string;
  error?: string;
}

interface PlatformVoice {
  nid?: string;
  voiceNid?: string;
  voiceTemplateNid?: string;
  templateNid?: string;
  voiceId?: string;
  id?: string;
  bizId?: string;
  voiceTone?: string;
  voiceName?: string;
  name?: string;
  templateName?: string;
  voiceTemplateName?: string;
  displayName?: string;
  title?: string;
  voiceType?: string;
  type?: string;
  bigModelVoiceParam?: string;
  modelVoiceParam?: string;
  ttsParam?: string;
  voiceCode?: string;
  voiceParam?: string;
  param?: string;
  streamingParam?: string;
  speaker?: string;
  voiceIntroduce?: string;
  introduce?: string;
  description?: string;
  voiceDescription?: string;
  voiceDesc?: string;
  desc?: string;
  remark?: string;
  language?: string;
  locale?: string;
  gender?: string;
  speakerGender?: string;
  sex?: string;
}

interface PlatformAvatar {
  nid?: string;
  avatarNid?: string;
}

interface PlatformDigitalHuman {
  customNid?: string;
  bizId?: string;
  digitalHumanName?: string;
  avatarNid?: string;
  voiceNid?: string;
  bigModelVoiceParam?: string;
  voiceName?: string;
  avatar?: string;
  avatarDynamic?: string;
  digitalHumanAvatarUrl?: string;
  canDeleteFlag?: boolean;
}

interface ReusableDigitalHuman {
  customNid: string;
  digitalHumanName: string;
  nameKey: string;
  avatarNid: string;
  voiceNid: string;
  voiceType?: string;
  voiceName?: string;
}

interface PlatformStep {
  nid?: string;
  stepId?: string;
}

interface PlatformSkillType {
  nid?: string;
  type?: string;
  typeName?: string;
  name?: string;
  packageName?: string;
}

interface PlatformSkillItem {
  nid?: string;
  name?: string;
  skillName?: string;
  globalRoleNid?: string;
  typeNid?: string;
  description?: string | null;
  packageName?: string | null;
}

interface PlatformRoleSkillItem {
  nid?: string;
  name?: string;
  skillName?: string;
  globalRoleNid?: string;
  typeNid?: string;
  description?: string | null;
  packageName?: string | null;
}

interface PlatformRole {
  nid?: string;
  trainTaskNid?: string;
  roleName?: string;
  nickname?: string;
  description?: string | null;
  prompt?: string | null;
  modelCode?: string | null;
  avatarNid?: string | null;
  customDigitalHuman?: string | null;
  voiceNid?: string | null;
  voiceType?: string | null;
  voiceSpeed?: number | null;
  searchEngine?: number | null;
  knowledgeSearch?: number | null;
  knowledgeFileIds?: string | null;
  skills?: string | null;
  skillList?: PlatformRoleSkillItem[];
  roleType?: string;
  systemRole?: boolean;
}

interface UploadedImage {
  fileUrl: string;
  fileId?: string;
}

interface ParsedTargetUrl {
  trainTaskId: string;
  courseId: string;
  libraryId: string;
}

interface SkillWithMember extends ProSkillConfig {
  memberName: string;
}

interface CreatedOrResolvedRole {
  nid: string;
  member: ProMemberConfig;
  existingRole?: PlatformRole;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractCookieValue(cookie: string, names: string[]): string {
  const normalizedNames = new Set(names.map((name) => name.toLowerCase()));
  for (const pair of sanitizeCookieInput(cookie).split(";")) {
    const index = pair.indexOf("=");
    if (index === -1) continue;
    const key = pair.slice(0, index).trim().toLowerCase();
    if (!normalizedNames.has(key)) continue;
    return safeDecodeURIComponent(pair.slice(index + 1).trim());
  }
  return "";
}

function extractHeaderValue(input: string, names: string[]): string {
  const normalizedNames = new Set(names.map((name) => name.toLowerCase()));
  const lines = String(input || "").split(/\r?\n/);
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    if (!normalizedNames.has(key)) continue;
    return line.slice(index + 1).trim();
  }
  return "";
}

function sanitizeCookieInput(input: string): string {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const headerCookie = extractHeaderValue(raw, ["cookie"]);
  if (headerCookie) return headerCookie;
  return raw.replace(/^cookie\s*:\s*/i, "").trim();
}

function readExplicitAuthorization(value: string): string | undefined {
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  const headerAuthorization = extractHeaderValue(raw, ["authorization"]);
  const authorization = (headerAuthorization || raw)
    .replace(/^authorization\s*:\s*/i, "")
    .trim();
  return authorization || undefined;
}

function normalizeDerivedAuthorizationValue(value: string): string | undefined {
  const token = readExplicitAuthorization(value);
  if (!token) return undefined;
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

function buildAuthorization(
  cookie: string,
  authorization?: string,
): string | undefined {
  // 显式 Authorization 与基础版保持一致：用户填什么，就原样转发什么。
  const explicitAuthorization = readExplicitAuthorization(
    authorization || extractHeaderValue(cookie, ["authorization"]),
  );
  if (explicitAuthorization) return explicitAuthorization;

  const token = extractCookieValue(cookie, [
    "ai-poly",
    "authorization",
    "Authorization",
  ]);
  return normalizeDerivedAuthorizationValue(token);
}

function isSuccessEnvelope(result: PlatformApiEnvelope): boolean {
  return result.success === true || String(result.code) === "200";
}

function getApiErrorMessage(result: PlatformApiEnvelope): string {
  return String(
    result.msg || result.message || result.error || "Unknown error",
  );
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

class ProPlatformApi {
  private readonly authorization?: string;

  constructor(
    private readonly cookie: string,
    private readonly trainTaskId: string,
    authorization?: string,
  ) {
    this.cookie = sanitizeCookieInput(cookie);
    this.authorization = buildAuthorization(this.cookie, authorization);
  }

  private async request<T = unknown>(
    method: "GET" | "POST",
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<T> {
    const targetUrl = `${CLOUDAPI_BASE_URL}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      Cookie: this.cookie,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    };
    if (this.authorization) headers.Authorization = this.authorization;

    const response = await fetch(targetUrl, {
      method,
      headers,
      body: method === "POST" && payload ? JSON.stringify(payload) : undefined,
    });

    if (!response.ok) {
      const rawText = await response.text().catch(() => "");
      throw new Error(
        `API Error [${method} ${path}]: HTTP ${response.status} ${response.statusText}${
          rawText ? ` - ${rawText.slice(0, 300)}` : ""
        }`,
      );
    }

    const result = (await response.json()) as PlatformApiEnvelope<T>;
    if (!isSuccessEnvelope(result)) {
      const authHint =
        String(result.code) === "401"
          ? ` [auth=${this.authorization ? "present" : "missing"}, cookie=${
              this.cookie ? "present" : "missing"
            }]`
          : "";
      throw new Error(
        `API Error [${method} ${path}]: ${getApiErrorMessage(result)} (code: ${
          result.code ?? "unknown"
        })${authHint}`,
      );
    }
    return result.data as T;
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T = unknown>(
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<T> {
    return this.request<T>("POST", path, payload);
  }

  getTaskDetail(): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>(
      `/ai-platform/ability-train/tasks/detail?taskId=${this.trainTaskId}`,
    );
  }

  editTask(payload: Record<string, unknown>): Promise<unknown> {
    return this.post("/ai-platform/ability-train/tasks/edit", payload);
  }

  listSteps(): Promise<PlatformStep[]> {
    return this.get<PlatformStep[]>(
      `/ai-platform/ability-train/steps/list?taskId=${this.trainTaskId}`,
    );
  }

  async createStep(payload: Record<string, unknown>): Promise<string> {
    const data = await this.post<string | { nid?: string; stepId?: string }>(
      "/ai-platform/ability-train/steps/create",
      payload,
    );
    const nid =
      typeof data === "string" ? data : String(data?.nid || data?.stepId || "");
    if (!nid) throw new Error("阶段创建成功但未返回 nid");
    return nid;
  }

  editStep(payload: Record<string, unknown>): Promise<unknown> {
    return this.post("/ai-platform/ability-train/steps/edit", payload);
  }

  removeStep(stepId: string): Promise<unknown> {
    return this.post(
      `/ai-platform/ability-train/steps/remove?stepId=${encodeURIComponent(
        stepId,
      )}`,
    );
  }

  listGlobalRoles(): Promise<PlatformRole[]> {
    return this.get<PlatformRole[]>(
      `/ai-platform/ability-train/global-roles/list?trainTaskId=${this.trainTaskId}&needSystemRole=true`,
    );
  }

  getGlobalRoleDetail(roleId: string): Promise<PlatformRole> {
    return this.get<PlatformRole>(
      `/ai-platform/ability-train/global-roles/detail?roleId=${encodeURIComponent(
        roleId,
      )}`,
    );
  }

  async createGlobalRole(payload: Record<string, unknown>): Promise<string> {
    const data = await this.post<string | { nid?: string }>(
      "/ai-platform/ability-train/global-roles/create",
      payload,
    );
    const nid = typeof data === "string" ? data : String(data?.nid || "");
    if (!nid) throw new Error("成员创建成功但未返回 nid");
    return nid;
  }

  editGlobalRole(payload: Record<string, unknown>): Promise<unknown> {
    return this.post("/ai-platform/ability-train/global-roles/edit", payload);
  }

  removeGlobalRole(roleId: string): Promise<unknown> {
    return this.post(
      `/ai-platform/ability-train/global-roles/remove?roleId=${encodeURIComponent(
        roleId,
      )}&trainTaskNid=${encodeURIComponent(this.trainTaskId)}`,
    );
  }

  listSkillTypes(): Promise<PlatformSkillType[]> {
    return this.get<PlatformSkillType[]>(
      "/ai-platform/ability-train/skills/types",
    );
  }

  listSkills(): Promise<PlatformSkillItem[]> {
    return this.get<PlatformSkillItem[]>(
      `/ai-platform/ability-train/skills/list?taskId=${this.trainTaskId}`,
    );
  }

  async createSkill(payload: Record<string, unknown>): Promise<string> {
    const data = await this.post<string | { nid?: string }>(
      "/ai-platform/ability-train/skills/create",
      payload,
    );
    const nid = typeof data === "string" ? data : String(data?.nid || "");
    if (!nid) throw new Error("技能创建成功但未返回 nid");
    return nid;
  }

  editSkill(payload: Record<string, unknown>): Promise<unknown> {
    return this.post("/ai-platform/ability-train/skills/edit", payload);
  }

  removeSkill(skillId: string): Promise<unknown> {
    return this.post(
      `/ai-platform/ability-train/skills/remove?skillId=${encodeURIComponent(
        skillId,
      )}`,
    );
  }

  listVoices(): Promise<PlatformVoice[]> {
    return this.post<PlatformVoice[]>("/ai-profile/ai_voice/list", {});
  }

  listVoiceTrainings(): Promise<PlatformVoice[]> {
    return this.post<PlatformVoice[]>("/ai-profile/ai_voice_training/list", {
      voiceTemplateType: "ONLINE_DOUBAO",
    });
  }

  listAvatars(): Promise<PlatformAvatar[]> {
    return this.post<PlatformAvatar[]>(
      "/ai-profile/ai_avatar/getOwnerAvatar",
      {},
    );
  }

  listDigitalHumans(params?: {
    courseId?: string;
    libraryFolderId?: string;
    userNid?: string;
  }): Promise<PlatformDigitalHuman[]> {
    return this.post<PlatformDigitalHuman[]>(
      "/ai-profile/digital_human/owner/list",
      compactObject({
        courseId: params?.courseId || "",
        libraryFolderId: params?.libraryFolderId || "",
        userNid: params?.userNid || undefined,
        sort: 2,
        type: "NORMAL",
      }),
    );
  }

  async createCustomDigitalHuman(params: {
    digitalHumanName: string;
    voiceNid: string;
    avatarNid: string;
  }): Promise<string> {
    const data = await this.post<{ customNid?: string }>(
      "/ai-profile/digital_human/custom/addAndSyncResource",
      {
        appCode: "",
        type: "NORMAL",
        voiceNid: params.voiceNid,
        avatarNid: params.avatarNid,
        digitalHumanName: params.digitalHumanName || "训练引导员",
      },
    );
    const customNid = String(data?.customNid || "");
    if (!customNid) throw new Error("数字人创建成功但未返回 customNid");
    return customNid;
  }

  deleteCustomDigitalHuman(
    customNid: string,
    userNid?: string,
  ): Promise<unknown> {
    return this.post(
      "/ai-profile/digital_human/custom/delete",
      compactObject({
        customNid,
        userNid: userNid || undefined,
      }),
    );
  }

  static parseUrl(urlStr: string): ParsedTargetUrl | null {
    try {
      const url = new URL(urlStr);
      const trainTaskId = url.searchParams.get("trainTaskId") || "";
      let courseId =
        url.searchParams.get("businessId") ||
        url.searchParams.get("courseId") ||
        "";
      if (!courseId) {
        const pathMatch = url.pathname.match(/\/agent-course-full\/([^/]+)/);
        if (pathMatch) courseId = pathMatch[1];
      }
      const libraryId =
        url.searchParams.get("libraryId") ||
        url.searchParams.get("libraryFolderId") ||
        "";
      if (!trainTaskId) return null;
      return { trainTaskId, courseId, libraryId };
    } catch {
      return null;
    }
  }
}

function normalizeNameKey(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();
}

function normalizeSkillName(value: unknown): string {
  return normalizeNameKey(value);
}

function toReusableDigitalHuman(
  item: PlatformDigitalHuman,
): ReusableDigitalHuman | null {
  const customNid = String(item.customNid || item.bizId || "").trim();
  const digitalHumanName = String(item.digitalHumanName || "").trim();
  const nameKey = normalizeNameKey(digitalHumanName);
  const avatarNid = String(item.avatarNid || "").trim();
  const voiceNid = String(item.voiceNid || "").trim();
  if (!customNid || !nameKey || !avatarNid || !voiceNid) return null;
  return {
    customNid,
    digitalHumanName,
    nameKey,
    avatarNid,
    voiceNid,
    voiceType: String(item.bigModelVoiceParam || "").trim() || undefined,
    voiceName: String(item.voiceName || "").trim() || undefined,
  };
}

function findReusableDigitalHumanByName(
  digitalHumans: ReusableDigitalHuman[],
  memberName: string,
): ReusableDigitalHuman | null {
  const nameKey = normalizeNameKey(memberName);
  if (!nameKey) return null;
  const exact = digitalHumans.find((item) => item.nameKey === nameKey);
  if (exact) return exact;

  if (nameKey.length < 2) return null;
  return (
    digitalHumans.find(
      (item) =>
        item.nameKey.length >= 2 &&
        (item.nameKey.includes(nameKey) || nameKey.includes(item.nameKey)),
    ) || null
  );
}

function normalizeModelId(value: string): string {
  if (!value) return "doubao-seed-2-0-pro";
  if (/^[a-z0-9-]+$/i.test(value) && value.includes("-")) return value;
  const modelMap: Record<string, string> = {
    "Doubao-Seed-2.0-pro": "doubao-seed-2-0-pro",
    "Doubao-1.5-pro": "doubao-1-5-pro-32k-250115",
    "Doubao-1.5-thinking-pro": "doubao-1-5-thinking-pro-250415",
    "DeepSeek-V3": "deepseek-v3-250324",
    "DeepSeek-R1": "deepseek-r1-250528",
    "Qwen3-235B": "qwen3-235b-a22b",
  };
  return modelMap[value] || value.toLowerCase().replace(/[\s.]+/g, "-");
}

function pickAvatarNid(
  avatars: PlatformAvatar[],
  index: number,
): string | null {
  if (avatars.length === 0) return null;
  const avatar = avatars[index % avatars.length];
  return String(avatar?.nid || avatar?.avatarNid || "") || null;
}

function isSystemRole(role: PlatformRole): boolean {
  return (
    role.nid === "system" ||
    role.roleType === "system" ||
    role.systemRole === true
  );
}

function buildSkillTypeMap(
  types: PlatformSkillType[],
): Record<string, PlatformSkillType> {
  const map: Record<string, PlatformSkillType> = {};
  for (const type of types) {
    for (const key of [type.type, type.typeName, type.name]) {
      const normalized = normalizeNameKey(key);
      if (normalized) map[normalized] = type;
    }
  }
  return map;
}

function resolveSkillTypeNid(
  skill: ProSkillConfig,
  skillTypeMap: Record<string, PlatformSkillType>,
): string {
  const customKeys = ["自定义技能", "custom_skill", "custom", "自定义"].map(
    normalizeNameKey,
  );
  const customTypeNid = customKeys
    .map((key) => skillTypeMap[key]?.nid)
    .find(Boolean);

  // 生成文档里的“类型”是教学语义分类，不一定是平台真实技能类型。
  // 平台 UI 中这些能力最终都落成“自定义技能”，优先使用自定义类型可避免
  // 把“专业知识讲解 / 案例分析”等语义类型误当平台类型而远程同步失败。
  if (customTypeNid) return customTypeNid;

  const typeKey = normalizeNameKey(skill.skillType);
  return (
    skillTypeMap[typeKey]?.nid ||
    Object.values(skillTypeMap).find((item) => item.nid)?.nid ||
    DEFAULT_CUSTOM_SKILL_TYPE_NID
  );
}

function getSkillDisplayName(skill: PlatformSkillItem): string {
  return String(skill.name || skill.skillName || "").trim();
}

function getChineseCharSimilarity(left: string, right: string): number {
  const leftChars = new Set(Array.from(normalizeSkillName(left)));
  const rightChars = new Set(Array.from(normalizeSkillName(right)));
  if (leftChars.size === 0 || rightChars.size === 0) return 0;
  let intersection = 0;
  for (const char of leftChars) {
    if (rightChars.has(char)) intersection += 1;
  }
  const union = new Set([...leftChars, ...rightChars]).size;
  return union === 0 ? 0 : intersection / union;
}

function findReusableSkillByName(
  skills: PlatformSkillItem[],
  skillName: string,
): PlatformSkillItem | null {
  const targetKey = normalizeSkillName(skillName);
  if (!targetKey) return null;

  const exact = skills.find(
    (skill) => normalizeSkillName(getSkillDisplayName(skill)) === targetKey,
  );
  if (exact) return exact;

  if (targetKey.length >= 4) {
    const contained = skills.find((skill) => {
      const key = normalizeSkillName(getSkillDisplayName(skill));
      return (
        key.length >= 4 && (key.includes(targetKey) || targetKey.includes(key))
      );
    });
    if (contained) return contained;

    const similar = skills.find(
      (skill) =>
        getChineseCharSimilarity(getSkillDisplayName(skill), skillName) >= 0.78,
    );
    if (similar) return similar;
  }

  return null;
}

function getRoleSkills(roles: PlatformRole[]): PlatformSkillItem[] {
  const result: PlatformSkillItem[] = [];
  for (const role of roles) {
    for (const skill of role.skillList || []) {
      if (!skill.nid) continue;
      result.push({
        ...skill,
        globalRoleNid: skill.globalRoleNid || role.nid,
      });
    }
  }
  return result;
}

function mergeSkillItems(
  ...groups: PlatformSkillItem[][]
): PlatformSkillItem[] {
  const result: PlatformSkillItem[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const skill of group) {
      const key =
        skill.nid ||
        `${normalizeSkillName(getSkillDisplayName(skill))}::${skill.packageName || ""}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(skill);
    }
  }
  return result;
}

function parseSkillsValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildRoleEditPayload(params: {
  role: PlatformRole;
  member?: ProMemberConfig;
  trainTaskId: string;
  skills: string[];
}): Record<string, unknown> {
  const { role, member, trainTaskId, skills } = params;
  const roleName = role.roleName || member?.memberName || role.nickname || "";
  const nickname = role.nickname || roleName;
  const description =
    role.description || member?.roleDescription || `你是${roleName}。`;
  const prompt = role.prompt || description;

  return compactObject({
    nid: role.nid,
    trainTaskNid: role.trainTaskNid || trainTaskId,
    nickname,
    roleName,
    description,
    prompt,
    modelCode: role.modelCode || normalizeModelId(member?.modelId || ""),
    avatarNid: role.avatarNid || null,
    customDigitalHuman: role.customDigitalHuman || null,
    voiceNid: role.voiceNid || role.avatarNid || null,
    voiceType: role.voiceType || null,
    voiceSpeed: role.voiceSpeed ?? 1,
    searchEngine: role.searchEngine ?? 0,
    knowledgeSearch: role.knowledgeSearch ?? 0,
    knowledgeFileIds: role.knowledgeFileIds ?? null,
    // 平台 DTO 这里是 String，不是数组；多个技能用英文逗号拼接。
    // 官方前端在解绑最后一个技能时传 null，空字符串会被后端当成“不更新”。
    skills: skills.length > 0 ? skills.join(",") : null,
  });
}

async function safeGetRoleDetail(
  api: ProPlatformApi,
  role: PlatformRole,
): Promise<PlatformRole> {
  if (!role.nid) return role;
  try {
    return { ...role, ...(await api.getGlobalRoleDetail(role.nid)) };
  } catch {
    return role;
  }
}

async function cleanupExistingConfig(
  api: ProPlatformApi,
  trainTaskId: string,
): Promise<void> {
  for (const step of await api.listSteps().catch(() => [])) {
    const stepId = String(step.nid || step.stepId || "");
    if (!stepId) continue;
    try {
      await api.removeStep(stepId);
    } catch {
      // 清理阶段失败不阻断后续清理，最终创建接口会暴露真实错误。
    }
  }

  // 不删除技能：平台技能 create 会远程同步 SKILL 包，删除本地记录后远端包
  // 可能仍保留，随后同名重建容易报 140002。fresh 模式只解绑旧角色，
  // 让后续流程按名称复用已有技能。
  for (const role of await api.listGlobalRoles().catch(() => [])) {
    if (isSystemRole(role) || !role.nid) continue;
    try {
      const detail = await safeGetRoleDetail(api, role);
      // 必须先解绑技能再删成员。平台删成员时不会级联清理技能关系，
      // 否则会形成无法再通过 global-roles/edit 修复的孤立绑定。
      await api.editGlobalRole(
        buildRoleEditPayload({
          role: detail,
          trainTaskId,
          skills: [],
        }),
      );
      await api.removeGlobalRole(role.nid);
    } catch {
      // 解绑失败时不再强制删成员，避免制造新的孤立绑定。
    }
  }
}

async function updateGlobalConfig(
  api: ProPlatformApi,
  trainTaskId: string,
  config: ProGlobalConfig,
  voices: VoiceCandidate[],
): Promise<void> {
  const communicateMethod =
    config.trainingMode === "voice"
      ? 1
      : config.trainingMode === "text"
        ? 2
        : 3;
  const trainTime =
    config.totalDuration === "unlimited" || config.totalDuration === "auto"
      ? null
      : config.totalDuration;
  const entranceVoice = selectBestVoiceCandidate(voices, {
    preferredName: config.entranceVoiceName,
    roleName: "入场旁白",
    roleDescription: `${config.abilityName} ${config.description}`,
    fallbackToFirst: true,
  });
  const entranceVoiceNid = entranceVoice?.voiceNid || undefined;

  await api.editTask(
    compactObject({
      trainTaskId,
      trainTaskName: config.abilityName,
      description: config.description || null,
      openSubtitle: Number(Boolean(config.subtitleEnabled)),
      openVideo: Number(Boolean(config.cameraEnabled)),
      communicateMethod,
      trainTime,
      entranceVoiceNid,
    }),
  );
}

async function createGlobalMember(
  api: ProPlatformApi,
  trainTaskId: string,
  member: ProMemberConfig,
): Promise<string> {
  const roleDescription =
    member.roleDescription ||
    `你是${member.memberName}，在实训中承担相应职责。`;
  return api.createGlobalRole({
    trainTaskNid: trainTaskId,
    roleName: member.memberName,
    nickname: member.memberName,
    description: roleDescription,
    prompt: roleDescription,
    modelCode: normalizeModelId(member.modelId),
  });
}

async function patchGlobalMember(
  api: ProPlatformApi,
  trainTaskId: string,
  role: PlatformRole,
  member: ProMemberConfig,
  patch: Partial<PlatformRole>,
): Promise<PlatformRole> {
  const merged = { ...role, ...patch };
  await api.editGlobalRole(
    buildRoleEditPayload({
      role: merged,
      member,
      trainTaskId,
      skills: parseSkillsValue(merged.skills).concat(
        (merged.skillList || []).map((item) => String(item.nid || "")),
      ),
    }),
  );
  return merged;
}

function buildSkillInstruction(skill: ProSkillConfig): string {
  const generatedInstruction = String(skill.skillInstruction || "").trim();
  if (generatedInstruction) return generatedInstruction.slice(0, 2000);

  const skillName = skill.skillName || "自定义技能";
  const description =
    skill.skillDescription || `实训过程需要调用「${skillName}」时触发。`;
  const skillType = skill.skillType || "自定义技能";

  return `# codemap
## 命令
- /skill ${skillName}：启动「${skillName}」并进入对应的实训处理流程。
- /skill continue：根据用户最新回答继续追问、判断或纠偏。
- /skill end：在当前技能目标已达成后结束本次调用。

## 使用场景
${description}

## 执行规则
1. 以「${skillType}」的专业要求执行，所有判断必须紧扣当前实训场景和用户回答。
2. 先识别用户已掌握的要点和缺失信息，再以一次一个核心问题的节奏推进。
3. 遇到错误概念、参数、流程或风险操作时，明确指出问题，给出专业改写并要求用户再次表达。
4. 不伪造未提供的数据，不扩展到与本技能无关的任务。

## 输出解释
1. 先给出当前判断或操作要点，再说明理由。
2. 需要交互时，每轮只提出一个清晰、可回答的问题。
3. 使用准确、简洁、可执行的中文表达，必要时以步骤或对照项呈现。

## 示例
用户：请结合当前案例帮我判断应该怎么处理。
模型：已启动「${skillName}」。我会先核对当前场景中的关键条件，再给出判断和纠偏。请先说明你已观察到的最关键现象或参数。`.slice(
    0,
    2000,
  );
}

async function createAndApplySkill(
  api: ProPlatformApi,
  trainTaskId: string,
  skill: ProSkillConfig,
  skillTypeMap: Record<string, PlatformSkillType>,
): Promise<string> {
  const basePayload = buildSkillPayload(trainTaskId, skill, skillTypeMap);

  const nid = await api.createSkill(basePayload);

  // 平台 UI 创建后会立刻走一次 edit，相当于“应用/同步”技能；
  // 缺这一步容易触发 SKILL 远程同步失败或创建后不可用。
  await api.editSkill({
    nid,
    ...basePayload,
  });

  return nid;
}

function buildSkillPayload(
  trainTaskId: string,
  skill: ProSkillConfig,
  skillTypeMap: Record<string, PlatformSkillType>,
): Record<string, unknown> {
  return {
    trainTaskNid: trainTaskId,
    typeNid: resolveSkillTypeNid(skill, skillTypeMap),
    name: skill.skillName,
    // 按平台真实抓包：packageName 与技能名称保持一致。
    packageName: skill.skillName,
    businessConfig: null,
    description: skill.skillDescription || "",
    instruction: buildSkillInstruction(skill),
  };
}

async function updateExistingSkill(
  api: ProPlatformApi,
  trainTaskId: string,
  skillNid: string,
  skill: ProSkillConfig,
  skillTypeMap: Record<string, PlatformSkillType>,
): Promise<void> {
  await api.editSkill({
    nid: skillNid,
    ...buildSkillPayload(trainTaskId, skill, skillTypeMap),
  });
}

async function bindSkillsToRole(params: {
  api: ProPlatformApi;
  trainTaskId: string;
  roleNid: string;
  role: PlatformRole;
  member?: ProMemberConfig;
  skillNids: Set<string>;
}): Promise<void> {
  const detail = await safeGetRoleDetail(params.api, params.role);
  const payload = buildRoleEditPayload({
    role: { ...detail, nid: params.roleNid },
    member: params.member,
    trainTaskId: params.trainTaskId,
    skills: Array.from(params.skillNids).filter(Boolean),
  });
  await params.api.editGlobalRole(payload);
}

async function createStage(
  api: ProPlatformApi,
  trainTaskId: string,
  stage: ProStageConfig,
  memberNidMap: Record<string, string>,
  position: { x: number; y: number },
  backgroundImageUrl: string | null,
): Promise<string> {
  const stepNid = await api.createStep({
    trainTaskNid: trainTaskId,
    stepName: stage.cardName,
    positionX: String(position.x),
    positionY: String(position.y),
  });
  const llmPrompt = encodePromptRoleTags(
    stage.scriptPrompt || "",
    memberNidMap,
  );
  const dialogueEndStrategy =
    stage.dialogueEndStrategy === "timeout"
      ? 2
      : stage.dialogueEndStrategy === "manual"
        ? 3
        : 1;
  const userRoleName = stage.userRoleName || "";
  const userDescription = stage.userRoleDescription || "";
  const userAssignName = buildUserAssignName(stage);

  await api.editStep({
    nid: stepNid,
    trainTaskNid: trainTaskId,
    stepName: stage.cardName,
    description: stage.cardDescription || null,
    userRoleName: userRoleName || null,
    userNameType: 2,
    userAssignName,
    userDescription: userDescription || null,
    modelCode: normalizeModelId(stage.scriptModel),
    llm: llmPrompt || null,
    llmPrompt: llmPrompt || null,
    isSkipStep: Number(Boolean(stage.skippable)),
    positionX: String(position.x),
    positionY: String(position.y),
    // 对话结束策略默认不限时。平台真实 payload 字段是 timeLimit；
    // timeLimited 保留作旧字段兼容。
    timeLimit: -1,
    timeLimited: -1,
    dialogueEndStrategy,
    extConfig: {
      userRoleName: userRoleName || null,
      userNameType: 2,
      userAssignName,
      userDescription: userDescription || null,
      bgMediaType: 1,
      bgMedia: backgroundImageUrl || null,
    },
    stepLlmPromptMemberRoleNidList: Object.values(memberNidMap).filter(Boolean),
  });

  return stepNid;
}

function parseExistingFirstStepId(
  taskDetail: Record<string, unknown> | null,
): string {
  const candidates = [
    taskDetail?.firstStepId,
    taskDetail?.firstStepNid,
    (taskDetail?.extConfig as Record<string, unknown> | undefined)?.firstStepId,
  ];
  return String(candidates.find(Boolean) || "");
}

function buildStagePosition(index: number): { x: number; y: number } {
  return {
    x: STAGE_POSITION_X,
    y: STAGE_POSITION_Y_GAP * Math.max(0, index),
  };
}

function buildUserAssignName(stage: ProStageConfig): string {
  const explicit = normalizeUserAssignName(stage.userAssignName);
  if (explicit) return explicit;

  const roleName = String(stage.userRoleName || "").trim();
  const quotedName = roleName.match(
    /(?:名为|称为|叫做|叫|昵称为|称呼为)\s*[“"']?([^，。,；;、（）()《》“”"'\s]{1,8})/,
  )?.[1];
  const quoted = normalizeUserAssignName(quotedName);
  if (quoted) return quoted;

  const nickname = roleName.match(
    /((?:小|阿|老)[\u4e00-\u9fa5A-Za-z0-9]{1,4})$/,
  )?.[1];
  const normalizedNickname = normalizeUserAssignName(nickname);
  if (normalizedNickname) return normalizedNickname;

  return "用户";
}

function normalizeUserAssignName(value?: string): string {
  const cleaned = String(value || "")
    .replace(/^["“”'‘’]+|["“”'‘’]+$/g, "")
    .trim();
  if (!cleaned || cleaned === "(选填)" || cleaned === "（选填）") return "";
  if (cleaned.length > 12) return "";
  return cleaned;
}

function parseTargetUrl(targetUrl: string): ParsedTargetUrl | null {
  return ProPlatformApi.parseUrl(targetUrl);
}

async function generateCloudapiImage(
  cookie: string,
  payload: Record<string, unknown>,
): Promise<UploadedImage | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const response = await fetch(
      `${CLOUDAPI_BASE_URL}/ai-tools/image/generate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Cookie: cookie,
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );
    clearTimeout(timer);
    if (!response.ok) return null;
    const result = (await response.json()) as PlatformApiEnvelope<any>;
    if (!isSuccessEnvelope(result)) return null;
    const data = result.data || {};
    const fileUrl =
      data.ossUrl || data.fileUrl || data.imageUrl || data.url || "";
    return fileUrl ? { fileUrl, fileId: data.fileId || undefined } : null;
  } catch (error) {
    console.error("[pro-image] cloudapi 生图异常:", error);
    return null;
  }
}

async function generateOpenAICompatibleImage(
  model: string,
  prompt: string,
): Promise<UploadedImage | null> {
  if (!POLYMAS_IMAGE_FALLBACK_API_KEY) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const payload = /^doubao-seedream-/i.test(model)
      ? {
          model,
          prompt,
          size: "2560x1440",
          response_format: "url",
          sequential_image_generation: "disabled",
          watermark: true,
        }
      : { model, prompt, n: 1, size: "1792x1024" };
    const response = await fetch(POLYMAS_COMPAT_IMAGE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${POLYMAS_IMAGE_FALLBACK_API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    const result = await response.json();
    const fileUrl = result?.data?.[0]?.url || "";
    return fileUrl ? { fileUrl } : null;
  } catch (error) {
    console.error("[pro-image] OpenAI 兼容生图异常:", error);
    return null;
  }
}

async function uploadImageFromUrl(
  fileUrl: string,
  cookie: string,
): Promise<UploadedImage | null> {
  try {
    let response = await fetch(fileUrl, {
      headers: {
        Cookie: cookie,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
    });
    if (!response.ok) response = await fetch(fileUrl);
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") || "image/png";
    const arrayBuffer = await response.arrayBuffer();
    if (!arrayBuffer.byteLength) return null;

    const extension =
      contentType.includes("jpeg") || contentType.includes("jpg")
        ? "jpg"
        : "png";
    const fileName = `pro_cover_${Date.now()}.${extension}`;
    const formData = new FormData();
    formData.append("identifyCode", crypto.randomUUID());
    formData.append("name", fileName);
    formData.append("chunk", "0");
    formData.append("chunks", "1");
    formData.append("size", String(arrayBuffer.byteLength));
    formData.append(
      "file",
      new Blob([arrayBuffer], { type: contentType }),
      fileName,
    );

    const uploadResponse = await fetch(
      `${CLOUDAPI_BASE_URL}/basic-resource/file/upload`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
        body: formData,
      },
    );
    if (!uploadResponse.ok) return null;
    const result = (await uploadResponse.json()) as PlatformApiEnvelope<any>;
    if (!isSuccessEnvelope(result)) return null;
    const data = result.data || {};
    const uploadedUrl = data.ossUrl || data.fileUrl || "";
    return uploadedUrl
      ? { fileUrl: uploadedUrl, fileId: data.fileId || undefined }
      : null;
  } catch (error) {
    console.error("[pro-image] 图片上传异常:", error);
    return null;
  }
}

async function generateAndUploadImage(
  cookie: string,
  params: {
    trainName: string;
    trainDescription: string;
    stageName: string;
    stageDescription: string;
  },
  providerMode: ImageProviderMode,
  imageModel: string,
): Promise<UploadedImage | null> {
  if (providerMode === "cloudapi" || providerMode !== "openai") {
    const cloudImage = await generateCloudapiImage(cookie, params);
    if (cloudImage) return cloudImage;
  }

  const prompt = `${params.stageDescription}

任务名称: ${params.trainName}
场景: ${params.stageName}`;
  const generated = await generateOpenAICompatibleImage(
    imageModel || DEFAULT_IMAGE_MODEL,
    prompt,
  );
  if (!generated?.fileUrl) return null;
  return (await uploadImageFromUrl(generated.fileUrl, cookie)) || generated;
}

function buildOptions(body: InjectProRequestBody): InjectOptions {
  return {
    coverStylePrompt:
      body.coverStylePrompt ||
      "专业、简洁、写实的课程封面图，严格16:9横版宽屏构图，主体明确、构图完整、画面克制；禁止拼贴、多宫格、海报排版、卡通漫画、抽象风格；无任何文字、英文单词、logo、水印，尽量不要出现西方面孔和元素",
    backgroundStylePrompt:
      body.backgroundStylePrompt ||
      "专业写实教学场景背景图，严格16:9横版宽屏构图，单一完整场景，画面干净稳定，适合作为课程阶段背景；禁止拼贴、多宫格、海报排版、极端透视、鱼眼、抽象艺术、卡通漫画；无任何文字、英文单词、logo、字幕、水印，尽量不要出现西方面孔和元素",
    digitalHumanAvatarMode: body.digitalHumanAvatarMode || "existing",
    digitalHumanAvatarStylePrompt: body.digitalHumanAvatarStylePrompt || "",
    imageProviderMode: body.imageProviderMode || "cloudapi",
    imageModel: body.imageModel || DEFAULT_IMAGE_MODEL,
    injectCoverImage: body.injectCoverImage !== false,
    injectBackgroundImage: body.injectBackgroundImage !== false,
  };
}

function jsonResponse(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function listManagedSkills(api: ProPlatformApi) {
  const [skills, roleItems] = await Promise.all([
    api.listSkills(),
    api.listGlobalRoles().catch(() => []),
  ]);
  const roles = await Promise.all(
    roleItems.map((role) => safeGetRoleDetail(api, role)),
  );
  const mergedSkills = mergeSkillItems(skills, getRoleSkills(roles));

  return mergedSkills
    .filter((skill) => skill.nid)
    .map((skill) => {
      const skillNid = String(skill.nid || "");
      const roleNames = roles
        .filter((role) => {
          const linkedSkillIds = new Set([
            ...parseSkillsValue(role.skills),
            ...(role.skillList || [])
              .map((item) => String(item.nid || ""))
              .filter(Boolean),
          ]);
          return linkedSkillIds.has(skillNid);
        })
        .map((role) => role.nickname || role.roleName || role.nid || "")
        .filter(Boolean);

      return {
        nid: skillNid,
        name: getSkillDisplayName(skill) || "未命名技能",
        packageName: skill.packageName || "",
        typeNid: skill.typeNid || "",
        description: skill.description || "",
        roleNames,
      };
    });
}

async function deleteManagedSkills(
  api: ProPlatformApi,
  trainTaskId: string,
  skillIds: string[],
) {
  const selectedIds = new Set(skillIds.map(String).filter(Boolean));
  const failed: Array<{ nid: string; error: string }> = [];
  const deleted: string[] = [];

  // 先从成员上解绑，避免平台因技能仍被角色引用而拒绝删除。
  const listedRoles = await api.listGlobalRoles().catch(() => []);
  for (const roleItem of listedRoles) {
    if (isSystemRole(roleItem) || !roleItem.nid) continue;
    const role = await safeGetRoleDetail(api, roleItem);
    const currentSkillIds = Array.from(
      new Set([
        ...parseSkillsValue(role.skills),
        ...(role.skillList || [])
          .map((item) => String(item.nid || ""))
          .filter(Boolean),
      ]),
    );
    const retainedSkillIds = currentSkillIds.filter(
      (skillId) => !selectedIds.has(skillId),
    );
    if (retainedSkillIds.length === currentSkillIds.length) continue;
    await api.editGlobalRole(
      buildRoleEditPayload({
        role,
        trainTaskId,
        skills: retainedSkillIds,
      }),
    );
  }

  for (const skillId of selectedIds) {
    try {
      await api.removeSkill(skillId);
      deleted.push(skillId);
    } catch (error) {
      const rawError = error instanceof Error ? error.message : String(error);
      const friendlyError = rawError.includes("140030")
        ? `平台存在已删除成员留下的孤立绑定，当前公开 API 无法定位或解除。无需手工查找成员 nid，请由平台后台按 skillNid=${skillId} 清理技能-成员关联记录后再删除。`
        : rawError;
      failed.push({
        nid: skillId,
        error: friendlyError,
      });
    }
  }

  return { deleted, failed };
}

async function listManagedDigitalHumans(
  api: ProPlatformApi,
  params: {
    courseId: string;
    libraryId: string;
    userNid?: string;
  },
) {
  const [digitalHumans, roleItems] = await Promise.all([
    api.listDigitalHumans({
      courseId: params.courseId,
      libraryFolderId: params.libraryId,
      userNid: params.userNid,
    }),
    api.listGlobalRoles().catch(() => []),
  ]);
  const roles = await Promise.all(
    roleItems.map((role) => safeGetRoleDetail(api, role)),
  );

  return digitalHumans
    .map((item) => {
      const customNid = String(item.customNid || item.bizId || "").trim();
      if (!customNid) return null;
      return {
        customNid,
        name: item.digitalHumanName || "未命名数字人",
        avatarUrl:
          item.digitalHumanAvatarUrl || item.avatarDynamic || item.avatar || "",
        canDelete: item.canDeleteFlag === true,
        roleNames: roles
          .filter((role) => role.customDigitalHuman === customNid)
          .map((role) => role.nickname || role.roleName || role.nid || "")
          .filter(Boolean),
      };
    })
    .filter(Boolean);
}

async function deleteManagedDigitalHumans(
  api: ProPlatformApi,
  trainTaskId: string,
  digitalHumanIds: string[],
  userNid?: string,
) {
  const selectedIds = new Set(
    digitalHumanIds
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const deleted: string[] = [];
  const failed: Array<{ customNid: string; error: string }> = [];

  const roleItems = await api.listGlobalRoles().catch(() => []);
  for (const roleItem of roleItems) {
    if (isSystemRole(roleItem) || !roleItem.nid) continue;
    const role = await safeGetRoleDetail(api, roleItem);
    if (!selectedIds.has(String(role.customDigitalHuman || ""))) continue;
    await api.editGlobalRole(
      buildRoleEditPayload({
        role: { ...role, customDigitalHuman: null },
        trainTaskId,
        skills: Array.from(
          new Set([
            ...parseSkillsValue(role.skills),
            ...(role.skillList || [])
              .map((item) => String(item.nid || ""))
              .filter(Boolean),
          ]),
        ),
      }),
    );
  }

  for (const customNid of selectedIds) {
    try {
      await api.deleteCustomDigitalHuman(customNid, userNid);
      deleted.push(customNid);
    } catch (error) {
      failed.push({
        customNid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { deleted, failed };
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as InjectProRequestBody;
  const markdown = body.markdown || "";
  const targetUrl = body.targetUrl || "";
  const rawCookie = body.credentials?.cookie || body.cookie || "";
  const cookie = sanitizeCookieInput(rawCookie);
  const authorization =
    body.credentials?.authorization ||
    body.authorization ||
    extractHeaderValue(rawCookie, ["authorization"]);
  const userNid = body.credentials?.userNid || "";
  const mode: InjectMode = body.mode || "fresh";
  const options = buildOptions(body);

  if (!targetUrl || !cookie) {
    return new Response(
      JSON.stringify({ error: "缺少必要参数: targetUrl, cookie" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const target = parseTargetUrl(targetUrl);
  if (!target?.trainTaskId) {
    return new Response(
      JSON.stringify({ error: "无法从 URL 中提取 trainTaskId" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const action = body.action || "inject";
  if (
    action === "list-skills" ||
    action === "delete-skills" ||
    action === "list-digital-humans" ||
    action === "delete-digital-humans"
  ) {
    const api = new ProPlatformApi(cookie, target.trainTaskId, authorization);
    try {
      if (action === "list-skills") {
        const skills = await listManagedSkills(api);
        return jsonResponse({ skills });
      }

      if (action === "list-digital-humans") {
        const digitalHumans = await listManagedDigitalHumans(api, {
          courseId: target.courseId,
          libraryId: target.libraryId,
          userNid,
        });
        return jsonResponse({ digitalHumans });
      }

      if (action === "delete-digital-humans") {
        const digitalHumanIds = Array.from(
          new Set((body.digitalHumanIds || []).map(String).filter(Boolean)),
        );
        if (digitalHumanIds.length === 0) {
          return jsonResponse({ error: "请至少选择一个数字人" }, 400);
        }
        if (digitalHumanIds.length > 100) {
          return jsonResponse({ error: "单次最多删除 100 个数字人" }, 400);
        }
        return jsonResponse(
          await deleteManagedDigitalHumans(
            api,
            target.trainTaskId,
            digitalHumanIds,
            userNid,
          ),
        );
      }

      const skillIds = Array.from(
        new Set((body.skillIds || []).map(String).filter(Boolean)),
      );
      if (skillIds.length === 0) {
        return jsonResponse({ error: "请至少选择一个技能" }, 400);
      }
      if (skillIds.length > 100) {
        return jsonResponse({ error: "单次最多删除 100 个技能" }, 400);
      }
      return jsonResponse(
        await deleteManagedSkills(api, target.trainTaskId, skillIds),
      );
    } catch (error) {
      return jsonResponse(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  }

  if (!markdown) {
    return jsonResponse({ error: "缺少必要参数: markdown" }, 400);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        sendEvent({ type: "start", message: "开始注入 Pro 训练配置..." });

        const { globalConfig, members, stages } = parseProMarkdown(markdown);
        sendEvent({
          type: "progress",
          phase: "global_config",
          message: `解析结果: 全局配置=${globalConfig.abilityName}, 成员=${members.length}个, 阶段=${stages.length}个`,
          current: 0,
          total: 1,
        });

        if (members.length === 0 && stages.length === 0) {
          sendEvent({
            type: "error",
            message: `解析失败！未找到成员和阶段。Markdown前500字符: ${markdown
              .slice(0, 500)
              .replace(/\n/g, " ")}`,
          });
          return;
        }

        const trainTaskId = target.trainTaskId;
        const api = new ProPlatformApi(cookie, trainTaskId, authorization);
        const taskDetail = await api.getTaskDetail().catch(() => null);

        let skillTypes: PlatformSkillType[] = [];
        try {
          skillTypes = await api.listSkillTypes();
        } catch (error) {
          sendEvent({
            type: "progress",
            phase: "skills",
            message: `技能类型列表读取失败，使用默认自定义技能类型 ${DEFAULT_CUSTOM_SKILL_TYPE_NID}`,
            current: 0,
            total: 1,
          });
        }
        const skillTypeMap = buildSkillTypeMap(skillTypes);
        const preservedSkills = mergeSkillItems(
          await api.listSkills().catch(() => []),
          getRoleSkills(await api.listGlobalRoles().catch(() => [])),
        );

        if (mode === "fresh") {
          sendEvent({
            type: "progress",
            phase: "cleanup",
            message: "清理现有配置...",
            current: 0,
            total: 1,
          });
          await cleanupExistingConfig(api, trainTaskId);
          sendEvent({
            type: "progress",
            phase: "cleanup",
            message: "清理完成",
            current: 1,
            total: 1,
          });
        }

        sendEvent({
          type: "progress",
          phase: "members",
          message: "查询可配置音色和头像列表...",
          current: 0,
          total: members.length,
        });
        const voiceTrainings = await api.listVoiceTrainings().catch(() => []);
        const legacyVoices = await api.listVoices().catch(() => []);
        const voiceCandidates = [
          ...toVoiceCandidates(voiceTrainings, "voice-training"),
          ...toVoiceCandidates(legacyVoices, "legacy-voice"),
        ];
        const avatars = await api.listAvatars().catch(() => []);
        sendEvent({
          type: "progress",
          phase: "members",
          message: `可配置音色${voiceTrainings.length}个, 旧音色${legacyVoices.length}个, 头像${avatars.length}个`,
          current: 0,
          total: members.length,
        });

        sendEvent({
          type: "progress",
          phase: "global_config",
          message: "更新全局配置...",
          current: 0,
          total: 1,
        });
        await updateGlobalConfig(api, trainTaskId, globalConfig, voiceCandidates);
        sendEvent({
          type: "progress",
          phase: "global_config",
          message: "全局配置已更新（含入场音色）",
          current: 1,
          total: 1,
        });

        if (options.injectCoverImage && globalConfig.coverImageDescription) {
          sendEvent({
            type: "progress",
            phase: "global_config",
            message: "生成课程封面图...",
            current: 1,
            total: 1,
          });
          try {
            const coverImage = await generateAndUploadImage(
              cookie,
              {
                trainName: globalConfig.abilityName,
                trainDescription:
                  globalConfig.description || globalConfig.abilityName,
                stageName: `${globalConfig.abilityName} 课程封面`,
                stageDescription: `${globalConfig.coverImageDescription}
封面风格要求：${options.coverStylePrompt}`,
              },
              options.imageProviderMode,
              options.imageModel,
            );
            if (coverImage) {
              await api.editTask({
                trainTaskId,
                trainTaskName: globalConfig.abilityName,
                trainTaskCover: coverImage.fileUrl,
              });
              sendEvent({
                type: "progress",
                phase: "global_config",
                message: "封面图已生成并注入",
                current: 1,
                total: 1,
              });
            } else {
              sendEvent({
                type: "progress",
                phase: "global_config",
                message: "封面图生成失败（跳过）",
                current: 1,
                total: 1,
              });
            }
          } catch (error) {
            sendEvent({
              type: "progress",
              phase: "global_config",
              message: `封面图生成异常（跳过）: ${
                error instanceof Error ? error.message : String(error)
              }`,
              current: 1,
              total: 1,
            });
          }
        }

        const existingRoles =
          mode === "append" ? await api.listGlobalRoles().catch(() => []) : [];
        const shouldGenerateDigitalHumanAvatar =
          options.digitalHumanAvatarMode === "ai";
        const avatarCredentials: PolymasCredentials = {
          authorization: authorization || "",
          cookie,
          userNid: userNid || undefined,
        };
        let reusableDigitalHumans: ReusableDigitalHuman[] = [];
        try {
          sendEvent({
            type: "progress",
            phase: "members",
            message: "查询已有数字人，优先复用同名配置...",
            current: 0,
            total: members.length,
          });
          const existingDigitalHumans = await api.listDigitalHumans({
            courseId: target.courseId,
            libraryFolderId: target.libraryId,
            userNid,
          });
          reusableDigitalHumans = existingDigitalHumans
            .map(toReusableDigitalHuman)
            .filter(Boolean) as ReusableDigitalHuman[];
          voiceCandidates.push(
            ...toVoiceCandidates(existingDigitalHumans, "digital-human"),
          );
          sendEvent({
            type: "progress",
            phase: "members",
            message: `已读取 ${existingDigitalHumans.length} 个已有数字人，其中 ${reusableDigitalHumans.length} 个可复用`,
            current: 0,
            total: members.length,
          });
        } catch (error) {
          sendEvent({
            type: "progress",
            phase: "members",
            message: `查询已有数字人失败，将仅在无可复用项时新建: ${
              error instanceof Error ? error.message : String(error)
            }`,
            current: 0,
            total: members.length,
          });
        }
        const memberNidMap: Record<string, string> = {};
        const resolvedRoles = new Map<string, CreatedOrResolvedRole>();

        for (let index = 0; index < members.length; index++) {
          const member = members[index];
          sendEvent({
            type: "progress",
            phase: "members",
            message: `创建成员: ${member.memberName} (${index + 1}/${members.length})`,
            current: index,
            total: members.length,
          });

          const existingRole =
            mode === "append"
              ? existingRoles.find(
                  (role) =>
                    !isSystemRole(role) &&
                    (role.roleName === member.memberName ||
                      role.nickname === member.memberName),
                )
              : undefined;
          let roleNid = existingRole?.nid || "";
          let role = existingRole;

          if (roleNid) {
            sendEvent({
              type: "progress",
              phase: "members",
              message: `  → 复用已有成员: ${member.memberName}(${roleNid})`,
              current: index,
              total: members.length,
            });
          } else {
            roleNid = await createGlobalMember(api, trainTaskId, member);
            role = {
              nid: roleNid,
              trainTaskNid: trainTaskId,
              roleName: member.memberName,
              nickname: member.memberName,
              description: member.roleDescription,
              prompt: member.roleDescription,
              modelCode: normalizeModelId(member.modelId),
            };
          }

          memberNidMap[member.memberName] = roleNid;

          const reusableDigitalHuman = findReusableDigitalHumanByName(
            reusableDigitalHumans,
            member.memberName,
          );
          let avatarNid =
            role?.avatarNid ||
            reusableDigitalHuman?.avatarNid ||
            pickAvatarNid(avatars, index);
          let generatedAvatarNid = "";

          if (shouldGenerateDigitalHumanAvatar) {
            sendEvent({
              type: "progress",
              phase: "members",
              message: `  → 正在为「${member.memberName}」生成并上传 AI 头像...`,
              current: index,
              total: members.length,
            });
            try {
              const generatedAvatar = await generateAndSyncDigitalHumanAvatar(
                {
                  trainName: globalConfig.abilityName || "能力训练 Pro",
                  trainDescription:
                    globalConfig.description || globalConfig.abilityName || "",
                  trainerName: member.memberName,
                  stageName: `${member.memberName} 数字人头像`,
                  stageDescription:
                    member.avatarDescription || member.roleDescription || "专业教学导师",
                  courseId: target.courseId,
                  libraryFolderId: target.libraryId,
                  baseAvatarNid: avatarNid || undefined,
                  avatarStylePrompt:
                    options.digitalHumanAvatarStylePrompt ||
                    member.avatarDescription ||
                    undefined,
                  imageModel: options.imageModel,
                  imageProviderPriority: ["openai"],
                  userNid: userNid || undefined,
                },
                avatarCredentials,
              );
              if (generatedAvatar?.avatarNid) {
                generatedAvatarNid = generatedAvatar.avatarNid;
                avatarNid = generatedAvatar.avatarNid;
                sendEvent({
                  type: "progress",
                  phase: "members",
                  message: `  → AI 头像已生成、上传并同步: ${member.memberName}(${generatedAvatar.avatarNid})`,
                  current: index,
                  total: members.length,
                });
              } else {
                sendEvent({
                  type: "progress",
                  phase: "members",
                  message: `  → AI 头像生成或同步失败，回退账号已有头像: ${member.memberName}`,
                  current: index,
                  total: members.length,
                });
              }
            } catch (error) {
              sendEvent({
                type: "progress",
                phase: "members",
                message: `  → AI 头像生成异常，回退账号已有头像: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                current: index,
                total: members.length,
              });
            }
          }

          if (
            !generatedAvatarNid &&
            reusableDigitalHuman &&
            role?.customDigitalHuman !== reusableDigitalHuman.customNid
          ) {
            sendEvent({
              type: "progress",
              phase: "members",
              message: `  → 复用已有同名数字人: ${reusableDigitalHuman.digitalHumanName}(${reusableDigitalHuman.customNid})`,
              current: index,
              total: members.length,
            });
            try {
              role = await patchGlobalMember(
                api,
                trainTaskId,
                role || {},
                member,
                {
                  nid: roleNid,
                  avatarNid: reusableDigitalHuman.avatarNid,
                  voiceNid: reusableDigitalHuman.voiceNid,
                  voiceType:
                    reusableDigitalHuman.voiceType || role?.voiceType || null,
                  customDigitalHuman: reusableDigitalHuman.customNid,
                },
              );
              avatarNid = reusableDigitalHuman.avatarNid;
            } catch (error) {
              sendEvent({
                type: "progress",
                phase: "members",
                message: `  → 同名数字人复用失败（跳过）: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                current: index,
                total: members.length,
              });
            }
          }

          if (
            avatarNid &&
            (generatedAvatarNid
              ? role?.avatarNid !== generatedAvatarNid
              : !role?.avatarNid)
          ) {
            sendEvent({
              type: "progress",
              phase: "members",
              message: `  → 分配头像: ${avatarNid}`,
              current: index,
              total: members.length,
            });
            try {
              role = await patchGlobalMember(
                api,
                trainTaskId,
                role || {},
                member,
                {
                  nid: roleNid,
                  avatarNid,
                },
              );
            } catch (error) {
              sendEvent({
                type: "progress",
                phase: "members",
                message: `  → 头像分配失败（跳过）: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                current: index,
                total: members.length,
              });
            }
          }

          const selectedVoice = selectBestVoiceCandidate(voiceCandidates, {
            preferredName: member.voiceName,
            roleName: member.memberName,
            roleDescription: member.roleDescription,
            avatarDescription: member.avatarDescription,
            fallbackToFirst: !reusableDigitalHuman && voiceCandidates.length > 0,
          });
          const fallbackVoice = reusableDigitalHuman?.voiceNid
            ? reusableDigitalHuman
            : null;
          const voiceNid =
            selectedVoice?.voiceNid ||
            fallbackVoice?.voiceNid ||
            voiceCandidates[0]?.voiceNid ||
            "";
          if (
            (Boolean(generatedAvatarNid) ||
              (!reusableDigitalHuman && !role?.customDigitalHuman)) &&
            voiceNid &&
            avatarNid
          ) {
            sendEvent({
              type: "progress",
              phase: "members",
              message: `  → 创建数字人: ${member.memberName}（音色: ${member.voiceName}）`,
              current: index,
              total: members.length,
            });
            try {
              const customDigitalHuman = await api.createCustomDigitalHuman({
                digitalHumanName: member.memberName,
                voiceNid,
                avatarNid,
              });
              role = await patchGlobalMember(
                api,
                trainTaskId,
                role || {},
                member,
                {
                  nid: roleNid,
                  avatarNid,
                  voiceNid,
                  voiceType:
                    selectedVoice?.voiceType ||
                    fallbackVoice?.voiceType ||
                    role?.voiceType,
                  customDigitalHuman,
                },
              );
            } catch (error) {
              sendEvent({
                type: "progress",
                phase: "members",
                message: `  → 数字人创建失败（跳过）: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                current: index,
                total: members.length,
              });
            }
          }

          resolvedRoles.set(roleNid, {
            nid: roleNid,
            member,
            existingRole: role || existingRole,
          });
        }

        sendEvent({
          type: "progress",
          phase: "members",
          message: `${members.length} 个成员创建完成`,
          current: members.length,
          total: members.length,
        });

        const skillsToInject: SkillWithMember[] = members.flatMap((member) =>
          member.skills.map((skill) => ({
            ...skill,
            memberName: member.memberName,
          })),
        );

        if (skillsToInject.length > 0) {
          let platformSkills = mergeSkillItems(
            preservedSkills,
            await api.listSkills().catch(() => []),
            getRoleSkills(await api.listGlobalRoles().catch(() => [])),
          );
          sendEvent({
            type: "progress",
            phase: "skills",
            message: `已读取 ${platformSkills.length} 个可复用技能，开始按名称匹配`,
            current: 0,
            total: skillsToInject.length,
          });
          const skillByName = new Map<string, PlatformSkillItem>();
          for (const skill of platformSkills) {
            const key = normalizeSkillName(getSkillDisplayName(skill));
            if (key && !skillByName.has(key)) skillByName.set(key, skill);
          }

          const roleSkillMap = new Map<string, Set<string>>();
          for (const [roleNid, roleInfo] of resolvedRoles) {
            const role = roleInfo.existingRole || {};
            const assigned = new Set<string>([
              ...parseSkillsValue(role.skills),
              ...(role.skillList || [])
                .map((item) => String(item.nid || ""))
                .filter(Boolean),
              ...platformSkills
                .filter((skill) => skill.globalRoleNid === roleNid)
                .map((skill) => String(skill.nid || ""))
                .filter(Boolean),
            ]);
            roleSkillMap.set(roleNid, assigned);
          }

          let createdCount = 0;
          let reusedCount = 0;

          for (let index = 0; index < skillsToInject.length; index++) {
            const skill = skillsToInject[index];
            const roleNid = memberNidMap[skill.memberName];
            if (!roleNid) {
              sendEvent({
                type: "progress",
                phase: "skills",
                message: `⚠️ 跳过技能 ${skill.skillName}：找不到成员 "${skill.memberName}" 的 nid`,
                current: index,
                total: skillsToInject.length,
              });
              continue;
            }

            sendEvent({
              type: "progress",
              phase: "skills",
              message: `创建技能: ${skill.skillName} → ${skill.memberName}(${roleNid}) (${index + 1}/${skillsToInject.length})`,
              current: index,
              total: skillsToInject.length,
            });

            const skillKey = normalizeSkillName(skill.skillName);
            try {
              const existingSkill =
                skillByName.get(skillKey) ||
                findReusableSkillByName(platformSkills, skill.skillName);
              let skillNid = existingSkill?.nid || "";
              if (skillNid) {
                reusedCount++;
                try {
                  await updateExistingSkill(
                    api,
                    trainTaskId,
                    skillNid,
                    skill,
                    skillTypeMap,
                  );
                } catch (error) {
                  sendEvent({
                    type: "progress",
                    phase: "skills",
                    message: `  → 已复用技能，但结构化指令更新失败: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                    current: index,
                    total: skillsToInject.length,
                  });
                }
                sendEvent({
                  type: "progress",
                  phase: "skills",
                  message: `  → 复用已有技能并同步指令: ${skill.skillName}`,
                  current: index,
                  total: skillsToInject.length,
                });
              } else {
                skillNid = await createAndApplySkill(
                  api,
                  trainTaskId,
                  skill,
                  skillTypeMap,
                );
                skillByName.set(skillKey, {
                  nid: skillNid,
                  name: skill.skillName,
                  description: skill.skillDescription || null,
                  packageName: skill.skillName,
                });
                createdCount++;
                sendEvent({
                  type: "progress",
                  phase: "skills",
                  message: `  → 技能已创建并应用: ${skill.skillName}(${skillNid})`,
                  current: index,
                  total: skillsToInject.length,
                });
              }

              const assigned = roleSkillMap.get(roleNid) || new Set<string>();
              if (skillNid) assigned.add(skillNid);
              roleSkillMap.set(roleNid, assigned);
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              const refreshedSkills = await api.listSkills().catch(() => []);
              const refreshedRoleSkills = getRoleSkills(
                await api.listGlobalRoles().catch(() => []),
              );
              platformSkills = mergeSkillItems(
                preservedSkills,
                platformSkills,
                refreshedSkills,
                refreshedRoleSkills,
              );
              const reusableSkill = findReusableSkillByName(
                platformSkills,
                skill.skillName,
              );
              const reusableSkillNid = reusableSkill?.nid || "";
              if (reusableSkill && reusableSkillNid) {
                reusedCount++;
                const reusableName = getSkillDisplayName(reusableSkill);
                skillByName.set(skillKey, reusableSkill);
                try {
                  await updateExistingSkill(
                    api,
                    trainTaskId,
                    reusableSkillNid,
                    skill,
                    skillTypeMap,
                  );
                } catch {
                  // 复用是主流程；历史技能不允许编辑时仍继续完成绑定。
                }
                const assigned = roleSkillMap.get(roleNid) || new Set<string>();
                assigned.add(reusableSkillNid);
                roleSkillMap.set(roleNid, assigned);
                sendEvent({
                  type: "progress",
                  phase: "skills",
                  message: `  → 创建失败，已改为复用已有技能并尝试同步指令: ${reusableName}(${reusableSkillNid})`,
                  current: index,
                  total: skillsToInject.length,
                });
              } else {
                sendEvent({
                  type: "progress",
                  phase: "skills",
                  message: `  → 技能创建失败（跳过）: ${errorMessage}`,
                  current: index,
                  total: skillsToInject.length,
                });
              }
            }
          }

          for (const [roleNid, skillNids] of roleSkillMap) {
            if (skillNids.size === 0) continue;
            const roleInfo = resolvedRoles.get(roleNid);
            await bindSkillsToRole({
              api,
              trainTaskId,
              roleNid,
              role: roleInfo?.existingRole || { nid: roleNid },
              member: roleInfo?.member,
              skillNids,
            });
          }

          sendEvent({
            type: "progress",
            phase: "skills",
            message: `技能配置完成：新建 ${createdCount} 个，复用 ${reusedCount} 个，已回写到对应成员`,
            current: skillsToInject.length,
            total: skillsToInject.length,
          });
        }

        const existingStepCount =
          mode === "append"
            ? (await api.listSteps().catch(() => [])).length
            : 0;
        let firstCreatedStepId = "";

        for (let index = 0; index < stages.length; index++) {
          const stage = stages[index];
          sendEvent({
            type: "progress",
            phase: "stages",
            message: `创建阶段: ${stage.cardName} (${index + 1}/${stages.length})`,
            current: index,
            total: stages.length,
          });

          let backgroundImageUrl: string | null = null;
          if (
            options.injectBackgroundImage &&
            stage.backgroundImageDescription
          ) {
            sendEvent({
              type: "progress",
              phase: "stages",
              message: `  → 生成背景图: ${stage.cardName}`,
              current: index,
              total: stages.length,
            });
            try {
              const backgroundImage = await generateAndUploadImage(
                cookie,
                {
                  trainName: globalConfig.abilityName,
                  trainDescription:
                    globalConfig.description || globalConfig.abilityName,
                  stageName: stage.cardName,
                  stageDescription: `${stage.backgroundImageDescription}
背景风格要求：${options.backgroundStylePrompt}`,
                },
                options.imageProviderMode,
                options.imageModel,
              );
              if (backgroundImage) {
                backgroundImageUrl = backgroundImage.fileUrl;
                sendEvent({
                  type: "progress",
                  phase: "stages",
                  message: "  → 背景图已生成",
                  current: index,
                  total: stages.length,
                });
              } else {
                sendEvent({
                  type: "progress",
                  phase: "stages",
                  message: "  → 背景图生成失败（跳过）",
                  current: index,
                  total: stages.length,
                });
              }
            } catch (error) {
              sendEvent({
                type: "progress",
                phase: "stages",
                message: `  → 背景图异常（跳过）: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                current: index,
                total: stages.length,
              });
            }
          }

          const stageId = await createStage(
            api,
            trainTaskId,
            stage,
            memberNidMap,
            buildStagePosition(existingStepCount + index),
            backgroundImageUrl,
          );
          if (index === 0) firstCreatedStepId = stageId;
        }

        const existingFirstStepId = parseExistingFirstStepId(taskDetail);
        if (firstCreatedStepId && (mode === "fresh" || !existingFirstStepId)) {
          await api.editTask({
            trainTaskId,
            trainTaskName: globalConfig.abilityName,
            firstStepId: firstCreatedStepId,
          });
          sendEvent({
            type: "progress",
            phase: "stages",
            message: `已将「${stages[0]?.cardName || "首个阶段"}」设为初始阶段`,
            current: stages.length,
            total: stages.length,
          });
        }

        sendEvent({
          type: "progress",
          phase: "stages",
          message: `${stages.length} 个阶段创建完成`,
          current: stages.length,
          total: stages.length,
        });
        sendEvent({
          type: "complete",
          message: `注入完成！共处理 ${members.length} 个成员、${skillsToInject.length} 个技能、${stages.length} 个阶段。`,
        });
      } catch (error) {
        sendEvent({
          type: "error",
          message: `注入失败: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
