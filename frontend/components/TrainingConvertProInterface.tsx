"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Clipboard,
  Code2,
  Download,
  Eye,
  EyeOff,
  FileSearch,
  KeyRound,
  Loader2,
  Pencil,
  RefreshCw,
  Route,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  Users,
  WandSparkles,
} from "lucide-react";
import { InjectConfigProModal } from "@/components/InjectConfigProModal";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import {
  downloadProMarkdown,
  streamProTrainingGenerate,
} from "@/lib/training-generator-pro/client";
import { parseProMarkdown } from "@/lib/training-injector-pro/parser";

type GeneratePhase = "idle" | "generating" | "completed" | "error";
type OutputMode = "preview" | "edit";

interface SourceStageSummary {
  stepId: string;
  name: string;
  trainerName: string;
  description: string;
  outgoing: Array<{ to: string; condition: string }>;
}

interface SourceSnapshot {
  taskName: string;
  description: string;
  trainTaskId: string;
  courseId: string;
  nodeCount: number;
  flowCount: number;
  roleNames: string[];
  warnings: string[];
  stages: SourceStageSummary[];
}

interface SourceApiResponse {
  ok?: boolean;
  error?: string;
  source?: SourceSnapshot;
  sourceDocument?: string;
}

const CREDENTIAL_STORAGE_KEY = "training-injector-credentials";
const PRO_CREDENTIAL_STORAGE_KEY = "training-injector-pro-credentials";
const DRAFT_STORAGE_KEY = "training-convert-pro-draft";

function cleanFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").trim() || "能力训练-Pro";
}

function readJsonStorage(key: string): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  try {
    const value = window.localStorage.getItem(key);
    return value ? (JSON.parse(value) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function TrainingConvertProInterface() {
  const [authorization, setAuthorization] = useState("");
  const [cookie, setCookie] = useState("");
  const [showCredentials, setShowCredentials] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [advice, setAdvice] = useState("");

  const [source, setSource] = useState<SourceSnapshot | null>(null);
  const [sourceDocument, setSourceDocument] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [phase, setPhase] = useState<GeneratePhase>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [error, setError] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [taskName, setTaskName] = useState("");
  const [outputMode, setOutputMode] = useState<OutputMode>("preview");
  const [copied, setCopied] = useState(false);
  const [showInjectModal, setShowInjectModal] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const basicCredentials = readJsonStorage(CREDENTIAL_STORAGE_KEY);
    const proCredentials = readJsonStorage(PRO_CREDENTIAL_STORAGE_KEY);
    const draft = readJsonStorage(DRAFT_STORAGE_KEY);
    setAuthorization(
      String(
        basicCredentials.authorization || proCredentials.authorization || "",
      ),
    );
    setCookie(String(basicCredentials.cookie || proCredentials.cookie || ""));
    setSourceUrl(String(draft.sourceUrl || ""));
    setTargetUrl(String(draft.targetUrl || proCredentials.targetUrl || ""));
    setAdvice(String(draft.advice || ""));
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        DRAFT_STORAGE_KEY,
        JSON.stringify({ sourceUrl, targetUrl, advice }),
      );
    } catch {
      // 浏览器禁用存储时不影响主流程。
    }
  }, [advice, sourceUrl, targetUrl]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const credentialsReady = Boolean(authorization.trim() && cookie.trim());
  const targetReady = Boolean(targetUrl.trim());

  const parsedConfig = useMemo(() => {
    if (!markdown.trim() || phase === "generating") return null;
    try {
      const parsed = parseProMarkdown(markdown);
      if (!parsed.globalConfig.abilityName || parsed.stages.length === 0)
        return null;
      return parsed;
    } catch {
      return null;
    }
  }, [markdown, phase]);

  const progressStep = parsedConfig ? 3 : source ? 2 : 1;

  const saveCredentials = () => {
    const basic = {
      authorization: authorization.trim(),
      cookie: cookie.trim(),
    };
    const previousPro = readJsonStorage(PRO_CREDENTIAL_STORAGE_KEY);
    try {
      window.localStorage.setItem(
        CREDENTIAL_STORAGE_KEY,
        JSON.stringify(basic),
      );
      window.localStorage.setItem(
        PRO_CREDENTIAL_STORAGE_KEY,
        JSON.stringify({
          ...previousPro,
          ...basic,
          targetUrl: targetUrl.trim(),
        }),
      );
    } catch {
      // 本地存储不可用时仍允许本次读取、生成和注入。
    }
  };

  const handleSourceUrlChange = (value: string) => {
    setSourceUrl(value);
    if (source) {
      setSource(null);
      setSourceDocument("");
      setMarkdown("");
      setTaskName("");
      setPhase("idle");
    }
  };

  const extractSource = async (): Promise<boolean> => {
    setError("");
    if (!credentialsReady) {
      setError("请先填写平台 Authorization 和 Cookie。");
      return false;
    }
    if (!sourceUrl.trim()) {
      setError("请填写已经搭建好的基础版能力训练页面 URL。");
      return false;
    }

    setExtracting(true);
    setStatusMessage("正在读取基础训练的节点、提示词和流转关系...");
    try {
      saveCredentials();
      const response = await fetch("/api/training-convert-pro/source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceUrl: sourceUrl.trim(),
          credentials: {
            authorization: authorization.trim(),
            cookie: cookie.trim(),
          },
        }),
      });
      const result = (await response.json()) as SourceApiResponse;
      if (
        !response.ok ||
        !result.ok ||
        !result.source ||
        !result.sourceDocument
      ) {
        throw new Error(result.error || "读取基础训练失败。");
      }
      setSource(result.source);
      setSourceDocument(result.sourceDocument);
      setMarkdown("");
      setTaskName(result.source.taskName);
      setPhase("idle");
      setStatusMessage(
        `已读取 ${result.source.nodeCount} 个阶段和 ${result.source.flowCount} 条流转。`,
      );
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取基础训练失败。");
      setStatusMessage("");
      return false;
    } finally {
      setExtracting(false);
    }
  };

  const handleGenerate = async () => {
    if (!source || !sourceDocument) {
      setError("请先读取基础版训练，确认源阶段后再生成 Pro 剧本。");
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError("");
    setMarkdown("");
    setPhase("generating");
    setOutputMode("preview");
    setStatusMessage("正在根据基础训练和补充建议生成 Pro 剧本...");

    try {
      await streamProTrainingGenerate({
        teacherDocContent: sourceDocument,
        teacherDocName: source.taskName,
        userGenerationAdvice: advice.trim(),
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "start") {
            setStatusMessage(event.message);
          } else if (event.type === "chunk") {
            setMarkdown((current) => current + event.content);
          } else if (event.type === "complete") {
            setMarkdown(event.fullContent);
            setTaskName(event.taskName || source.taskName);
            setPhase("completed");
            setStatusMessage("Pro 剧本已生成，请确认内容后再注入目标训练。");
          } else if (event.type === "error") {
            setPhase("error");
            setError(event.message);
            setStatusMessage("");
          }
        },
      });
    } catch (cause) {
      if (controller.signal.aborted) {
        setStatusMessage("已停止生成。");
        setPhase("idle");
      } else {
        setPhase("error");
        setError(
          cause instanceof Error ? cause.message : "生成 Pro 剧本失败。",
        );
        setStatusMessage("");
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const handleCopy = async () => {
    if (!markdown) return;
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const handleOpenInject = () => {
    if (!parsedConfig) {
      setError("当前 Pro 剧本结构不完整，请在编辑区修正后再注入。");
      return;
    }
    if (!targetReady) {
      setError("请填写新建的 Pro 能力训练页面 URL。");
      return;
    }
    saveCredentials();
    setError("");
    setShowInjectModal(true);
  };

  return (
    <main className="min-h-[calc(100vh-4rem)] bg-slate-50">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50">
              <WandSparkles className="h-5 w-5 text-emerald-700" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">
                基础训练转 Pro
              </h1>
              <p className="mt-1 text-sm text-slate-500">
                回采已搭建训练，结合补充要求生成 Pro 剧本，确认后注入新训练
              </p>
            </div>
          </div>
          <WorkflowProgress current={progressStep} />
        </header>

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,0.88fr)_minmax(520px,1.12fr)]">
          <section className="space-y-5">
            <Panel
              title="平台与训练链接"
              icon={<KeyRound className="h-4 w-4 text-indigo-600" />}
              aside={
                <button
                  type="button"
                  onClick={() => setShowCredentials((value) => !value)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                  title={showCredentials ? "隐藏认证信息" : "显示认证信息"}
                >
                  {showCredentials ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              }
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Authorization" required>
                  <input
                    type={showCredentials ? "text" : "password"}
                    value={authorization}
                    onChange={(event) => setAuthorization(event.target.value)}
                    placeholder="粘贴平台请求头中的 Authorization"
                    autoComplete="off"
                    className="field-input"
                  />
                </Field>
                <Field label="Cookie" required>
                  <input
                    type={showCredentials ? "text" : "password"}
                    value={cookie}
                    onChange={(event) => setCookie(event.target.value)}
                    placeholder="粘贴完整 Cookie"
                    autoComplete="off"
                    className="field-input"
                  />
                </Field>
              </div>

              <div className="mt-4 space-y-4">
                <Field label="基础版训练页面 URL" required>
                  <input
                    type="url"
                    value={sourceUrl}
                    onChange={(event) =>
                      handleSourceUrlChange(event.target.value)
                    }
                    placeholder="https://.../ability-training/create?...&trainTaskId=..."
                    className="field-input"
                  />
                </Field>
                <Field label="新建 Pro 训练页面 URL" required>
                  <input
                    type="url"
                    value={targetUrl}
                    onChange={(event) => setTargetUrl(event.target.value)}
                    placeholder="在 Pro 系统创建空训练后，粘贴页面链接"
                    className="field-input"
                  />
                </Field>
              </div>

              <button
                type="button"
                onClick={extractSource}
                disabled={extracting || phase === "generating"}
                className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:border-indigo-300 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {extracting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : source ? (
                  <RefreshCw className="h-4 w-4" />
                ) : (
                  <FileSearch className="h-4 w-4" />
                )}
                {extracting
                  ? "正在读取平台数据..."
                  : source
                    ? "重新读取基础训练"
                    : "读取基础训练"}
              </button>
            </Panel>

            <Panel
              title="Pro 生成注意事项"
              icon={<Pencil className="h-4 w-4 text-amber-600" />}
            >
              <textarea
                value={advice}
                onChange={(event) => setAdvice(event.target.value)}
                rows={6}
                maxLength={4000}
                placeholder="例如：保留原来的三个阶段；训练官统一称呼用户为“小林”；加强反剧透引导；第二阶段增加投诉处理技能；不要增加原训练中没有的业务结论。"
                className="field-input min-h-36 resize-y py-3"
              />
              <div className="mt-2 flex items-center justify-between gap-3 text-xs text-slate-400">
                <span>
                  留空时按原训练内容自动升级；建议会在不违背源训练事实的前提下执行。
                </span>
                <span className="shrink-0 tabular-nums">
                  {advice.length}/4000
                </span>
              </div>
            </Panel>

            <button
              type="button"
              onClick={handleGenerate}
              disabled={!source || extracting || phase === "generating"}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {phase === "generating" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {phase === "generating"
                ? "正在生成 Pro 剧本..."
                : markdown
                  ? "按当前要求重新生成"
                  : "生成 Pro 剧本"}
            </button>

            {phase === "generating" && (
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="h-9 w-full rounded-md border border-rose-200 bg-white text-sm font-medium text-rose-600 hover:bg-rose-50"
              >
                停止生成
              </button>
            )}
          </section>

          <section className="min-w-0">
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm xl:sticky xl:top-20">
              <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
                <div className="flex items-center gap-2">
                  {markdown ? (
                    <Code2 className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <Route className="h-4 w-4 text-indigo-600" />
                  )}
                  <h2 className="text-sm font-semibold text-slate-800">
                    {markdown ? "Pro 剧本确认" : "基础训练快照"}
                  </h2>
                </div>

                {markdown && (
                  <div className="flex items-center gap-1">
                    <IconButton
                      label={copied ? "已复制" : "复制 Markdown"}
                      onClick={handleCopy}
                    >
                      {copied ? (
                        <Check className="h-4 w-4" />
                      ) : (
                        <Clipboard className="h-4 w-4" />
                      )}
                    </IconButton>
                    <IconButton
                      label="下载 Markdown"
                      onClick={() =>
                        downloadProMarkdown(
                          markdown,
                          `${cleanFilename(taskName || source?.taskName || "能力训练-Pro")}.md`,
                        )
                      }
                    >
                      <Download className="h-4 w-4" />
                    </IconButton>
                    <div className="ml-1 flex rounded-md border border-slate-200 bg-slate-50 p-0.5">
                      <ModeButton
                        active={outputMode === "preview"}
                        onClick={() => setOutputMode("preview")}
                      >
                        预览
                      </ModeButton>
                      <ModeButton
                        active={outputMode === "edit"}
                        onClick={() => setOutputMode("edit")}
                      >
                        编辑
                      </ModeButton>
                    </div>
                  </div>
                )}
              </div>

              {(statusMessage || error) && (
                <div
                  className={`flex items-start gap-2 border-b px-4 py-3 text-sm sm:px-5 ${
                    error
                      ? "border-rose-200 bg-rose-50 text-rose-700"
                      : "border-indigo-100 bg-indigo-50 text-indigo-700"
                  }`}
                >
                  {error ? (
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  ) : phase === "generating" || extracting ? (
                    <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  )}
                  <span>{error || statusMessage}</span>
                </div>
              )}

              <div className="min-h-[560px] max-h-[calc(100vh-14rem)] overflow-y-auto">
                {markdown ? (
                  <GeneratedContent
                    markdown={markdown}
                    setMarkdown={setMarkdown}
                    outputMode={outputMode}
                    generating={phase === "generating"}
                    memberCount={parsedConfig?.members.length}
                    stageCount={parsedConfig?.stages.length}
                  />
                ) : source ? (
                  <SourceContent source={source} />
                ) : (
                  <EmptyPreview />
                )}
              </div>

              {markdown && phase !== "generating" && (
                <div className="border-t border-slate-200 bg-slate-50 px-4 py-4 sm:px-5">
                  <div className="mb-3 flex items-start gap-2 text-xs text-slate-500">
                    {parsedConfig ? (
                      <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600" />
                    ) : (
                      <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
                    )}
                    <span>
                      {parsedConfig
                        ? `结构校验通过：${parsedConfig.members.length} 个成员，${parsedConfig.stages.length} 个阶段。`
                        : "结构校验未通过，请切换到编辑模式检查全局配置、成员和训练阶段。"}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleOpenInject}
                    disabled={!parsedConfig || !targetReady}
                    className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    <UploadCloud className="h-4 w-4" />
                    确认剧本并配置注入
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      {showInjectModal && (
        <InjectConfigProModal
          markdown={markdown}
          initialTargetUrl={targetUrl.trim()}
          initialCredentials={{
            authorization: authorization.trim(),
            cookie: cookie.trim(),
          }}
          onClose={() => setShowInjectModal(false)}
        />
      )}

      <style jsx global>{`
        .field-input {
          width: 100%;
          border: 1px solid rgb(203 213 225);
          border-radius: 0.375rem;
          background: white;
          padding: 0.625rem 0.75rem;
          font-size: 0.875rem;
          line-height: 1.25rem;
          color: rgb(15 23 42);
          outline: none;
        }
        .field-input:focus {
          border-color: rgb(99 102 241);
          box-shadow: 0 0 0 3px rgb(99 102 241 / 0.12);
        }
        .field-input::placeholder {
          color: rgb(148 163 184);
        }
      `}</style>
    </main>
  );
}

function WorkflowProgress({ current }: { current: number }) {
  const steps = ["读取基础训练", "生成并确认剧本", "配置注入"];
  return (
    <ol className="grid w-full grid-cols-3 overflow-hidden rounded-lg border border-slate-200 bg-white lg:w-[520px]">
      {steps.map((label, index) => {
        const number = index + 1;
        const complete = number < current;
        const active = number === current;
        return (
          <li
            key={label}
            className={`flex min-w-0 items-center gap-2 px-3 py-2.5 text-xs font-medium ${index > 0 ? "border-l border-slate-200" : ""} ${
              active
                ? "bg-indigo-50 text-indigo-700"
                : complete
                  ? "text-emerald-700"
                  : "text-slate-400"
            }`}
          >
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${
                active
                  ? "bg-indigo-600 text-white"
                  : complete
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-slate-100 text-slate-500"
              }`}
            >
              {complete ? <Check className="h-3 w-3" /> : number}
            </span>
            <span className="truncate">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Panel({
  title,
  icon,
  aside,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-slate-200 px-4 py-2 sm:px-5">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        </div>
        {aside}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <span className="text-xs font-semibold text-slate-600">
        {label}
        {required && <span className="ml-1 text-rose-500">*</span>}
      </span>
      {children}
    </label>
  );
}

function SourceContent({ source }: { source: SourceSnapshot }) {
  return (
    <div className="p-4 sm:p-5">
      <div className="border-b border-slate-200 pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="break-words text-base font-semibold text-slate-900">
              {source.taskName}
            </h3>
            <p className="mt-1 text-sm leading-6 text-slate-500">
              {source.description ||
                "平台未返回训练描述，生成时将从各阶段内容中归纳。"}
            </p>
          </div>
          <div className="flex gap-2 text-xs">
            <span className="rounded-md bg-indigo-50 px-2 py-1 font-medium text-indigo-700">
              {source.nodeCount} 阶段
            </span>
            <span className="rounded-md bg-emerald-50 px-2 py-1 font-medium text-emerald-700">
              {source.flowCount} 流转
            </span>
          </div>
        </div>

        {source.roleNames.length > 0 && (
          <div className="mt-3 flex items-start gap-2 text-xs text-slate-500">
            <Users className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>识别到训练官：{source.roleNames.join("、")}</span>
          </div>
        )}
      </div>

      {source.warnings.length > 0 && (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-3 text-xs leading-5 text-amber-800">
          {source.warnings.map((warning) => (
            <div key={warning} className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      )}

      <ol className="mt-4 space-y-0">
        {source.stages.map((stage, index) => (
          <li key={stage.stepId} className="relative flex gap-3 pb-5 last:pb-0">
            {index < source.stages.length - 1 && (
              <span className="absolute left-[15px] top-8 h-[calc(100%-1rem)] w-px bg-slate-200" />
            )}
            <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-indigo-200 bg-indigo-50 text-xs font-bold text-indigo-700">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1 pt-1">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="break-words text-sm font-semibold text-slate-800">
                  {stage.name}
                </h4>
                {stage.trainerName && (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                    {stage.trainerName}
                  </span>
                )}
              </div>
              {stage.description && (
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">
                  {stage.description}
                </p>
              )}
              {stage.outgoing.length > 0 && (
                <div className="mt-2 space-y-1 text-[11px] text-slate-400">
                  {stage.outgoing.map((flow, flowIndex) => (
                    <div
                      key={`${flow.to}-${flowIndex}`}
                      className="flex items-center gap-1.5"
                    >
                      <ArrowRight className="h-3 w-3 shrink-0" />
                      <span className="truncate">{flow.to}</span>
                      <span className="shrink-0">· {flow.condition}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function GeneratedContent({
  markdown,
  setMarkdown,
  outputMode,
  generating,
  memberCount,
  stageCount,
}: {
  markdown: string;
  setMarkdown: (value: string) => void;
  outputMode: OutputMode;
  generating: boolean;
  memberCount?: number;
  stageCount?: number;
}) {
  if (generating) {
    return (
      <pre className="min-h-[560px] whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6 text-slate-600 sm:p-5">
        {markdown || "正在等待模型返回内容..."}
      </pre>
    );
  }

  if (outputMode === "edit") {
    return (
      <textarea
        value={markdown}
        onChange={(event) => setMarkdown(event.target.value)}
        className="min-h-[620px] w-full resize-y border-0 p-4 font-mono text-xs leading-6 text-slate-700 outline-none sm:p-5"
        spellCheck={false}
      />
    );
  }

  return (
    <div>
      {typeof memberCount === "number" && typeof stageCount === "number" && (
        <div className="flex flex-wrap gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs sm:px-5">
          <span className="rounded-md border border-slate-200 bg-white px-2 py-1 text-slate-600">
            {memberCount} 个全局成员
          </span>
          <span className="rounded-md border border-slate-200 bg-white px-2 py-1 text-slate-600">
            {stageCount} 个 Pro 阶段
          </span>
        </div>
      )}
      <MarkdownRenderer content={markdown} className="p-4 sm:p-6" />
    </div>
  );
}

function EmptyPreview() {
  return (
    <div className="flex min-h-[560px] items-center justify-center px-6 py-12 text-center">
      <div className="max-w-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-slate-100">
          <Route className="h-5 w-5 text-slate-500" />
        </div>
        <h3 className="mt-4 text-sm font-semibold text-slate-800">
          先读取基础版训练
        </h3>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          系统会自动抓取节点、提示词、角色、开场白和流转关系，并在这里展示转换依据。
        </p>
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"
    >
      {children}
    </button>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2.5 py-1 text-xs font-medium ${active ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
    >
      {children}
    </button>
  );
}
