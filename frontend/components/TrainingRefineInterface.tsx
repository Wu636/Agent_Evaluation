"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  Download,
  FileStack,
  Key,
  Link2,
  Loader2,
  Network,
  PlayCircle,
  RefreshCw,
  Shield,
  Sparkles,
  Terminal,
  UploadCloud,
  X,
} from "lucide-react";

import {
  LLM_SETTINGS_UPDATED_EVENT,
  loadLLMSettingsFromStorage,
} from "@/lib/llm/settings";
import type {
  TrainingGraphSnapshot,
  TrainingRefineApiResponse,
  TrainingRefinementPlan,
  TrainingScoreItem,
} from "@/lib/training-refiner/types";
import {
  TrainingInjectionOptions,
  type TrainingInjectionMode,
} from "@/components/TrainingInjectionOptions";

const CREDENTIAL_STORAGE_KEY = "training-injector-credentials";
const WORKSPACE_STORAGE_KEY = "training-refine-workspace-v1";
const WORKSPACE_SAVE_DELAY_MS = 300;

interface TrainingRefineWorkspaceCache {
  version: 1;
  updatedAt: string;
  sourceUrl: string;
  targetUrl: string;
  teacherFeedback: string;
  supplementalContext: string;
  source: TrainingGraphSnapshot | null;
  selectedNodeIds: string[];
  optimizeScoring: boolean;
  injectScript: boolean;
  injectRubric: boolean;
  injectMode: TrainingInjectionMode;
  plan: TrainingRefinementPlan | null;
  validationWarnings: string[];
  confirmImport: boolean;
  log: string;
  error: string;
}

type WorkspaceSaveResult =
  | "saved"
  | "inputs-only"
  | "credentials-failed"
  | "failed";

function persistWorkspaceCache(
  workspace: TrainingRefineWorkspaceCache,
  authorization: string,
  cookie: string,
): WorkspaceSaveResult {
  let credentialsSaved = true;
  try {
    localStorage.setItem(
      CREDENTIAL_STORAGE_KEY,
      JSON.stringify({ authorization, cookie }),
    );
  } catch {
    credentialsSaved = false;
  }
  try {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
    return credentialsSaved ? "saved" : "credentials-failed";
  } catch {
    try {
      localStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        JSON.stringify({
          ...workspace,
          source: null,
          plan: null,
          validationWarnings: [],
          log: "",
          error: "",
        }),
      );
      return "inputs-only";
    } catch {
      return "failed";
    }
  }
}

function joinLog(result: TrainingRefineApiResponse): string {
  return [result.error, result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function TrainingRefineInterface() {
  const [authorization, setAuthorization] = useState("");
  const [cookie, setCookie] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [teacherFeedback, setTeacherFeedback] = useState("");
  const [supplementalContext, setSupplementalContext] = useState("");
  const [source, setSource] = useState<TrainingGraphSnapshot | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [optimizeScoring, setOptimizeScoring] = useState(true);
  const [injectScript, setInjectScript] = useState(true);
  const [injectRubric, setInjectRubric] = useState(true);
  const [injectMode, setInjectMode] =
    useState<TrainingInjectionMode>("replace");
  const [plan, setPlan] = useState<TrainingRefinementPlan | null>(null);
  const [validationWarnings, setValidationWarnings] = useState<string[]>([]);
  const [confirmImport, setConfirmImport] = useState(false);
  const [loading, setLoading] = useState<
    "extract" | "optimize" | "dry-run" | "import" | null
  >(null);
  const [log, setLog] = useState("");
  const [error, setError] = useState("");
  const [modelLabel, setModelLabel] = useState("");
  const [workspaceHydrated, setWorkspaceHydrated] = useState(false);
  const [showInjectModal, setShowInjectModal] = useState(false);
  const [workspaceNotice, setWorkspaceNotice] = useState(
    "本页输入与上次分析结果会自动保存到当前浏览器",
  );
  const restoringWorkspaceRef = useRef(true);
  const latestWorkspaceRef = useRef<TrainingRefineWorkspaceCache | null>(null);
  const latestCredentialsRef = useRef({ authorization: "", cookie: "" });

  const hasCredentials = Boolean(authorization.trim() && cookie.trim());
  const isBusy = loading !== null;

  useEffect(() => {
    try {
      const stored = localStorage.getItem(CREDENTIAL_STORAGE_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as {
        authorization?: string;
        cookie?: string;
      };
      setAuthorization(parsed.authorization || "");
      setCookie(parsed.cookie || "");
    } catch {
      // 忽略旧缓存格式错误
    }
  }, []);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(WORKSPACE_STORAGE_KEY);
      if (!stored) return;
      const parsed = JSON.parse(
        stored,
      ) as Partial<TrainingRefineWorkspaceCache>;
      if (parsed.version !== 1) return;
      setSourceUrl(
        typeof parsed.sourceUrl === "string" ? parsed.sourceUrl : "",
      );
      setTargetUrl(
        typeof parsed.targetUrl === "string" ? parsed.targetUrl : "",
      );
      setTeacherFeedback(
        typeof parsed.teacherFeedback === "string"
          ? parsed.teacherFeedback
          : "",
      );
      setSupplementalContext(
        typeof parsed.supplementalContext === "string"
          ? parsed.supplementalContext
          : "",
      );
      setSource(
        parsed.source && typeof parsed.source === "object"
          ? (parsed.source as TrainingGraphSnapshot)
          : null,
      );
      setSelectedNodeIds(
        Array.isArray(parsed.selectedNodeIds)
          ? parsed.selectedNodeIds.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
      );
      setOptimizeScoring(
        typeof parsed.optimizeScoring === "boolean"
          ? parsed.optimizeScoring
          : true,
      );
      setInjectScript(
        typeof parsed.injectScript === "boolean" ? parsed.injectScript : true,
      );
      setInjectRubric(
        typeof parsed.injectRubric === "boolean" ? parsed.injectRubric : true,
      );
      setInjectMode(parsed.injectMode === "append" ? "append" : "replace");
      setPlan(
        parsed.plan && typeof parsed.plan === "object"
          ? (parsed.plan as TrainingRefinementPlan)
          : null,
      );
      setValidationWarnings(
        Array.isArray(parsed.validationWarnings)
          ? parsed.validationWarnings.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
      );
      setConfirmImport(parsed.confirmImport === true);
      setLog(typeof parsed.log === "string" ? parsed.log : "");
      setError(typeof parsed.error === "string" ? parsed.error : "");
      if (parsed.updatedAt) {
        setWorkspaceNotice(
          `已恢复 ${new Date(parsed.updatedAt).toLocaleString("zh-CN")} 保存的工作区`,
        );
      }
    } catch {
      setWorkspaceNotice("上次缓存格式异常，本次输入后会自动重建");
    } finally {
      setWorkspaceHydrated(true);
    }
  }, []);

  useEffect(() => {
    const refreshModelLabel = () => {
      setModelLabel(loadLLMSettingsFromStorage("trainingOptimize").model);
    };
    refreshModelLabel();
    window.addEventListener(LLM_SETTINGS_UPDATED_EVENT, refreshModelLabel);
    window.addEventListener("storage", refreshModelLabel);
    return () => {
      window.removeEventListener(LLM_SETTINGS_UPDATED_EVENT, refreshModelLabel);
      window.removeEventListener("storage", refreshModelLabel);
    };
  }, []);

  useEffect(() => {
    if (!workspaceHydrated || restoringWorkspaceRef.current) return;
    setSource(null);
    setSelectedNodeIds([]);
    setOptimizeScoring(true);
    setInjectScript(true);
    setInjectRubric(true);
    setInjectMode("replace");
    setPlan(null);
    setConfirmImport(false);
    setValidationWarnings([]);
    setLog("");
    setError("");
  }, [sourceUrl, workspaceHydrated]);

  useEffect(() => {
    if (!workspaceHydrated || restoringWorkspaceRef.current) return;
    setPlan(null);
    setConfirmImport(false);
    setValidationWarnings([]);
  }, [teacherFeedback, supplementalContext, workspaceHydrated]);

  useEffect(() => {
    if (workspaceHydrated) restoringWorkspaceRef.current = false;
  }, [workspaceHydrated]);

  useEffect(() => {
    if (!workspaceHydrated || restoringWorkspaceRef.current) return;
    const workspace: TrainingRefineWorkspaceCache = {
      version: 1,
      updatedAt: new Date().toISOString(),
      sourceUrl,
      targetUrl,
      teacherFeedback,
      supplementalContext,
      source,
      selectedNodeIds,
      optimizeScoring,
      injectScript,
      injectRubric,
      injectMode,
      plan,
      validationWarnings,
      confirmImport,
      log,
      error,
    };
    latestWorkspaceRef.current = workspace;
    latestCredentialsRef.current = { authorization, cookie };
    const timeoutId = window.setTimeout(() => {
      const saveResult = persistWorkspaceCache(
        workspace,
        authorization,
        cookie,
      );
      if (saveResult === "saved") {
        setWorkspaceNotice(
          `已自动保存 · ${new Date().toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}`,
        );
      } else if (saveResult === "inputs-only") {
        setWorkspaceNotice("分析结果超出浏览器容量，已保存所有输入和勾选范围");
      } else if (saveResult === "credentials-failed") {
        setWorkspaceNotice("工作区已保存，认证信息因存储空间不足未更新");
      } else {
        setWorkspaceNotice("浏览器本地存储空间不足，本次内容尚未保存");
      }
    }, WORKSPACE_SAVE_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [
    authorization,
    confirmImport,
    cookie,
    error,
    injectMode,
    injectRubric,
    injectScript,
    log,
    optimizeScoring,
    plan,
    selectedNodeIds,
    source,
    sourceUrl,
    supplementalContext,
    targetUrl,
    teacherFeedback,
    validationWarnings,
    workspaceHydrated,
  ]);

  useEffect(() => {
    if (!workspaceHydrated) return;
    const flushLatestWorkspace = () => {
      const workspace = latestWorkspaceRef.current;
      if (!workspace) return;
      persistWorkspaceCache(
        { ...workspace, updatedAt: new Date().toISOString() },
        latestCredentialsRef.current.authorization,
        latestCredentialsRef.current.cookie,
      );
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushLatestWorkspace();
    };
    window.addEventListener("pagehide", flushLatestWorkspace);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      flushLatestWorkspace();
      window.removeEventListener("pagehide", flushLatestWorkspace);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [workspaceHydrated]);

  const saveCredentials = () => {
    try {
      localStorage.setItem(
        CREDENTIAL_STORAGE_KEY,
        JSON.stringify({
          authorization: authorization.trim(),
          cookie: cookie.trim(),
        }),
      );
    } catch {
      setWorkspaceNotice("浏览器本地存储空间不足，认证信息未更新");
    }
  };

  const basePayload = () => ({
    sourceUrl: sourceUrl.trim(),
    credentials: {
      authorization: authorization.trim(),
      cookie: cookie.trim(),
    },
  });

  const invalidatePlan = () => {
    setPlan(null);
    setConfirmImport(false);
    setValidationWarnings([]);
    setLog("");
    setError("");
  };

  const callApi = async (
    action: "extract" | "optimize" | "dry-run" | "import",
  ) => {
    setLoading(action);
    setError("");
    setLog("");
    saveCredentials();
    try {
      const llmSettings = loadLLMSettingsFromStorage("trainingOptimize");
      const response = await fetch("/api/training-refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...basePayload(),
          action,
          targetUrl: targetUrl.trim(),
          teacherFeedback: teacherFeedback.trim(),
          supplementalContext: supplementalContext.trim(),
          selectedNodeIds,
          optimizeScoring,
          injectScript,
          injectRubric,
          injectMode,
          plan,
          confirmImport: action === "import" ? confirmImport : true,
          llmSettings: {
            apiKey: llmSettings.apiKey,
            apiUrl: llmSettings.apiUrl,
            model: llmSettings.model,
          },
        }),
      });
      const result = (await response.json()) as TrainingRefineApiResponse;
      if (result.source) {
        setSource(result.source);
        if (action === "extract") {
          setSelectedNodeIds(result.source.nodes.map((node) => node.id));
        }
      }
      if (result.plan) setPlan(result.plan);
      setValidationWarnings(result.validation?.warnings || []);
      const output = joinLog(result);
      if (!response.ok || !result.ok) {
        setError(output || "处理失败。");
        return false;
      }
      if (action === "extract") {
        setLog(
          `已读取源训练的完整任务配置、全部卡片、连线、附件与 ${result.source?.scoreItems.length || 0} 条评分标准。`,
        );
      } else if (action === "optimize") {
        setLog(
          [
            result.plan?.summary || "AI 优化方案已生成并通过图谱校验。",
            result.modelUsed ? `本次使用模型：${result.modelUsed}` : "",
            result.inputChars
              ? `本次精简后模型输入：${result.inputChars.toLocaleString()} 字符`
              : "",
            `本次范围：${selectedNodeIds.length} 张卡片；评分标准：${optimizeScoring ? "参与优化" : "原样继承"}`,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      } else {
        setLog(output || "执行完成。");
      }
      return true;
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "请求失败。",
      );
      return false;
    } finally {
      setLoading(null);
    }
  };

  const downloadPlan = () => {
    if (!plan) return;
    const blob = new Blob([JSON.stringify(plan, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "training-refinement-plan.json";
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const canExtract = hasCredentials && Boolean(sourceUrl.trim()) && !isBusy;
  const canOptimize =
    canExtract &&
    Boolean(source) &&
    teacherFeedback.trim().length >= 10 &&
    (selectedNodeIds.length > 0 || optimizeScoring);
  const canDryRun =
    hasCredentials &&
    Boolean(sourceUrl.trim()) &&
    Boolean(targetUrl.trim()) &&
    Boolean(plan) &&
    (injectScript || injectRubric) &&
    !isBusy;
  const canImport = canDryRun && confirmImport;

  return (
    <main className="min-h-[calc(100vh-4rem)] bg-slate-50">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50">
              <Network className="h-5 w-5 text-indigo-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">
                能力训练 AI 优化
              </h1>
              <p className="text-sm text-slate-500">
                还原现有卡片关系，根据教师意见优化后注入一份新训练
              </p>
              <p className="mt-1 flex items-center gap-1 text-[11px] text-emerald-600">
                <CheckCircle2 className="h-3 w-3 shrink-0" />
                {workspaceNotice}
              </p>
            </div>
          </div>
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-800">
            <div className="flex items-center gap-1.5 font-semibold">
              <Shield className="h-3.5 w-3.5" />
              源训练始终只读
            </div>
            正式注入只写入另一份目标训练
          </div>
        </header>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,0.92fr)_minmax(430px,1.08fr)]">
          <section className="space-y-5">
            <CredentialsPanel
              authorization={authorization}
              cookie={cookie}
              setAuthorization={setAuthorization}
              setCookie={setCookie}
            />

            <Panel
              icon={<Link2 className="h-4 w-4 text-indigo-500" />}
              title="1. 拉取现有能力训练"
            >
              <div className="space-y-1.5">
                <FieldLabel>源训练完整页面 URL</FieldLabel>
                <TextInput
                  value={sourceUrl}
                  onChange={(event) => setSourceUrl(event.target.value)}
                  placeholder="从平台地址栏复制已搭建好的能力训练 URL"
                />
              </div>
              <button
                type="button"
                disabled={!canExtract}
                onClick={() => callApi("extract")}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
              >
                {loading === "extract" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                拉取完整配置、评分标准与连线
              </button>
            </Panel>

            <Panel
              icon={<Sparkles className="h-4 w-4 text-indigo-500" />}
              title="2. 填写教师修改意见"
            >
              <div className="space-y-1.5">
                <FieldLabel>教师修改意见</FieldLabel>
                <TextArea
                  rows={7}
                  value={teacherFeedback}
                  onChange={(event) => setTeacherFeedback(event.target.value)}
                  placeholder="例如：第二关不要直接告诉学生答案，要增加一次追问；第三关拆成资料分析和决策汇报两张卡片……"
                />
              </div>
              <div className="mt-3 space-y-1.5">
                <FieldLabel>补充资料 / 不可变更约束（可选）</FieldLabel>
                <TextArea
                  rows={4}
                  value={supplementalContext}
                  onChange={(event) =>
                    setSupplementalContext(event.target.value)
                  }
                  placeholder="可粘贴新的课程资料、必须保留的评分规则或角色限制"
                />
              </div>
              <div className="mt-3 flex items-center justify-between rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
                <span className="flex items-center gap-1.5">
                  <Bot className="h-3.5 w-3.5" />
                  训练优化模型
                </span>
                <span className="font-medium text-slate-700">
                  {modelLabel || "请先在设置中配置"}
                </span>
              </div>
              <button
                type="button"
                disabled={!canOptimize}
                onClick={() => callApi("optimize")}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {loading === "optimize" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                AI 生成优化图谱
              </button>
            </Panel>

            <Panel
              icon={<UploadCloud className="h-4 w-4 text-indigo-500" />}
              title="3. 检查并注入新训练"
            >
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-xs leading-5 text-slate-600">
                <div className="font-semibold text-slate-800">当前注入策略</div>
                <div className="mt-1">
                  {injectScript ? "训练剧本" : ""}
                  {injectScript && injectRubric ? " + " : ""}
                  {injectRubric ? "评分标准" : ""}
                  {!injectScript && !injectRubric ? "尚未选择注入内容" : ""}
                  {injectScript || injectRubric
                    ? ` · ${injectMode === "append" ? "追加到现有内容" : "清空选中内容后重建"}`
                    : ""}
                </div>
                {targetUrl && (
                  <div
                    className="mt-1 truncate text-slate-400"
                    title={targetUrl}
                  >
                    目标：{targetUrl}
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={!plan || isBusy}
                onClick={() => setShowInjectModal(true)}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                <UploadCloud className="h-4 w-4" />
                打开注入配置
              </button>
            </Panel>
          </section>

          <section className="space-y-5">
            <GraphSnapshot
              snapshot={source}
              selectedNodeIds={selectedNodeIds}
              optimizeScoring={optimizeScoring}
              disabled={isBusy}
              onSelectedNodeIdsChange={(next) => {
                setSelectedNodeIds(next);
                invalidatePlan();
              }}
              onOptimizeScoringChange={(next) => {
                setOptimizeScoring(next);
                invalidatePlan();
              }}
            />
            <PlanPreview
              plan={plan}
              validationWarnings={validationWarnings}
              onDownload={downloadPlan}
            />
            <LogPanel
              log={log}
              error={error}
              onClear={() => {
                setLog("");
                setError("");
              }}
            />
          </section>
        </div>
      </div>
      <RefinementInjectModal
        isOpen={showInjectModal}
        targetUrl={targetUrl}
        injectScript={injectScript}
        injectRubric={injectRubric}
        injectMode={injectMode}
        confirmImport={confirmImport}
        plan={plan}
        log={log}
        error={error}
        loading={loading}
        canDryRun={canDryRun}
        canImport={canImport}
        onClose={() => !isBusy && setShowInjectModal(false)}
        onTargetUrlChange={(value) => {
          setTargetUrl(value);
          setConfirmImport(false);
        }}
        onInjectScriptChange={(value) => {
          setInjectScript(value);
          setConfirmImport(false);
        }}
        onInjectRubricChange={(value) => {
          setInjectRubric(value);
          setConfirmImport(false);
        }}
        onInjectModeChange={(value) => {
          setInjectMode(value);
          setConfirmImport(false);
        }}
        onConfirmImportChange={setConfirmImport}
        onDryRun={() => callApi("dry-run")}
        onImport={async () => {
          const succeeded = await callApi("import");
          if (succeeded) setShowInjectModal(false);
        }}
      />
    </main>
  );
}

function RefinementInjectModal({
  isOpen,
  targetUrl,
  injectScript,
  injectRubric,
  injectMode,
  confirmImport,
  plan,
  log,
  error,
  loading,
  canDryRun,
  canImport,
  onClose,
  onTargetUrlChange,
  onInjectScriptChange,
  onInjectRubricChange,
  onInjectModeChange,
  onConfirmImportChange,
  onDryRun,
  onImport,
}: {
  isOpen: boolean;
  targetUrl: string;
  injectScript: boolean;
  injectRubric: boolean;
  injectMode: TrainingInjectionMode;
  confirmImport: boolean;
  plan: TrainingRefinementPlan | null;
  log: string;
  error: string;
  loading: "extract" | "optimize" | "dry-run" | "import" | null;
  canDryRun: boolean;
  canImport: boolean;
  onClose: () => void;
  onTargetUrlChange: (value: string) => void;
  onInjectScriptChange: (value: boolean) => void;
  onInjectRubricChange: (value: boolean) => void;
  onInjectModeChange: (value: TrainingInjectionMode) => void;
  onConfirmImportChange: (value: boolean) => void;
  onDryRun: () => Promise<boolean>;
  onImport: () => Promise<void>;
}) {
  if (!isOpen) return null;
  const busy = loading === "dry-run" || loading === "import";
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="max-h-[92vh] w-full max-w-3xl overflow-auto rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">注入新训练</h2>
            <p className="mt-1 text-xs text-slate-500">
              与能力训练基础版共用注入内容和覆盖/追加选项
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="关闭注入配置"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 p-5">
          <div className="space-y-1.5">
            <FieldLabel>目标训练完整页面 URL</FieldLabel>
            <TextInput
              value={targetUrl}
              disabled={busy}
              onChange={(event) => onTargetUrlChange(event.target.value)}
              placeholder="粘贴平台目标能力训练的完整 URL"
            />
            <p className="text-[11px] text-slate-400">
              目标训练必须与源训练不同；注入剧本时 URL 需包含 courseId。
            </p>
          </div>

          <TrainingInjectionOptions
            injectScript={injectScript}
            injectRubric={injectRubric}
            injectMode={injectMode}
            hasScript={Boolean(plan?.nodes.length)}
            hasRubric={Boolean(plan?.scoreItems?.length)}
            disabled={busy}
            modeAppliesToAllSelected
            onInjectScriptChange={onInjectScriptChange}
            onInjectRubricChange={onInjectRubricChange}
            onInjectModeChange={onInjectModeChange}
          />

          <div className="grid grid-cols-3 gap-2 rounded-lg border border-indigo-100 bg-indigo-50/60 p-3">
            <Stat
              label="待注入卡片"
              value={injectScript ? plan?.nodes.length || 0 : 0}
            />
            <Stat
              label="待注入连线"
              value={injectScript ? plan?.flows.length || 0 : 0}
            />
            <Stat
              label="待注入评分项"
              value={injectRubric ? plan?.scoreItems?.length || 0 : 0}
            />
          </div>

          <div
            className={`rounded-lg border px-3 py-2.5 text-xs leading-5 ${injectMode === "replace" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}
          >
            {injectMode === "replace" ? (
              <>
                覆盖重建只会清除本次勾选的内容：
                {injectScript ? "目标节点与连线" : ""}
                {injectScript && injectRubric ? "、" : ""}
                {injectRubric ? "目标评分项" : ""}。未勾选内容保持不变。
              </>
            ) : (
              <>
                追加模式会保留原配置；剧本将从目标训练的安全末端卡片接入，评分项追加在现有评分项之后。
              </>
            )}
          </div>

          <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-900">
            <input
              type="checkbox"
              checked={confirmImport}
              disabled={busy}
              onChange={(event) => onConfirmImportChange(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-amber-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span>
              我已核对目标训练、注入内容和写入模式，确认执行此次注入。
            </span>
          </label>

          {(log || error) && (
            <pre
              className={`max-h-48 overflow-auto whitespace-pre-wrap rounded-lg px-3 py-2.5 text-xs leading-5 ${error ? "bg-red-50 text-red-800 ring-1 ring-red-100" : "bg-slate-950 text-slate-100"}`}
            >
              {error || log}
            </pre>
          )}
        </div>

        <div className="grid grid-cols-1 gap-2 border-t border-slate-100 bg-slate-50 px-5 py-4 sm:grid-cols-3">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <ActionButton
            disabled={!canDryRun}
            onClick={() => void onDryRun()}
            loading={loading === "dry-run"}
            icon={<PlayCircle className="h-4 w-4" />}
            secondary
          >
            Dry-run 预检
          </ActionButton>
          <ActionButton
            disabled={!canImport}
            onClick={() => void onImport()}
            loading={loading === "import"}
            icon={<UploadCloud className="h-4 w-4" />}
          >
            正式注入
          </ActionButton>
        </div>
      </div>
    </div>
  );
}

function CredentialsPanel({
  authorization,
  cookie,
  setAuthorization,
  setCookie,
}: {
  authorization: string;
  cookie: string;
  setAuthorization: (value: string) => void;
  setCookie: (value: string) => void;
}) {
  return (
    <Panel
      icon={<Shield className="h-4 w-4 text-slate-500" />}
      title="平台认证凭证"
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <FieldLabel>Authorization</FieldLabel>
          <TextInput
            type="password"
            value={authorization}
            onChange={(event) => setAuthorization(event.target.value)}
            placeholder="Bearer eyJhb..."
            className="font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <FieldLabel>Cookie</FieldLabel>
          <TextInput
            type="password"
            value={cookie}
            onChange={(event) => setCookie(event.target.value)}
            placeholder="SESSION=..."
            className="font-mono"
          />
        </div>
      </div>
      <div className="mt-3 flex items-center gap-1.5 text-xs text-slate-400">
        <Key className="h-3.5 w-3.5" />
        与能力训练注入、拆分/合并共用本地凭证
      </div>
    </Panel>
  );
}

function GraphSnapshot({
  snapshot,
  selectedNodeIds,
  optimizeScoring,
  disabled,
  onSelectedNodeIdsChange,
  onOptimizeScoringChange,
}: {
  snapshot: TrainingGraphSnapshot | null;
  selectedNodeIds: string[];
  optimizeScoring: boolean;
  disabled: boolean;
  onSelectedNodeIdsChange: (value: string[]) => void;
  onOptimizeScoringChange: (value: boolean) => void;
}) {
  const selectedIds = new Set(selectedNodeIds);
  const setNodeSelected = (nodeId: string, selected: boolean) => {
    if (selected) {
      onSelectedNodeIdsChange(
        Array.from(new Set([...selectedNodeIds, nodeId])),
      );
      return;
    }
    onSelectedNodeIdsChange(selectedNodeIds.filter((id) => id !== nodeId));
  };

  return (
    <Panel
      icon={<Network className="h-4 w-4 text-indigo-500" />}
      title="源训练完整配置"
    >
      {!snapshot ? (
        <EmptyState text="拉取后会展示任务配置、全部卡片与出边、附件、评分标准和字段继承情况。" />
      ) : (
        <div className="space-y-4">
          <div>
            <div className="font-semibold text-slate-900">
              {snapshot.taskName}
            </div>
            {snapshot.description && (
              <p className="mt-1 line-clamp-3 text-xs leading-5 text-slate-500">
                {snapshot.description}
              </p>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            <Stat label="卡片" value={snapshot.nodeCount} />
            <Stat label="连线" value={snapshot.flowCount} />
            <Stat label="分支点" value={snapshot.branchNodeIds.length} />
            <Stat label="附件" value={snapshot.resourceCount} />
            <Stat label="评分项" value={snapshot.scoreItems.length} />
            <Stat label="总分" value={snapshot.scoreTotal} />
          </div>
          <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-xs font-semibold text-violet-900">
                  本次 AI 优化范围
                </div>
                <p className="mt-1 text-[11px] leading-5 text-violet-700">
                  已选 {selectedNodeIds.length}/{snapshot.nodes.length}{" "}
                  张卡片。未选卡片只向 AI 提供名称与连线，完整 Prompt
                  和配置在注入时原样继承。
                </p>
              </div>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={
                    disabled || selectedNodeIds.length === snapshot.nodes.length
                  }
                  onClick={() =>
                    onSelectedNodeIdsChange(
                      snapshot.nodes.map((node) => node.id),
                    )
                  }
                  className="rounded border border-violet-200 bg-white px-2 py-1 text-[11px] font-medium text-violet-700 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  全选
                </button>
                <button
                  type="button"
                  disabled={disabled || selectedNodeIds.length === 0}
                  onClick={() => onSelectedNodeIdsChange([])}
                  className="rounded border border-violet-200 bg-white px-2 py-1 text-[11px] font-medium text-violet-700 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  清空
                </button>
              </div>
            </div>
            <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-md border border-violet-100 bg-white px-3 py-2 text-xs leading-5 text-slate-700">
              <input
                type="checkbox"
                checked={optimizeScoring}
                disabled={disabled}
                onChange={(event) =>
                  onOptimizeScoringChange(event.target.checked)
                }
                className="mt-0.5 h-4 w-4 rounded border-violet-300 text-violet-600 focus:ring-violet-500"
              />
              <span>
                <span className="font-semibold text-slate-800">
                  同时优化评分标准
                </span>
                <span className="block text-[11px] text-slate-500">
                  关闭后只传入评分项名称与分值，详细要求不进入模型，注入时原样继承。
                </span>
              </span>
            </label>
          </div>
          <div className="rounded-md border border-indigo-100 bg-indigo-50/60 px-3 py-2.5 text-xs leading-5 text-indigo-900">
            <div className="font-semibold">完整配置继承</div>
            已拉取任务配置 {snapshot.configurationInventory.taskFieldCount}{" "}
            个字段、 卡片配置 {snapshot.configurationInventory.nodeFieldCount}{" "}
            个字段、连线配置 {snapshot.configurationInventory.flowFieldCount}{" "}
            个字段。正式注入时以平台原始 DTO 为底稿完整克隆，AI
            主要按教师意见覆盖 Prompt、开场白、描述和必要的架构字段。
            <details className="mt-1 text-[11px] text-indigo-700">
              <summary className="cursor-pointer">查看已识别的配置字段</summary>
              <div className="mt-1 break-words">
                卡片：
                {snapshot.configurationInventory.nodeFieldNames.join("、") ||
                  "-"}
              </div>
              <div className="mt-1 break-words">
                连线：
                {snapshot.configurationInventory.flowFieldNames.join("、") ||
                  "-"}
              </div>
            </details>
          </div>
          <ScoreItemsPreview
            title="源训练评分标准"
            items={snapshot.scoreItems}
          />
          {(snapshot.warnings.length > 0 || snapshot.hasCycle) && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
              {snapshot.hasCycle && <div>• 检测到循环路径</div>}
              {snapshot.warnings.map((warning) => (
                <div key={warning}>• {warning}</div>
              ))}
            </div>
          )}
          <div className="max-h-[34rem] space-y-2 overflow-auto pr-1">
            <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">
              START
              <ArrowRight className="h-3.5 w-3.5" />
              {snapshot.entryNodeIds.length} 个入口
            </div>
            {snapshot.nodes.map((node, index) => {
              const selected = selectedIds.has(node.id);
              return (
                <div
                  key={node.id}
                  className={`rounded-lg border p-3 transition ${selected ? "border-violet-300 bg-violet-50/40" : "border-slate-200 bg-white"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-2">
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={disabled}
                        aria-label={`选择卡片 ${node.name}`}
                        onChange={(event) =>
                          setNodeSelected(node.id, event.target.checked)
                        }
                        className="mt-0.5 h-4 w-4 shrink-0 rounded border-violet-300 text-violet-600 focus:ring-violet-500"
                      />
                      <div className="min-w-0">
                        <div className="text-[11px] font-medium text-indigo-500">
                          卡片 {index + 1} · {selected ? "交给 AI" : "原样继承"}
                        </div>
                        <div
                          className="truncate text-sm font-semibold text-slate-800"
                          title={node.name}
                        >
                          {node.name}
                        </div>
                      </div>
                    </div>
                    <span className="shrink-0 rounded bg-slate-100 px-2 py-1 text-[11px] text-slate-500">
                      {node.interactiveRounds} 轮 · {node.resourceCount} 附件
                    </span>
                  </div>
                  <div className="mt-2 space-y-1.5 border-t border-slate-100 pt-2">
                    {node.outgoing.length === 0 ? (
                      <div className="text-xs text-red-600">没有出边</div>
                    ) : (
                      node.outgoing.map((edge, edgeIndex) => (
                        <div
                          key={`${edge.to}_${edgeIndex}`}
                          className="flex items-start gap-2 text-xs leading-5 text-slate-600"
                        >
                          <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-400" />
                          <div className="min-w-0">
                            <span className="font-medium text-slate-800">
                              {edge.toName}
                            </span>
                            <span
                              className={`ml-1 rounded px-1.5 py-0.5 text-[10px] ${edge.isDefault ? "bg-indigo-50 text-indigo-700" : "bg-amber-50 text-amber-700"}`}
                            >
                              {edge.isDefault ? "默认" : "条件"}
                            </span>
                            {edge.condition && (
                              <div className="mt-0.5 break-words text-[11px] text-slate-400">
                                {edge.condition}
                              </div>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600">
              END · {snapshot.exitNodeIds.length} 个出口
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

function PlanPreview({
  plan,
  validationWarnings,
  onDownload,
}: {
  plan: TrainingRefinementPlan | null;
  validationWarnings: string[];
  onDownload: () => void;
}) {
  return (
    <Panel
      icon={<Sparkles className="h-4 w-4 text-indigo-500" />}
      title="AI 优化方案"
      action={
        plan ? (
          <button
            type="button"
            onClick={onDownload}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          >
            <Download className="h-3.5 w-3.5" />
            导出 JSON
          </button>
        ) : null
      }
    >
      {!plan ? (
        <EmptyState text="填写教师意见后生成方案；系统会在展示前校验 START/END、可达性和分支默认边。" />
      ) : (
        <div className="space-y-4">
          <div>
            <div className="font-semibold text-slate-900">{plan.taskName}</div>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              {plan.summary}
            </p>
          </div>
          <div className="rounded-md border border-indigo-100 bg-indigo-50/70 px-3 py-2.5 text-xs leading-5 text-indigo-900">
            <div className="mb-1 font-semibold">架构理由</div>
            {plan.architectureRationale}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="优化后卡片" value={plan.nodes.length} />
            <Stat label="优化后连线" value={plan.flows.length} />
            <Stat label="优化后评分项" value={plan.scoreItems?.length || 0} />
          </div>
          <ScoreItemsPreview
            title="优化后评分标准"
            items={plan.scoreItems || []}
          />
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              变更清单
            </div>
            <div className="max-h-56 space-y-1.5 overflow-auto">
              {plan.changes.map((change, index) => (
                <div
                  key={`${change.target}_${index}`}
                  className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-xs leading-5"
                >
                  <div className="flex items-center gap-2">
                    <ChangeBadge type={change.type} />
                    <span className="font-medium text-slate-800">
                      {change.target}
                    </span>
                  </div>
                  <div className="mt-0.5 text-slate-500">{change.reason}</div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              优化后连线图
            </div>
            <div className="max-h-80 space-y-1.5 overflow-auto rounded-md border border-slate-200 p-2">
              {plan.flows.map((flow) => (
                <div
                  key={flow.id}
                  className="grid grid-cols-[minmax(0,1fr)_20px_minmax(0,1fr)] items-start gap-1 rounded bg-slate-50 px-2 py-2 text-[11px] leading-4 text-slate-600"
                >
                  <span className="break-all font-medium text-slate-800">
                    {flow.from}
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 text-indigo-400" />
                  <div className="min-w-0">
                    <span className="break-all font-medium text-slate-800">
                      {flow.to}
                    </span>
                    <span
                      className={`ml-1 rounded px-1 py-0.5 text-[9px] ${flow.isDefault ? "bg-indigo-100 text-indigo-700" : "bg-amber-100 text-amber-700"}`}
                    >
                      {flow.isDefault ? "默认" : "条件"}
                    </span>
                    {flow.condition && (
                      <div className="mt-1 break-words text-slate-400">
                        {flow.condition}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {[...validationWarnings, ...plan.warnings].length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
              {[...validationWarnings, ...plan.warnings].map((warning) => (
                <div key={warning}>• {warning}</div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800">
            <CheckCircle2 className="h-4 w-4" />
            图谱结构与评分标准已通过校验
          </div>
        </div>
      )}
    </Panel>
  );
}

function ScoreItemsPreview({
  title,
  items,
}: {
  title: string;
  items: TrainingScoreItem[];
}) {
  const total = items.reduce((sum, item) => sum + Number(item.score || 0), 0);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
        <span>{title}</span>
        <span className="normal-case text-slate-400">
          {items.length} 项 · {total} 分
        </span>
      </div>
      {items.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-200 px-3 py-3 text-xs text-slate-400">
          当前训练没有评分项。
        </div>
      ) : (
        <div className="max-h-72 space-y-2 overflow-auto pr-1">
          {items.map((item, index) => (
            <details
              key={`${item.itemId || item.itemName}_${index}`}
              className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs"
            >
              <summary className="cursor-pointer font-medium text-slate-800">
                {item.itemName} · {item.score} 分
              </summary>
              {item.description && (
                <p className="mt-2 whitespace-pre-wrap leading-5 text-slate-500">
                  {item.description}
                </p>
              )}
              <p className="mt-2 whitespace-pre-wrap rounded bg-white px-2 py-2 leading-5 text-slate-600">
                {item.requireDetail}
              </p>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function LogPanel({
  log,
  error,
  onClear,
}: {
  log: string;
  error: string;
  onClear: () => void;
}) {
  return (
    <Panel
      icon={<Terminal className="h-4 w-4 text-emerald-600" />}
      title="执行日志"
      action={
        <button
          type="button"
          onClick={onClear}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          清空
        </button>
      }
    >
      <pre
        className={`min-h-36 max-h-96 overflow-auto whitespace-pre-wrap rounded-md px-3 py-3 text-xs leading-5 ${error ? "bg-red-50 text-red-800 ring-1 ring-red-100" : "bg-slate-950 text-slate-100"}`}
      >
        {error || log || "等待拉取源训练……"}
      </pre>
    </Panel>
  );
}

function Panel({
  icon,
  title,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          {icon}
          {title}
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
      {children}
    </label>
  );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`h-10 w-full rounded-md border border-slate-200 px-3 text-sm text-slate-800 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 ${props.className || ""}`}
    />
  );
}

function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full resize-y rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 ${props.className || ""}`}
    />
  );
}

function ActionButton({
  children,
  disabled,
  onClick,
  loading,
  icon,
  secondary,
}: {
  children: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
  loading: boolean;
  icon: React.ReactNode;
  secondary?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 ${secondary ? "border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100" : "bg-indigo-600 text-white hover:bg-indigo-700"}`}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50 px-6 text-center">
      <FileStack className="mb-2 h-6 w-6 text-slate-300" />
      <p className="max-w-md text-xs leading-5 text-slate-500">{text}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-slate-100 bg-slate-50 px-2 py-2 text-center">
      <div className="text-lg font-bold text-slate-800">{value}</div>
      <div className="text-[10px] text-slate-400">{label}</div>
    </div>
  );
}

function ChangeBadge({
  type,
}: {
  type: TrainingRefinementPlan["changes"][number]["type"];
}) {
  const styles = {
    keep: "bg-slate-200 text-slate-700",
    update: "bg-indigo-100 text-indigo-700",
    add: "bg-emerald-100 text-emerald-700",
    remove: "bg-red-100 text-red-700",
    reconnect: "bg-amber-100 text-amber-700",
  };
  const labels = {
    keep: "保留",
    update: "修改",
    add: "新增",
    remove: "删除",
    reconnect: "重连",
  };
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${styles[type]}`}
    >
      {labels[type]}
    </span>
  );
}
