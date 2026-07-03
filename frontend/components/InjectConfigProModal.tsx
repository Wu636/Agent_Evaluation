"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  X,
  Shield,
  Key,
  FilePlus,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Play,
  Upload,
  ChevronDown,
  ChevronRight,
  FileText,
  RefreshCw,
  Image as ImageIcon,
  Trash2,
  ListChecks,
} from "lucide-react";
import { AVAILABLE_MODELS } from "@/lib/config";
import {
  DEFAULT_IMAGE_MODEL,
  LLM_SETTINGS_STORAGE_KEY,
  loadLLMSettingsFromStorage,
} from "@/lib/llm/settings";

interface InjectConfigProModalProps {
  markdown: string;
  onClose: () => void;
}

const STORAGE_KEY = "training-injector-pro-credentials";
const BASIC_INJECTOR_STORAGE_KEY = "training-injector-credentials";

const IMAGE_PROVIDER_OPTIONS = [
  { id: "cloudapi", name: "cloudapi（优先）" },
  { id: "openai", name: "OpenAI 兼容接口（优先）" },
];
const IMAGE_MODEL_OPTIONS = [
  {
    id: "doubao-seedream-5-0-260128",
    name: "豆包 Seedream 5.0",
    description: "推荐默认生图模型",
  },
  {
    id: "doubao-seedream-4-0-250828",
    name: "豆包 Seedream 4.0",
    description: "兼容的 Seedream 生图模型",
  },
  { id: "dall-e-3", name: "DALL-E 3", description: "OpenAI 图像生成模型" },
  {
    id: "gpt-image-1.5",
    name: "GPT Image 1.5",
    description: "OpenAI 图像生成模型",
  },
];

interface ProCredentials {
  authorization: string;
  cookie: string;
  userNid: string;
  targetUrl: string;
}

function loadStoredCredentials(): ProCredentials {
  const empty = { authorization: "", cookie: "", userNid: "", targetUrl: "" };
  if (typeof window === "undefined") return empty;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const basicRaw = localStorage.getItem(BASIC_INJECTOR_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const basicParsed = basicRaw ? JSON.parse(basicRaw) : {};
    const shouldUseBasicCredentials =
      basicParsed.authorization &&
      basicParsed.cookie &&
      (!parsed.authorization || !parsed.cookie);
    return {
      authorization: shouldUseBasicCredentials
        ? basicParsed.authorization
        : parsed.authorization || basicParsed.authorization || "",
      cookie: shouldUseBasicCredentials
        ? basicParsed.cookie
        : parsed.cookie || basicParsed.cookie || "",
      userNid: parsed.userNid || basicParsed.userNid || "",
      targetUrl: parsed.targetUrl || "",
    };
  } catch {
    return empty;
  }
}

function saveCredentials(creds: ProCredentials) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
}

interface ProProgressLog {
  type: "start" | "progress" | "complete" | "error";
  message: string;
  phase?: string;
  current?: number;
  total?: number;
}

interface ProSummary {
  membersCreated: number;
  skillsCreated: number;
  stagesCreated: number;
  digitalHumansCreated: number;
}

interface ManagedSkill {
  nid: string;
  name: string;
  packageName?: string;
  typeNid?: string;
  description?: string;
  roleNames?: string[];
}

interface ManagedDigitalHuman {
  customNid: string;
  name: string;
  avatarUrl?: string;
  canDelete: boolean;
  roleNames?: string[];
}

function normalizeManagedSkillName(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_\-()（）【】]+/g, "");
}

export function InjectConfigProModal({
  markdown,
  onClose,
}: InjectConfigProModalProps) {
  const stored = loadStoredCredentials();

  // ─── 表单状态 ──────────────────────────────────────────────
  const [authorization, setAuthorization] = useState(stored.authorization);
  const [cookie, setCookie] = useState(stored.cookie);
  const [userNid, setUserNid] = useState(stored.userNid);
  const [targetUrl, setTargetUrl] = useState(stored.targetUrl);
  const [mode, setMode] = useState<"fresh" | "append">("fresh");

  // 图片相关
  const [coverStylePrompt, setCoverStylePrompt] = useState(
    "图中禁止有任何文字和英文单词！写实风格，专业级渲染，电影级光影，高清细节，16:9宽屏构图，尽量不要出现西方面孔",
  );
  const [backgroundStylePrompt, setBackgroundStylePrompt] = useState(
    "图中禁止有任何文字和英文单词！写实风格，专业级渲染，电影级光影，16:9宽屏构图，单一完整场景，适合作为教学阶段背景，尽量不要出现西方面孔",
  );
  const [digitalHumanAvatarMode, setDigitalHumanAvatarMode] = useState<
    "existing" | "ai"
  >("existing");
  const [digitalHumanAvatarStylePrompt, setDigitalHumanAvatarStylePrompt] =
    useState(
      "必须是清晰可见的人类导师头像，有完整头部、脸部、颈部和肩部；专业教学数字人头像，单人正面半身，亲切可信，干净背景；不要空教室、会议室、室内场景图、文字、logo、水印、多人合影",
    );
  const [imageProviderMode, setImageProviderMode] = useState<
    "cloudapi" | "openai"
  >("cloudapi");
  const [imageModel, setImageModel] = useState(DEFAULT_IMAGE_MODEL);
  const [injectCoverImage, setInjectCoverImage] = useState(true);
  const [injectBackgroundImage, setInjectBackgroundImage] = useState(true);

  // 注入过程状态
  const [injecting, setInjecting] = useState(false);
  const [progressLogs, setProgressLogs] = useState<ProProgressLog[]>([]);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<ProSummary | null>(null);

  // 已有技能管理
  const [skillManagerExpanded, setSkillManagerExpanded] = useState(false);
  const [managedSkills, setManagedSkills] = useState<ManagedSkill[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(
    new Set(),
  );
  const [skillManagerLoading, setSkillManagerLoading] = useState(false);
  const [skillManagerDeleting, setSkillManagerDeleting] = useState(false);
  const [skillManagerError, setSkillManagerError] = useState("");
  const [skillManagerMessage, setSkillManagerMessage] = useState("");

  // 已有数字人管理
  const [digitalHumanManagerExpanded, setDigitalHumanManagerExpanded] =
    useState(false);
  const [managedDigitalHumans, setManagedDigitalHumans] = useState<
    ManagedDigitalHuman[]
  >([]);
  const [selectedDigitalHumanIds, setSelectedDigitalHumanIds] = useState<
    Set<string>
  >(new Set());
  const [digitalHumanManagerLoading, setDigitalHumanManagerLoading] =
    useState(false);
  const [digitalHumanManagerDeleting, setDigitalHumanManagerDeleting] =
    useState(false);
  const [digitalHumanManagerError, setDigitalHumanManagerError] = useState("");
  const [digitalHumanManagerMessage, setDigitalHumanManagerMessage] =
    useState("");

  // Markdown 审阅与修正
  const [customDocExpanded, setCustomDocExpanded] = useState(false);
  const [customMarkdown, setCustomMarkdown] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // 加载 LLM 设置
  useEffect(() => {
    const settings = loadLLMSettingsFromStorage("default");
    if (settings.imageModel) setImageModel(settings.imageModel);
  }, []);

  // 自动滚动到日志底部
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [progressLogs]);

  const hasCustomDoc = customMarkdown.trim().length > 0;
  const effectiveMarkdown = hasCustomDoc ? customMarkdown : markdown;

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setCustomMarkdown(text || "");
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const validateSkillManagerCredentials = () => {
    if (!authorization.trim() || !cookie.trim()) {
      setSkillManagerError(
        "请先填写 Authorization 和 Cookie（与注入共用凭证）",
      );
      return false;
    }
    if (!targetUrl.trim()) {
      setSkillManagerError("请先填写目标 Pro 训练页面 URL");
      return false;
    }
    return true;
  };

  const requestSkillManager = async (
    action: "list-skills" | "delete-skills",
    skillIds?: string[],
  ) => {
    const response = await fetch("/api/training-inject-pro", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        targetUrl,
        authorization,
        cookie,
        credentials: {
          authorization: authorization.trim(),
          cookie: cookie.trim(),
          userNid: userNid.trim() || undefined,
        },
        skillIds,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `技能管理请求失败: ${response.status}`);
    }
    return data;
  };

  const loadManagedSkills = async () => {
    if (!validateSkillManagerCredentials()) return;
    saveCredentials({ authorization, cookie, userNid, targetUrl });
    setSkillManagerLoading(true);
    setSkillManagerError("");
    setSkillManagerMessage("");
    try {
      const data = await requestSkillManager("list-skills");
      const skills = Array.isArray(data.skills) ? data.skills : [];
      setManagedSkills(skills);
      setSelectedSkillIds(new Set());
      setSkillManagerMessage(`已读取 ${skills.length} 个技能`);
    } catch (err) {
      setSkillManagerError((err as Error).message || "技能列表读取失败");
    } finally {
      setSkillManagerLoading(false);
    }
  };

  const selectDuplicateSkills = () => {
    const grouped = new Map<string, ManagedSkill[]>();
    for (const skill of managedSkills) {
      const key = normalizeManagedSkillName(
        skill.name || skill.packageName || "",
      );
      if (!key) continue;
      const current = grouped.get(key) || [];
      current.push(skill);
      grouped.set(key, current);
    }
    const duplicates = new Set<string>();
    for (const group of grouped.values()) {
      for (const skill of group.slice(1)) duplicates.add(skill.nid);
    }
    setSelectedSkillIds(duplicates);
    setSkillManagerMessage(
      duplicates.size > 0
        ? `已选中 ${duplicates.size} 个同名重复技能（每组保留第一个）`
        : "没有发现同名重复技能",
    );
  };

  const deleteSelectedSkills = async () => {
    const skillIds = Array.from(selectedSkillIds);
    if (skillIds.length === 0 || !validateSkillManagerCredentials()) return;
    const confirmed = window.confirm(
      `确定删除选中的 ${skillIds.length} 个技能吗？\n\n如果技能已关联成员，会先从成员上解绑。此操作不可撤销。`,
    );
    if (!confirmed) return;

    setSkillManagerDeleting(true);
    setSkillManagerError("");
    setSkillManagerMessage("");
    try {
      const data = await requestSkillManager("delete-skills", skillIds);
      const deleted = Array.isArray(data.deleted) ? data.deleted : [];
      const failed = Array.isArray(data.failed) ? data.failed : [];
      setManagedSkills((current) =>
        current.filter((skill) => !deleted.includes(skill.nid)),
      );
      setSelectedSkillIds(new Set());
      setSkillManagerMessage(`已删除 ${deleted.length} 个技能`);
      if (failed.length > 0) {
        setSkillManagerError(
          `${failed.length} 个技能删除失败：${failed
            .map(
              (item: { nid?: string; error?: string }) =>
                `${item.nid || "未知"}: ${item.error || "未知错误"}`,
            )
            .join("\n")}`,
        );
      }
    } catch (err) {
      setSkillManagerError((err as Error).message || "技能删除失败");
    } finally {
      setSkillManagerDeleting(false);
    }
  };

  const requestDigitalHumanManager = async (
    action: "list-digital-humans" | "delete-digital-humans",
    digitalHumanIds?: string[],
  ) => {
    const response = await fetch("/api/training-inject-pro", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        targetUrl,
        authorization,
        cookie,
        credentials: {
          authorization: authorization.trim(),
          cookie: cookie.trim(),
          userNid: userNid.trim() || undefined,
        },
        digitalHumanIds,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `数字人管理请求失败: ${response.status}`);
    }
    return data;
  };

  const loadManagedDigitalHumans = async () => {
    if (!validateSkillManagerCredentials()) return;
    saveCredentials({ authorization, cookie, userNid, targetUrl });
    setDigitalHumanManagerLoading(true);
    setDigitalHumanManagerError("");
    setDigitalHumanManagerMessage("");
    try {
      const data = await requestDigitalHumanManager("list-digital-humans");
      const digitalHumans = Array.isArray(data.digitalHumans)
        ? data.digitalHumans
        : [];
      setManagedDigitalHumans(digitalHumans);
      setSelectedDigitalHumanIds(new Set());
      setDigitalHumanManagerMessage(
        `已读取 ${digitalHumans.length} 个数字人，其中 ${digitalHumans.filter((item: ManagedDigitalHuman) => item.canDelete).length} 个可删除`,
      );
    } catch (err) {
      setDigitalHumanManagerError(
        (err as Error).message || "数字人列表读取失败",
      );
    } finally {
      setDigitalHumanManagerLoading(false);
    }
  };

  const selectDuplicateDigitalHumans = () => {
    const grouped = new Map<string, ManagedDigitalHuman[]>();
    for (const item of managedDigitalHumans) {
      if (!item.canDelete) continue;
      const key = normalizeManagedSkillName(item.name);
      if (!key) continue;
      const current = grouped.get(key) || [];
      current.push(item);
      grouped.set(key, current);
    }
    const duplicates = new Set<string>();
    for (const group of grouped.values()) {
      // 优先保留已经绑定成员的数字人。
      const ordered = [...group].sort(
        (left, right) =>
          Number((right.roleNames || []).length > 0) -
          Number((left.roleNames || []).length > 0),
      );
      for (const item of ordered.slice(1)) duplicates.add(item.customNid);
    }
    setSelectedDigitalHumanIds(duplicates);
    setDigitalHumanManagerMessage(
      duplicates.size > 0
        ? `已选中 ${duplicates.size} 个同名重复数字人（优先保留已绑定项）`
        : "没有发现可删除的同名重复数字人",
    );
  };

  const deleteSelectedDigitalHumans = async () => {
    const digitalHumanIds = Array.from(selectedDigitalHumanIds);
    if (digitalHumanIds.length === 0 || !validateSkillManagerCredentials())
      return;
    const confirmed = window.confirm(
      `确定删除选中的 ${digitalHumanIds.length} 个自定义数字人吗？\n\n如果数字人已关联成员，会先从成员上解绑。此操作不可撤销。`,
    );
    if (!confirmed) return;

    setDigitalHumanManagerDeleting(true);
    setDigitalHumanManagerError("");
    setDigitalHumanManagerMessage("");
    try {
      const data = await requestDigitalHumanManager(
        "delete-digital-humans",
        digitalHumanIds,
      );
      const deleted = Array.isArray(data.deleted) ? data.deleted : [];
      const failed = Array.isArray(data.failed) ? data.failed : [];
      setManagedDigitalHumans((current) =>
        current.filter((item) => !deleted.includes(item.customNid)),
      );
      setSelectedDigitalHumanIds(new Set());
      setDigitalHumanManagerMessage(`已删除 ${deleted.length} 个数字人`);
      if (failed.length > 0) {
        setDigitalHumanManagerError(
          `${failed.length} 个数字人删除失败：${failed
            .map(
              (item: { customNid?: string; error?: string }) =>
                `${item.customNid || "未知"}: ${item.error || "未知错误"}`,
            )
            .join("\n")}`,
        );
      }
    } catch (err) {
      setDigitalHumanManagerError((err as Error).message || "数字人删除失败");
    } finally {
      setDigitalHumanManagerDeleting(false);
    }
  };

  const handleInject = async () => {
    if (!authorization.trim() || !cookie.trim()) {
      setError("请填写 Authorization 和 Cookie（与基础版注入凭证一致）");
      return;
    }
    if (!targetUrl.trim()) {
      setError("请输入目标 Pro 训练页面 URL");
      return;
    }

    saveCredentials({ authorization, cookie, userNid, targetUrl });
    setInjecting(true);
    setProgressLogs([]);
    setError("");
    setSummary(null);

    try {
      const response = await fetch("/api/training-inject-pro", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          markdown: effectiveMarkdown,
          targetUrl,
          authorization,
          cookie,
          credentials: {
            authorization: authorization.trim(),
            cookie: cookie.trim(),
            userNid: userNid.trim() || undefined,
          },
          mode,
          coverStylePrompt,
          backgroundStylePrompt,
          digitalHumanAvatarMode,
          digitalHumanAvatarStylePrompt,
          imageProviderMode,
          imageModel,
          injectCoverImage,
          injectBackgroundImage,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `注入失败: ${response.status}`);
      }

      // SSE 读取
      const reader = response.body?.getReader();
      if (!reader) throw new Error("无法读取响应流");

      const decoder = new TextDecoder();
      let buffer = "";
      let membersCount = 0;
      let skillsCount = 0;
      let stagesCount = 0;
      let digitalHumansCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(trimmed.slice(6));
            if (data.type === "start") {
              setProgressLogs((prev) => [
                ...prev,
                { type: "start", message: data.message },
              ]);
            } else if (data.type === "progress") {
              setProgressLogs((prev) => [
                ...prev,
                {
                  type: "progress",
                  message: data.message,
                  phase: data.phase,
                  current: data.current,
                  total: data.total,
                },
              ]);
              // 统计创建数量
              if (
                data.message?.includes("创建成员") ||
                data.message?.includes("成员创建完成")
              ) {
                const m = data.message?.match(/(\d+)\s*个成员/);
                if (m) membersCount = parseInt(m[1]);
              }
              if (
                data.message?.includes("技能") &&
                data.message?.includes("完成")
              ) {
                const m = data.message?.match(/(\d+)\s*个技能/);
                if (m) skillsCount = parseInt(m[1]);
              }
              if (data.message?.includes("阶段创建完成")) {
                const m = data.message?.match(/(\d+)\s*个阶段/);
                if (m) stagesCount = parseInt(m[1]);
              }
              if (data.message?.includes("数字人")) {
                digitalHumansCount++;
              }
            } else if (data.type === "complete") {
              setProgressLogs((prev) => [
                ...prev,
                { type: "complete", message: data.message },
              ]);
              setSummary({
                membersCreated: membersCount,
                skillsCreated: skillsCount,
                stagesCreated: stagesCount,
                digitalHumansCreated: digitalHumansCount,
              });
            } else if (data.type === "error") {
              throw new Error(data.message);
            }
          } catch (e) {
            if (e instanceof Error && e.message !== "注入失败") throw e;
          }
        }
      }
    } catch (err) {
      setError((err as Error).message || "注入过程发生错误");
    } finally {
      setInjecting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl flex flex-col max-h-[90vh] overflow-hidden animate-in zoom-in-95">
        {/* Header */}
        <div className="bg-gradient-to-r from-indigo-600 to-violet-600 px-6 py-4 flex items-center justify-between text-white shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
              <Play className="w-5 h-5 fill-white" />
            </div>
            <div>
              <h2 className="text-xl font-bold">一键注入到智慧树 Pro 平台</h2>
              <p className="text-indigo-100 text-xs mt-0.5">
                将 Pro 配置自动创建为能力训练节点
              </p>
            </div>
          </div>
          {!injecting && (
            <button
              onClick={onClose}
              className="p-2 hover:bg-white/10 rounded-xl transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* 错误提示 */}
          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
              <div className="text-sm text-red-700 font-medium whitespace-pre-wrap">
                {error}
              </div>
            </div>
          )}

          {/* 配置区域 (注入中隐藏) */}
          {!injecting && !summary && (
            <>
              {/* 平台认证凭证 */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <Shield className="w-4 h-4 text-slate-500" />
                  <h3 className="font-semibold text-slate-700 text-sm">
                    平台认证凭证 (polymas.com)
                  </h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-medium text-slate-600 block mb-1.5 flex items-center gap-1">
                      <Key className="w-3.5 h-3.5" />
                      Authorization <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="password"
                      value={authorization}
                      onChange={(e) => setAuthorization(e.target.value)}
                      placeholder="Bearer eyJhbGciOi...（与基础版一致）"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 font-mono"
                    />
                    <p className="text-xs text-slate-400 mt-1.5">
                      从 Request Headers 里复制 Authorization；如果粘整段
                      headers 到 Cookie 框，也会自动解析。
                    </p>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-600 block mb-1.5 flex items-center gap-1">
                      <Key className="w-3.5 h-3.5" />
                      Cookie <span className="text-red-500">*</span>
                    </label>
                    <textarea
                      value={cookie}
                      onChange={(e) => setCookie(e.target.value)}
                      placeholder="SESSION=...; ai-poly=...（也可以直接粘完整 Request Headers）"
                      rows={3}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 font-mono resize-y"
                    />
                    <p className="text-xs text-slate-400 mt-1.5">
                      打开浏览器开发者工具 → Network → 选择任意
                      cloudapi.polymas.com 请求 → 复制 Request Headers 中的
                      Cookie 值
                    </p>
                  </div>
                </div>
                <p className="text-xs text-slate-400 flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5" />
                  凭证仅保存在本地浏览器中；Pro 版会优先使用
                  Authorization，缺省时再尝试从 Cookie 的 ai-poly 解析 JWT
                </p>
              </div>

              {/* 注入目标 */}
              <div className="bg-white border border-slate-200 shadow-sm rounded-xl p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <FilePlus className="w-4 h-4 text-indigo-500" />
                  <h3 className="font-semibold text-slate-700 text-sm">
                    注入目标配置
                  </h3>
                </div>

                <div>
                  <label className="text-xs font-medium text-slate-700 block mb-1.5">
                    目标 Pro 训练页面 URL{" "}
                    <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={targetUrl}
                    onChange={(e) => setTargetUrl(e.target.value)}
                    placeholder="https://hike-teaching-center.polymas.com/tch-hike/agent-course-full/.../ability-training-pro/..."
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                  />
                  <p className="text-xs text-slate-400 mt-1.5">
                    从浏览器地址栏复制能力训练 Pro 编辑页面的完整 URL
                  </p>
                </div>

                {/* 注入模式 */}
                <div className="pt-3 border-t border-slate-100 space-y-3">
                  <label className="text-xs font-medium text-slate-700 block">
                    注入模式
                  </label>
                  <div className="flex flex-col gap-2">
                    <label
                      className={`p-2 border rounded-lg cursor-pointer transition-colors ${mode === "fresh" ? "border-indigo-500 bg-indigo-50/50" : "hover:bg-slate-50 border-slate-200"}`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <input
                          type="radio"
                          checked={mode === "fresh"}
                          onChange={() => setMode("fresh")}
                          className="text-indigo-600 focus:ring-indigo-500"
                        />
                        <span className="text-sm font-medium text-slate-800">
                          全部清除后重建 (推荐)
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 pl-6">
                        将会重建成员和阶段，已有同名技能会保留并复用，避免重复创建。
                      </p>
                    </label>
                    <label
                      className={`p-2 border rounded-lg cursor-pointer transition-colors ${mode === "append" ? "border-indigo-500 bg-indigo-50/50" : "hover:bg-slate-50 border-slate-200"}`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <input
                          type="radio"
                          checked={mode === "append"}
                          onChange={() => setMode("append")}
                          className="text-indigo-600 focus:ring-indigo-500"
                        />
                        <span className="text-sm font-medium text-slate-800">
                          在现有配置后追加
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 pl-6">
                        保留原有的配置，只是新增成员、技能和阶段。
                      </p>
                    </label>
                  </div>
                </div>
              </div>

              {/* 已有技能管理 */}
              <div className="bg-white border border-slate-200 shadow-sm rounded-xl p-5">
                <button
                  type="button"
                  onClick={() => setSkillManagerExpanded((value) => !value)}
                  className="flex items-center gap-2 w-full text-left group"
                >
                  {skillManagerExpanded ? (
                    <ChevronDown className="w-4 h-4 text-slate-400 group-hover:text-indigo-500" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-500" />
                  )}
                  <ListChecks className="w-4 h-4 text-indigo-500" />
                  <span className="font-semibold text-slate-700 text-sm">
                    已有技能管理
                  </span>
                  {managedSkills.length > 0 && (
                    <span className="ml-auto text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
                      {managedSkills.length} 个
                    </span>
                  )}
                </button>

                {skillManagerExpanded && (
                  <div className="mt-4 space-y-3">
                    <p className="text-xs text-slate-500">
                      使用上方的目标 URL
                      和认证凭证读取技能。删除已关联技能时，会先从对应成员上解绑。
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={loadManagedSkills}
                        disabled={skillManagerLoading || skillManagerDeleting}
                        className="px-3 py-1.5 text-xs font-medium border border-indigo-200 rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 flex items-center gap-1.5"
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 ${skillManagerLoading ? "animate-spin" : ""}`}
                        />
                        读取技能列表
                      </button>
                      <button
                        type="button"
                        onClick={selectDuplicateSkills}
                        disabled={
                          managedSkills.length === 0 || skillManagerDeleting
                        }
                        className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        选中同名重复项
                      </button>
                      <button
                        type="button"
                        onClick={deleteSelectedSkills}
                        disabled={
                          selectedSkillIds.size === 0 || skillManagerDeleting
                        }
                        className="px-3 py-1.5 text-xs font-medium border border-rose-200 rounded-lg bg-rose-50 text-rose-700 hover:bg-rose-100 disabled:opacity-50 flex items-center gap-1.5"
                      >
                        {skillManagerDeleting ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                        删除已选（{selectedSkillIds.size}）
                      </button>
                    </div>
                    {skillManagerMessage && (
                      <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
                        {skillManagerMessage}
                      </div>
                    )}
                    {skillManagerError && (
                      <div className="text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2 whitespace-pre-wrap">
                        {skillManagerError}
                      </div>
                    )}

                    {managedSkills.length > 0 && (
                      <div className="border border-slate-200 rounded-xl overflow-hidden max-h-80 overflow-y-auto">
                        {managedSkills.map((skill) => {
                          const sameNameCount = managedSkills.filter(
                            (item) =>
                              normalizeManagedSkillName(item.name) ===
                              normalizeManagedSkillName(skill.name),
                          ).length;
                          return (
                            <label
                              key={skill.nid}
                              className="flex items-start gap-3 px-3 py-2.5 border-b last:border-b-0 border-slate-100 hover:bg-slate-50 cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={selectedSkillIds.has(skill.nid)}
                                onChange={(event) => {
                                  setSelectedSkillIds((current) => {
                                    const next = new Set(current);
                                    if (event.target.checked) {
                                      next.add(skill.nid);
                                    } else {
                                      next.delete(skill.nid);
                                    }
                                    return next;
                                  });
                                }}
                                className="mt-1 rounded text-indigo-600 focus:ring-indigo-500"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-sm font-medium text-slate-800">
                                    {skill.name}
                                  </span>
                                  {sameNameCount > 1 && (
                                    <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">
                                      同名 {sameNameCount} 个
                                    </span>
                                  )}
                                  {(skill.roleNames || []).length > 0 && (
                                    <span className="text-[10px] bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded">
                                      已关联：{skill.roleNames?.join("、")}
                                    </span>
                                  )}
                                </div>
                                <div className="text-[11px] text-slate-400 font-mono mt-0.5 break-all">
                                  {skill.nid}
                                  {skill.typeNid ? ` · ${skill.typeNid}` : ""}
                                </div>
                                {skill.description && (
                                  <p className="text-xs text-slate-500 mt-1 line-clamp-2">
                                    {skill.description}
                                  </p>
                                )}
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 已有数字人管理 */}
              <div className="bg-white border border-slate-200 shadow-sm rounded-xl p-5">
                <button
                  type="button"
                  onClick={() =>
                    setDigitalHumanManagerExpanded((value) => !value)
                  }
                  className="flex items-center gap-2 w-full text-left group"
                >
                  {digitalHumanManagerExpanded ? (
                    <ChevronDown className="w-4 h-4 text-slate-400 group-hover:text-indigo-500" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-500" />
                  )}
                  <ImageIcon className="w-4 h-4 text-violet-500" />
                  <span className="font-semibold text-slate-700 text-sm">
                    已有数字人管理
                  </span>
                  {managedDigitalHumans.length > 0 && (
                    <span className="ml-auto text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
                      {managedDigitalHumans.length} 个
                    </span>
                  )}
                </button>

                {digitalHumanManagerExpanded && (
                  <div className="mt-4 space-y-3">
                    <p className="text-xs text-slate-500">
                      平台只允许删除当前账号创建且标记为可删除的自定义数字人。已关联成员的项目会先解绑。
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={loadManagedDigitalHumans}
                        disabled={
                          digitalHumanManagerLoading ||
                          digitalHumanManagerDeleting
                        }
                        className="px-3 py-1.5 text-xs font-medium border border-violet-200 rounded-lg bg-violet-50 text-violet-700 hover:bg-violet-100 disabled:opacity-50 flex items-center gap-1.5"
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 ${digitalHumanManagerLoading ? "animate-spin" : ""}`}
                        />
                        读取数字人列表
                      </button>
                      <button
                        type="button"
                        onClick={selectDuplicateDigitalHumans}
                        disabled={
                          managedDigitalHumans.length === 0 ||
                          digitalHumanManagerDeleting
                        }
                        className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        选中同名重复项
                      </button>
                      <button
                        type="button"
                        onClick={deleteSelectedDigitalHumans}
                        disabled={
                          selectedDigitalHumanIds.size === 0 ||
                          digitalHumanManagerDeleting
                        }
                        className="px-3 py-1.5 text-xs font-medium border border-rose-200 rounded-lg bg-rose-50 text-rose-700 hover:bg-rose-100 disabled:opacity-50 flex items-center gap-1.5"
                      >
                        {digitalHumanManagerDeleting ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                        删除已选（{selectedDigitalHumanIds.size}）
                      </button>
                    </div>

                    {digitalHumanManagerMessage && (
                      <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
                        {digitalHumanManagerMessage}
                      </div>
                    )}
                    {digitalHumanManagerError && (
                      <div className="text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2 whitespace-pre-wrap">
                        {digitalHumanManagerError}
                      </div>
                    )}

                    {managedDigitalHumans.length > 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-96 overflow-y-auto">
                        {managedDigitalHumans.map((item) => {
                          const sameNameCount = managedDigitalHumans.filter(
                            (candidate) =>
                              normalizeManagedSkillName(candidate.name) ===
                              normalizeManagedSkillName(item.name),
                          ).length;
                          return (
                            <label
                              key={item.customNid}
                              className={`flex items-center gap-3 rounded-xl border p-3 ${item.canDelete ? "border-slate-200 hover:bg-slate-50 cursor-pointer" : "border-slate-100 bg-slate-50 opacity-60 cursor-not-allowed"}`}
                            >
                              <input
                                type="checkbox"
                                disabled={!item.canDelete}
                                checked={selectedDigitalHumanIds.has(
                                  item.customNid,
                                )}
                                onChange={(event) => {
                                  setSelectedDigitalHumanIds((current) => {
                                    const next = new Set(current);
                                    if (event.target.checked) {
                                      next.add(item.customNid);
                                    } else {
                                      next.delete(item.customNid);
                                    }
                                    return next;
                                  });
                                }}
                                className="rounded text-violet-600 focus:ring-violet-500"
                              />
                              {item.avatarUrl ? (
                                <img
                                  src={item.avatarUrl}
                                  alt=""
                                  className="w-11 h-11 rounded-lg object-cover bg-slate-100"
                                />
                              ) : (
                                <div className="w-11 h-11 rounded-lg bg-slate-100" />
                              )}
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="text-sm font-medium text-slate-800 truncate">
                                    {item.name}
                                  </span>
                                  {sameNameCount > 1 && (
                                    <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">
                                      同名 {sameNameCount}
                                    </span>
                                  )}
                                </div>
                                <div className="text-[10px] text-slate-400 font-mono truncate">
                                  {item.customNid}
                                </div>
                                <div className="text-[10px] mt-0.5 text-slate-500">
                                  {item.canDelete
                                    ? "可删除"
                                    : "平台保护，不可删除"}
                                  {(item.roleNames || []).length > 0
                                    ? ` · 已关联 ${item.roleNames?.join("、")}`
                                    : ""}
                                </div>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 图片与数字人配置 */}
              <div className="bg-white border border-slate-200 shadow-sm rounded-xl p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <ImageIcon className="w-4 h-4 text-indigo-500" />
                  <h3 className="font-semibold text-slate-700 text-sm">
                    图片与数字人配置
                  </h3>
                </div>

                {/* 封面图风格 */}
                <div className="space-y-2">
                  <label className="text-xs font-medium text-slate-700 block">
                    课程封面图风格（可选）
                  </label>
                  <input
                    type="text"
                    value={coverStylePrompt}
                    onChange={(e) => setCoverStylePrompt(e.target.value)}
                    placeholder="例如：蓝白医疗风、极简科技感、无人物、留标题区"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                  />
                  <p className="text-xs text-slate-400">
                    仅影响课程封面图，不影响阶段背景图。
                  </p>
                </div>

                {/* 背景图风格 */}
                <div className="pt-3 border-t border-slate-100 space-y-2">
                  <label className="text-xs font-medium text-slate-700 block">
                    阶段背景图风格（可选）
                  </label>
                  <input
                    type="text"
                    value={backgroundStylePrompt}
                    onChange={(e) => setBackgroundStylePrompt(e.target.value)}
                    placeholder="例如：现代医学实训室、暖色教学空间、少人物、干净写实"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                  />
                  <p className="text-xs text-slate-400">
                    仅影响阶段背景图，不影响课程封面图。
                  </p>
                </div>

                {/* 生图方式 */}
                <div className="pt-3 border-t border-slate-100 space-y-2">
                  <label className="text-xs font-medium text-slate-700 block">
                    生图方式
                  </label>
                  <select
                    value={imageProviderMode}
                    onChange={(e) =>
                      setImageProviderMode(
                        e.target.value as "cloudapi" | "openai",
                      )
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white"
                  >
                    {IMAGE_PROVIDER_OPTIONS.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-slate-400">
                    若当前账号下 cloudapi 不可用，将自动切换到 OpenAI
                    兼容接口生图。
                  </p>
                </div>

                {/* 图片模型 */}
                {imageProviderMode === "openai" && (
                  <div className="pt-3 border-t border-slate-100 space-y-2">
                    <label className="text-xs font-medium text-slate-700 block">
                      图片模型
                    </label>
                    <select
                      value={imageModel}
                      onChange={(e) => setImageModel(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 bg-white"
                    >
                      {IMAGE_MODEL_OPTIONS.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-slate-400">
                      仅在 OpenAI 兼容接口生图时生效。推荐 doubao-seedream-5-0。
                    </p>
                  </div>
                )}

                {/* 数字人头像来源 */}
                <div className="pt-3 border-t border-slate-100 space-y-3">
                  <label className="text-xs font-medium text-slate-700 block">
                    数字人头像来源
                  </label>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <label
                      className={`p-2 border rounded-lg cursor-pointer transition-colors ${digitalHumanAvatarMode === "existing" ? "border-indigo-500 bg-indigo-50/50" : "hover:bg-slate-50 border-slate-200"}`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <input
                          type="radio"
                          checked={digitalHumanAvatarMode === "existing"}
                          onChange={() => setDigitalHumanAvatarMode("existing")}
                          className="text-indigo-600 focus:ring-indigo-500"
                        />
                        <span className="text-sm font-medium text-slate-800">
                          复用账号已有头像
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 pl-6">
                        从当前账号已有数字人中选择可用形象和音色参数。
                      </p>
                    </label>
                    <label
                      className={`p-2 border rounded-lg cursor-pointer transition-colors ${digitalHumanAvatarMode === "ai" ? "border-indigo-500 bg-indigo-50/50" : "hover:bg-slate-50 border-slate-200"}`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <input
                          type="radio"
                          checked={digitalHumanAvatarMode === "ai"}
                          onChange={() => setDigitalHumanAvatarMode("ai")}
                          className="text-indigo-600 focus:ring-indigo-500"
                        />
                        <span className="text-sm font-medium text-slate-800">
                          AI 生成头像并上传
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 pl-6">
                        为每个成员生成头像，上传后同步为数字人形象。
                      </p>
                    </label>
                  </div>
                  {digitalHumanAvatarMode === "ai" && (
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={digitalHumanAvatarStylePrompt}
                        onChange={(e) =>
                          setDigitalHumanAvatarStylePrompt(e.target.value)
                        }
                        placeholder="例如：专业讲师、半身头像、亲切可信、干净背景"
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
                      />
                      <p className="text-xs text-slate-400">
                        头像固定使用 OpenAI
                        兼容接口生成；音色仍优先取账号已有数字人的可用音色参数。
                      </p>
                    </div>
                  )}
                </div>

                {/* 图片注入开关 */}
                <div className="pt-3 border-t border-slate-100 space-y-2">
                  <label className="text-xs font-medium text-slate-700 block">
                    图片注入开关
                  </label>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <label className="flex items-center gap-2 p-2 rounded-lg border hover:bg-slate-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={injectCoverImage}
                        onChange={(e) => setInjectCoverImage(e.target.checked)}
                        className="rounded text-indigo-600 focus:ring-indigo-500"
                      />
                      <span className="text-sm text-slate-700">
                        注入课程封面图
                      </span>
                    </label>
                    <label className="flex items-center gap-2 p-2 rounded-lg border hover:bg-slate-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={injectBackgroundImage}
                        onChange={(e) =>
                          setInjectBackgroundImage(e.target.checked)
                        }
                        className="rounded text-indigo-600 focus:ring-indigo-500"
                      />
                      <span className="text-sm text-slate-700">
                        注入阶段背景图
                      </span>
                    </label>
                  </div>
                  <p className="text-xs text-slate-400">
                    关闭后会跳过对应生图步骤，可用于先快速验证文字配置。
                  </p>
                </div>
              </div>

              {/* 注入前审阅与修正 */}
              <div className="bg-white border border-slate-200 shadow-sm rounded-xl p-5">
                <button
                  type="button"
                  onClick={() => setCustomDocExpanded(!customDocExpanded)}
                  className="flex items-center gap-2 w-full text-left group"
                >
                  {customDocExpanded ? (
                    <ChevronDown className="w-4 h-4 text-slate-400 group-hover:text-indigo-500 transition-colors" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-500 transition-colors" />
                  )}
                  <Upload className="w-3.5 h-3.5 text-slate-500" />
                  <span className="text-xs font-medium text-slate-700 group-hover:text-indigo-600 transition-colors">
                    注入前审阅与修正（可选）
                  </span>
                  {hasCustomDoc && (
                    <span className="ml-auto text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                      将使用修正版注入
                    </span>
                  )}
                </button>

                {customDocExpanded && (
                  <div className="mt-3 space-y-3 pl-6">
                    <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 space-y-3">
                      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                        <div className="space-y-1">
                          <div className="text-sm font-semibold text-slate-800">
                            当前待注入内容审阅
                          </div>
                          <p className="text-xs text-slate-500">
                            如果生成的 Markdown
                            有问题，可以直接在这里粘贴或修改，执行注入时会优先使用这里的修正版。
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {markdown && (
                            <button
                              type="button"
                              onClick={() => setCustomMarkdown(markdown)}
                              className="px-3 py-1.5 text-xs font-medium border border-indigo-200 rounded-lg bg-white text-indigo-600 hover:bg-indigo-50 transition-colors"
                            >
                              载入当前生成内容
                            </button>
                          )}
                          {hasCustomDoc && (
                            <button
                              type="button"
                              onClick={() => setCustomMarkdown("")}
                              className="px-3 py-1.5 text-xs font-medium border border-rose-200 rounded-lg bg-white text-rose-600 hover:bg-rose-50 transition-colors"
                            >
                              清空修正版
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <span
                          className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${hasCustomDoc ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-700"}`}
                        >
                          {hasCustomDoc
                            ? "本次将按修正版注入"
                            : "本次将按当前生成结果注入"}
                        </span>
                        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-white border border-slate-200 text-slate-700">
                          内容长度：{effectiveMarkdown.length} 字符
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <input
                          ref={fileRef}
                          type="file"
                          accept=".md,.markdown,.txt"
                          className="hidden"
                          onChange={handleFileUpload}
                        />
                        <button
                          type="button"
                          onClick={() => fileRef.current?.click()}
                          className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg bg-white hover:bg-slate-50 text-slate-600 flex items-center gap-1.5 transition-colors"
                        >
                          <FileText className="w-3.5 h-3.5" />
                          上传 .md 文件
                        </button>
                        {customMarkdown && (
                          <span className="text-xs text-emerald-600">
                            已加载 {customMarkdown.length} 字符
                          </span>
                        )}
                      </div>

                      <textarea
                        value={customMarkdown}
                        onChange={(e) => setCustomMarkdown(e.target.value)}
                        placeholder="把你想真正注入的 Pro 配置 Markdown 粘贴到这里；保存后将优先按这里的内容注入..."
                        rows={10}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 font-mono resize-y"
                      />
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* 注入进度或结果 */}
          {(injecting || progressLogs.length > 0) && (
            <div className="bg-slate-900 rounded-xl overflow-hidden flex flex-col items-stretch border border-slate-800 shadow-inner">
              <div className="bg-slate-800 px-4 py-2 border-b border-slate-700 flex justify-between items-center shrink-0">
                <span className="text-xs font-mono text-emerald-400 flex items-center gap-2">
                  {injecting ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Shield className="w-3.5 h-3.5" />
                  )}
                  {injecting ? "执行注入任务中..." : "任务执行结束"}
                </span>
                {summary && (
                  <span className="text-xs text-slate-400 bg-slate-700/50 px-2 py-0.5 rounded">
                    Process finished with exit code 0
                  </span>
                )}
              </div>

              <div className="p-4 font-mono text-sm overflow-y-auto max-h-[300px] min-h-[150px] space-y-1.5 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
                {progressLogs.map((log, i) => (
                  <div
                    key={i}
                    className={`flex gap-2 ${log.type === "error" ? "text-red-400" : log.type === "complete" ? "text-emerald-400 font-bold" : log.type === "start" ? "text-blue-300 font-semibold" : "text-slate-300"}`}
                  >
                    <span className="text-slate-600 shrink-0">
                      [
                      {new Date().toLocaleTimeString("en-US", {
                        hour12: false,
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                      ]
                    </span>
                    <span className="break-all">
                      {log.type === "start"
                        ? `>>> ${log.message}`
                        : log.message}
                    </span>
                  </div>
                ))}
                <div ref={logsEndRef} className="h-1" />
              </div>

              {summary && (
                <div className="bg-emerald-950/30 border-t border-emerald-900/50 p-4 shrink-0">
                  <div className="flex items-center gap-2 text-emerald-400 font-semibold mb-2">
                    <CheckCircle2 className="w-4 h-4" />
                    注入操作盘点
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                    <div className="bg-black/20 rounded p-2 border border-white/5">
                      <div className="text-slate-400 text-xs mb-0.5">
                        创建成员
                      </div>
                      <div className="text-emerald-300 font-mono text-lg">
                        {summary.membersCreated}
                      </div>
                    </div>
                    <div className="bg-black/20 rounded p-2 border border-white/5">
                      <div className="text-slate-400 text-xs mb-0.5">
                        创建技能
                      </div>
                      <div className="text-emerald-300 font-mono text-lg">
                        {summary.skillsCreated}
                      </div>
                    </div>
                    <div className="bg-black/20 rounded p-2 border border-white/5">
                      <div className="text-slate-400 text-xs mb-0.5">
                        创建阶段
                      </div>
                      <div className="text-emerald-300 font-mono text-lg">
                        {summary.stagesCreated}
                      </div>
                    </div>
                    <div className="bg-black/20 rounded p-2 border border-white/5">
                      <div className="text-slate-400 text-xs mb-0.5">
                        数字人
                      </div>
                      <div className="text-emerald-300 font-mono text-lg">
                        {summary.digitalHumansCreated}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex justify-end gap-3 shrink-0 rounded-b-2xl">
          {!injecting && !summary && (
            <button
              onClick={onClose}
              className="px-5 py-2 text-sm text-slate-600 hover:bg-slate-200 bg-slate-100 rounded-lg font-medium transition-colors"
            >
              取消
            </button>
          )}

          {summary ? (
            <button
              onClick={onClose}
              className="px-6 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-medium transition-colors shadow-sm"
            >
              完成并关闭
            </button>
          ) : (
            <button
              onClick={handleInject}
              disabled={injecting || !effectiveMarkdown}
              className="px-6 py-2 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 disabled:opacity-50 text-white rounded-lg font-medium flex items-center gap-2 shadow-md shadow-indigo-500/20 transition-all"
            >
              {injecting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  注入中...
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 fill-current" />
                  执行注入
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
