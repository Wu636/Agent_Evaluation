"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  FileText,
  GitMerge,
  Key,
  Layers,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Route,
  Shield,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
} from "lucide-react";
import { loadLLMSettingsFromStorage } from "@/lib/llm/settings";

type Operation = "split" | "merge";
type ImportMode = "replace" | "append";
type MergeMode = "sequential" | "branch";

interface SourceTarget {
  id: string;
  sourceUrl: string;
}

interface SplitPlanGroup {
  level: number;
  title: string;
  reason?: string;
  nodeIds: string[];
  nodeNames: string[];
  targetUrl?: string;
}

interface SplitPlan {
  kind: "split";
  summary: string;
  groups: SplitPlanGroup[];
  unassignedNodes: string[];
  warnings: string[];
  planner: "llm" | "heuristic";
}

interface MergePlanSource {
  index: number;
  trainTaskId: string;
  title: string;
  nodeCount: number;
  firstNodeNames: string[];
  lastNodeNames: string[];
}

interface MergePlanConnection {
  from: string;
  to: string;
  type: "start" | "internal" | "cross" | "branch" | "end";
  label: string;
}

interface MergePlan {
  kind: "merge";
  summary: string;
  mode: MergeMode;
  renumber: boolean;
  sources: MergePlanSource[];
  connections: MergePlanConnection[];
  warnings: string[];
  planner: "llm" | "heuristic";
}

interface ApiResult {
  ok?: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  command?: string[];
  plan?: SplitPlan | MergePlan;
}

const CREDENTIAL_STORAGE_KEY = "training-injector-credentials";
const makeId = () => `${Date.now()}_${Math.random().toString(36).slice(2)}`;
const makeSource = (): SourceTarget => ({ id: makeId(), sourceUrl: "" });

function joinLog(result: ApiResult): string {
  return [result.error, result.stdout, result.stderr].filter(Boolean).join("\n\n").trim();
}

export function TrainingSplitMergeInterface() {
  const [operation, setOperation] = useState<Operation>("split");
  const [authorization, setAuthorization] = useState("");
  const [cookie, setCookie] = useState("");
  const [userLogic, setUserLogic] = useState("");

  const [splitSourceUrl, setSplitSourceUrl] = useState("");
  const [splitPlan, setSplitPlan] = useState<SplitPlan | null>(null);

  const [mergeTargetUrl, setMergeTargetUrl] = useState("");
  const [mergeMode, setMergeMode] = useState<MergeMode>("sequential");
  const [renumber, setRenumber] = useState(true);
  const [sources, setSources] = useState<SourceTarget[]>([makeSource(), makeSource()]);
  const [mergePlan, setMergePlan] = useState<MergePlan | null>(null);

  const [importMode, setImportMode] = useState<ImportMode>("replace");
  const [confirmImport, setConfirmImport] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState("");
  const [error, setError] = useState("");
  const [command, setCommand] = useState<string[]>([]);

  const hasCredentials = authorization.trim().length > 0 && cookie.trim().length > 0;
  const activePlan = operation === "split" ? splitPlan : mergePlan;

  useEffect(() => {
    try {
      const stored = localStorage.getItem(CREDENTIAL_STORAGE_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as { authorization?: string; cookie?: string };
      setAuthorization(parsed.authorization || "");
      setCookie(parsed.cookie || "");
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    setConfirmImport(false);
    setCommand([]);
    setError("");
    setLog("");
  }, [operation]);

  useEffect(() => {
    if (operation === "split") setSplitPlan(null);
  }, [splitSourceUrl, userLogic, operation]);

  useEffect(() => {
    if (operation === "merge") setMergePlan(null);
  }, [mergeTargetUrl, sources, mergeMode, renumber, userLogic, operation]);

  const saveCredentials = () => {
    if (!hasCredentials) return;
    localStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify({ authorization: authorization.trim(), cookie: cookie.trim() }));
  };

  const llmSettings = () => {
    const settings = loadLLMSettingsFromStorage("trainingGenerate");
    return {
      apiKey: settings.apiKey,
      apiUrl: settings.apiUrl,
      model: settings.model,
    };
  };

  const canPlan = useMemo(() => {
    if (planning || !hasCredentials) return false;
    if (operation === "split") return splitSourceUrl.trim().length > 0;
    return mergeTargetUrl.trim().length > 0 && sources.filter((item) => item.sourceUrl.trim()).length >= 2;
  }, [hasCredentials, mergeTargetUrl, operation, planning, sources, splitSourceUrl]);

  const canDryRun = useMemo(() => {
    if (running || !hasCredentials || !activePlan) return false;
    if (operation === "split") return Boolean(splitPlan?.groups.length);
    return mergeTargetUrl.trim().length > 0;
  }, [activePlan, hasCredentials, mergeTargetUrl, operation, running, splitPlan]);

  const canImport = useMemo(() => {
    if (running || !hasCredentials || !activePlan || !confirmImport) return false;
    if (operation === "split") {
      return Boolean(splitPlan?.groups.every((group) => group.targetUrl?.trim()));
    }
    return mergeTargetUrl.trim().length > 0;
  }, [activePlan, confirmImport, hasCredentials, mergeTargetUrl, operation, running, splitPlan]);

  const commandPreview = useMemo(() => {
    if (command.length > 0) return command.join(" ");
    if (!activePlan) return "先生成规划，确认分组/合并路径后再执行 dry-run 或导入";
    if (operation === "split") return "抓取源训练 -> 写入临时 JSON -> 按确认规划执行 split_training.py";
    return `按确认规划执行 merge_training.py --mode ${mergePlan?.mode || mergeMode} ${mergePlan?.renumber ? "--renumber" : ""}`;
  }, [activePlan, command, mergeMode, mergePlan, operation]);

  const resetOutput = () => {
    setLog("");
    setError("");
    setCommand([]);
  };

  const addSource = () => {
    if (sources.length >= 10) return;
    setSources((items) => [...items, makeSource()]);
  };

  const updateSource = (id: string, sourceUrl: string) => {
    setSources((items) => items.map((item) => (item.id === id ? { ...item, sourceUrl } : item)));
  };

  const removeSource = (id: string) => {
    setSources((items) => items.filter((item) => item.id !== id));
  };

  const updateSplitGroupTarget = (level: number, targetUrl: string) => {
    setSplitPlan((plan) => {
      if (!plan) return plan;
      return {
        ...plan,
        groups: plan.groups.map((group) => (group.level === level ? { ...group, targetUrl } : group)),
      };
    });
  };

  const buildBasePayload = () => ({
    credentials: {
      authorization: authorization.trim(),
      cookie: cookie.trim(),
    },
    userLogic: userLogic.trim(),
    llmSettings: llmSettings(),
  });

  const handlePlan = async () => {
    resetOutput();
    saveCredentials();
    setPlanning(true);
    setConfirmImport(false);

    const body =
      operation === "split"
        ? {
            ...buildBasePayload(),
            operation,
            action: "plan",
            sourceUrl: splitSourceUrl.trim(),
          }
        : {
            ...buildBasePayload(),
            operation,
            action: "plan",
            targetUrl: mergeTargetUrl.trim(),
            sourceUrls: sources.map((item) => item.sourceUrl.trim()).filter(Boolean),
            mode: mergeMode,
            renumber,
          };

    try {
      const response = await fetch("/api/training-split-merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as ApiResult;
      if (!response.ok || !result.ok || !result.plan) {
        setError(joinLog(result) || "规划失败。");
        return;
      }
      if (result.plan.kind === "split") setSplitPlan(result.plan);
      if (result.plan.kind === "merge") setMergePlan(result.plan);
      setLog(result.plan.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "规划请求失败。");
    } finally {
      setPlanning(false);
    }
  };

  const handleExecute = async (action: "dry-run" | "import") => {
    resetOutput();
    saveCredentials();
    setRunning(true);

    const body =
      operation === "split"
        ? {
            ...buildBasePayload(),
            operation,
            action,
            sourceUrl: splitSourceUrl.trim(),
            splitPlan,
            importMode,
            confirmImport: action === "import" ? confirmImport : true,
            targets: splitPlan?.groups.map((group) => ({
              level: group.level,
              targetUrl: group.targetUrl || "",
            })) || [],
          }
        : {
            ...buildBasePayload(),
            operation,
            action,
            targetUrl: mergeTargetUrl.trim(),
            mergePlan,
            importMode,
            confirmImport: action === "import" ? confirmImport : true,
          };

    try {
      const response = await fetch("/api/training-split-merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as ApiResult;
      setCommand(result.command || []);
      const output = joinLog(result);
      if (!response.ok || !result.ok) {
        setError(output || "执行失败。");
      } else {
        setLog(output || "执行完成。");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "请求失败。");
    } finally {
      setRunning(false);
    }
  };

  return (
    <main className="min-h-[calc(100vh-4rem)] bg-slate-50">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50">
              <GitMerge className="h-5 w-5 text-indigo-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">能力训练拆分/合并</h1>
              <p className="text-sm text-slate-500">先生成规划，看清卡片与流转，再选择追加或覆盖导入</p>
            </div>
          </div>
          <div className="flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
            <SegmentButton active={operation === "split"} onClick={() => setOperation("split")}>
              <Layers className="h-4 w-4" />
              拆分
            </SegmentButton>
            <SegmentButton active={operation === "merge"} onClick={() => setOperation("merge")}>
              <GitMerge className="h-4 w-4" />
              合并
            </SegmentButton>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(380px,0.9fr)]">
          <section className="space-y-5">
            <CredentialsPanel
              authorization={authorization}
              cookie={cookie}
              setAuthorization={setAuthorization}
              setCookie={setCookie}
            />

            <LogicPanel userLogic={userLogic} setUserLogic={setUserLogic} operation={operation} />

            {operation === "split" ? (
              <SplitInputPanel sourceUrl={splitSourceUrl} setSourceUrl={setSplitSourceUrl} />
            ) : (
              <MergeInputPanel
                targetUrl={mergeTargetUrl}
                setTargetUrl={setMergeTargetUrl}
                mergeMode={mergeMode}
                setMergeMode={setMergeMode}
                renumber={renumber}
                setRenumber={setRenumber}
                sources={sources}
                updateSource={updateSource}
                removeSource={removeSource}
                addSource={addSource}
              />
            )}

            <PlanActionPanel
              canPlan={canPlan}
              planning={planning}
              canDryRun={canDryRun}
              canImport={canImport}
              running={running}
              importMode={importMode}
              setImportMode={setImportMode}
              confirmImport={confirmImport}
              setConfirmImport={setConfirmImport}
              onPlan={handlePlan}
              onDryRun={() => handleExecute("dry-run")}
              onImport={() => handleExecute("import")}
            />
          </section>

          <section className="space-y-5">
            {operation === "split" ? (
              <SplitPlanPreview plan={splitPlan} updateGroupTarget={updateSplitGroupTarget} />
            ) : (
              <MergePlanPreview plan={mergePlan} />
            )}

            <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                  <Terminal className="h-4 w-4 text-emerald-600" />
                  执行预览
                </div>
                <button
                  type="button"
                  onClick={resetOutput}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  清空
                </button>
              </div>
              <div className="p-4">
                <pre className="max-h-32 overflow-auto rounded-md bg-slate-950 px-3 py-2 text-xs leading-5 text-slate-100">
                  {commandPreview}
                </pre>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">
                <FileText className="h-4 w-4 text-slate-500" />
                运行日志
              </div>
              <div className="p-4">
                <pre
                  className={`min-h-72 max-h-[30rem] overflow-auto whitespace-pre-wrap rounded-md px-3 py-3 text-xs leading-5 ${
                    error ? "bg-red-50 text-red-800 ring-1 ring-red-100" : "bg-slate-950 text-slate-100"
                  }`}
                >
                  {error || log || "等待规划..."}
                </pre>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function SegmentButton({
  active,
  children,
  compact,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  compact?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md font-medium transition-colors ${
        compact ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm"
      } ${active ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
    >
      {children}
    </button>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">{children}</label>;
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`h-10 w-full rounded-md border border-slate-200 px-3 text-sm text-slate-800 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50 ${
        props.className || ""
      }`}
    />
  );
}

function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full resize-y rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 ${
        props.className || ""
      }`}
    />
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
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">
        <Shield className="h-4 w-4 text-slate-500" />
        平台认证凭证
      </div>
      <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
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
      <div className="flex items-center gap-1.5 border-t border-slate-100 px-4 py-2 text-xs text-slate-400">
        <Key className="h-3.5 w-3.5" />
        与配置注入共用本地凭证缓存
      </div>
    </div>
  );
}

function LogicPanel({
  operation,
  userLogic,
  setUserLogic,
}: {
  operation: Operation;
  userLogic: string;
  setUserLogic: (value: string) => void;
}) {
  const placeholder =
    operation === "split"
      ? "例如：把关卡1-2放到一个训练，关卡3单独一个训练，选择分支卡保留在第一个训练里。"
      : "例如：先完成基础训练，再进入两个分支训练；第2、第3个源训练作为并行分支，最后都结束。";
  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">
        <Sparkles className="h-4 w-4 text-indigo-500" />
        拆分/合并逻辑
      </div>
      <div className="space-y-2 p-4">
        <TextArea
          rows={4}
          value={userLogic}
          onChange={(event) => setUserLogic(event.target.value)}
          placeholder={placeholder}
        />
        <p className="text-xs text-slate-400">填写自然语言说明后，系统会优先用模型规划；没有模型配置时会按规则生成可编辑预览。</p>
      </div>
    </div>
  );
}

function SplitInputPanel({ sourceUrl, setSourceUrl }: { sourceUrl: string; setSourceUrl: (value: string) => void }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">
        <Layers className="h-4 w-4 text-indigo-500" />
        源训练
      </div>
      <div className="space-y-1.5 p-4">
        <FieldLabel>源训练页面 URL</FieldLabel>
        <TextInput value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="从平台地址栏复制已搭建好的源训练页面 URL" />
      </div>
    </div>
  );
}

function MergeInputPanel({
  targetUrl,
  setTargetUrl,
  mergeMode,
  setMergeMode,
  renumber,
  setRenumber,
  sources,
  updateSource,
  removeSource,
  addSource,
}: {
  targetUrl: string;
  setTargetUrl: (value: string) => void;
  mergeMode: MergeMode;
  setMergeMode: (value: MergeMode) => void;
  renumber: boolean;
  setRenumber: (value: boolean) => void;
  sources: SourceTarget[];
  updateSource: (id: string, sourceUrl: string) => void;
  removeSource: (id: string) => void;
  addSource: () => void;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">
        <GitMerge className="h-4 w-4 text-indigo-500" />
        合并输入
      </div>
      <div className="space-y-4 p-4">
        <div className="space-y-1.5">
          <FieldLabel>目标训练页面 URL</FieldLabel>
          <TextInput value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} placeholder="空白目标训练页面 URL" />
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex rounded-lg bg-slate-100 p-1">
            <SegmentButton active={mergeMode === "sequential"} compact onClick={() => setMergeMode("sequential")}>
              串联
            </SegmentButton>
            <SegmentButton active={mergeMode === "branch"} compact onClick={() => setMergeMode("branch")}>
              分支
            </SegmentButton>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={renumber}
              onChange={(event) => setRenumber(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            关卡续编号
          </label>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-700">源训练页面 URL</div>
            <button type="button" onClick={addSource} className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
              <Plus className="h-3.5 w-3.5" />
              添加
            </button>
          </div>
          {sources.map((item, index) => (
            <div key={item.id} className="grid grid-cols-[72px_minmax(0,1fr)_36px] gap-2">
              <div className="flex h-10 items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-500">
                <Link2 className="h-3.5 w-3.5" />
                {index + 1}
              </div>
              <TextInput value={item.sourceUrl} onChange={(event) => updateSource(item.id, event.target.value)} placeholder="源训练页面 URL" />
              <IconButton label="删除" onClick={() => removeSource(item.id)} disabled={sources.length <= 2}>
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PlanActionPanel({
  canPlan,
  planning,
  canDryRun,
  canImport,
  running,
  importMode,
  setImportMode,
  confirmImport,
  setConfirmImport,
  onPlan,
  onDryRun,
  onImport,
}: {
  canPlan: boolean;
  planning: boolean;
  canDryRun: boolean;
  canImport: boolean;
  running: boolean;
  importMode: ImportMode;
  setImportMode: (value: ImportMode) => void;
  confirmImport: boolean;
  setConfirmImport: (value: boolean) => void;
  onPlan: () => void;
  onDryRun: () => void;
  onImport: () => void;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="space-y-4 p-4">
        <button
          type="button"
          onClick={onPlan}
          disabled={!canPlan}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {planning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Route className="h-4 w-4" />}
          {planning ? "正在生成规划..." : "生成规划"}
        </button>

        <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-1">
          <SegmentButton active={importMode === "replace"} compact onClick={() => setImportMode("replace")}>
            覆盖重建
          </SegmentButton>
          <SegmentButton active={importMode === "append"} compact onClick={() => setImportMode("append")}>
            追加到现有
          </SegmentButton>
        </div>
        <p className="text-xs text-slate-400">
          覆盖重建会先清除目标训练原有节点和连线；追加到现有会复用已有 START/END，并保留原卡片和连线。
        </p>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onDryRun}
            disabled={!canDryRun || running}
            className="flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Terminal className="h-4 w-4" />}
            Dry-run
          </button>
          <button
            type="button"
            onClick={onImport}
            disabled={!canImport || running}
            className="flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            正式导入
          </button>
        </div>
        <label className="flex items-start gap-3 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={confirmImport}
            onChange={(event) => setConfirmImport(event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
          />
          <span>我已检查规划和导入策略，确认执行正式导入</span>
        </label>
      </div>
    </div>
  );
}

function SplitPlanPreview({
  plan,
  updateGroupTarget,
}: {
  plan: SplitPlan | null;
  updateGroupTarget: (level: number, targetUrl: string) => void;
}) {
  if (!plan) return <EmptyPlan />;
  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <PlanHeader title="拆分规划预览" planner={plan.planner} summary={plan.summary} />
      <div className="space-y-3 p-4">
        {plan.warnings.map((warning) => (
          <WarningLine key={warning}>{warning}</WarningLine>
        ))}
        {plan.groups.map((group) => (
          <div key={group.level} className="rounded-lg border border-slate-200 p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-800">{group.title}</div>
                <div className="text-xs text-slate-400">{group.reason}</div>
              </div>
              <span className="rounded-full bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700">{group.nodeIds.length} 卡片</span>
            </div>
            <div className="max-h-28 overflow-auto rounded-md bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
              {group.nodeNames.map((name) => (
                <div key={name}>· {name}</div>
              ))}
            </div>
            <div className="mt-3 space-y-1.5">
              <FieldLabel>此组导入到哪个目标训练 URL</FieldLabel>
              <TextInput value={group.targetUrl || ""} onChange={(event) => updateGroupTarget(group.level, event.target.value)} placeholder="空白目标训练页面 URL" />
            </div>
          </div>
        ))}
        {plan.unassignedNodes.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            未分配卡片：{plan.unassignedNodes.join("、")}
          </div>
        )}
      </div>
    </div>
  );
}

function MergePlanPreview({ plan }: { plan: MergePlan | null }) {
  if (!plan) return <EmptyPlan />;
  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <PlanHeader title="合并规划预览" planner={plan.planner} summary={plan.summary} />
      <div className="space-y-3 p-4">
        {plan.warnings.map((warning) => (
          <WarningLine key={warning}>{warning}</WarningLine>
        ))}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-md bg-slate-50 px-3 py-2 text-slate-600">模式：{plan.mode === "branch" ? "分支" : "串联"}</div>
          <div className="rounded-md bg-slate-50 px-3 py-2 text-slate-600">续编号：{plan.renumber ? "是" : "否"}</div>
        </div>
        <div className="space-y-2">
          {plan.sources.map((source) => (
            <div key={source.index} className="rounded-lg border border-slate-200 p-3">
              <div className="text-sm font-semibold text-slate-800">{source.title}</div>
              <div className="mt-1 text-xs text-slate-500">业务卡片 {source.nodeCount} 个</div>
              <div className="mt-2 text-xs text-slate-400">首节点：{source.firstNodeNames.join("、") || "未识别"}</div>
              <div className="text-xs text-slate-400">末节点：{source.lastNodeNames.join("、") || "未识别"}</div>
            </div>
          ))}
        </div>
        <div className="rounded-lg bg-slate-950 p-3 text-xs leading-6 text-slate-100">
          {plan.connections.map((connection, index) => (
            <div key={`${connection.from}-${connection.to}-${index}`}>
              {connection.from} → {connection.to} <span className="text-slate-400">({connection.label})</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PlanHeader({ title, planner, summary }: { title: string; planner: "llm" | "heuristic"; summary: string }) {
  return (
    <div className="border-b border-slate-100 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-slate-700">{title}</div>
        <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-500">{planner === "llm" ? "模型规划" : "规则规划"}</span>
      </div>
      <p className="mt-1 text-xs text-slate-500">{summary}</p>
    </div>
  );
}

function WarningLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function EmptyPlan() {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-400">
      先填写左侧信息并生成规划
    </div>
  );
}

function IconButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-10 w-10 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
