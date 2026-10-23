"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { Upload } from "tus-js-client";
import { AlertCircle, CheckCircle2, Copy, FolderUp, Loader2, RefreshCw, ShieldCheck, Trash2, UploadCloud } from "lucide-react";
import { collectProjectAssets, isHtmlFile, type ProjectAsset } from "@/lib/html-project-publisher";
import { executeProjectPublish, sha256File, type BrowserAuditReport, type ProjectPublishPreflight } from "@/lib/project-publish-preflight";
import { reuseOrUploadProjectFile, type UploadUrlState } from "@/lib/project-upload-cache";
import { PROJECT_PUBLISH_LIMITS } from "@/lib/project-publish-online";

const LAST_JOB_KEY = "online-project-publish-last-job";
const FLOW_CONFIG_PATH = "polymas-publish-flows.json";
const TUS_CHUNK_BYTES = 6 * 1024 * 1024;

interface JobSnapshot {
  id: string;
  status: string;
  expiresAt: string;
  releaseUrl?: string | null;
  releaseResult?: { assetCount?: number } | null;
  progress?: { phase?: string; completed?: number; total?: number };
  revision: {
    id: string;
    entryPath: string;
    status: string;
    manifest: Array<{ path: string; size: number; type: string; sha256: string; storagePath: string }>;
    fingerprint: string | null;
    preflightReport: ProjectPublishPreflight | null;
    browserAudit: BrowserAuditReport | null;
    repairs: RepairSuggestion[];
    warnings: string[];
    error: string | null;
  };
}

interface RepairSuggestion {
  id: string;
  source: string;
  reference: string;
  replacement: string;
  targetPath: string;
  reason: string;
  diagnosticCode: string;
}

interface ConfirmedProject {
  jobId: string;
  revisionId: string;
  entryPath: string;
  fingerprint: string;
  files: Array<{ path: string; size: number; type: string; sha256: string; url: string }>;
  preflightReport: ProjectPublishPreflight;
  browserAudit: BrowserAuditReport;
  warnings: string[];
}

interface Props {
  hasPlatformCredentials: boolean;
  savePlatformCredentials: () => void;
  uploadFile: (file: File, onProgress?: (progress: number) => void) => Promise<{ ossUrl?: string; fileId?: string }>;
  verifyOssUrl: (url: string, file: File) => Promise<UploadUrlState>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function api<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `请求失败（HTTP ${response.status}）。`);
  return payload;
}

function resumableEndpoint(): string {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) throw new Error("网页未配置 Supabase 项目地址。");
  const url = new URL(raw);
  const projectHost = url.hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i);
  if (projectHost) url.hostname = `${projectHost[1]}.storage.supabase.co`;
  url.pathname = "/storage/v1/upload/resumable";
  url.search = "";
  return url.toString();
}

function startTusUpload(file: File, endpoint: string, token: string, storagePath: string, fingerprint: string, onProgress: (value: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const upload = new Upload(file, {
      endpoint,
      headers: { "x-signature": token },
      metadata: {
        bucketName: "project-publish-staging",
        objectName: storagePath,
        contentType: file.type || "application/octet-stream",
        cacheControl: "3600",
      },
      chunkSize: TUS_CHUNK_BYTES,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      fingerprint: () => Promise.resolve(fingerprint),
      onError: (error) => reject(error),
      onProgress: (uploaded, total) => onProgress(total ? Math.round(uploaded / total * 100) : 0),
      onSuccess: () => resolve(),
    });
    void upload.findPreviousUploads().then((previous) => {
      if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    }).catch(reject);
  });
}

async function hashManifest(assets: ProjectAsset[]) {
  const entries: Array<{ path: string; size: number; type: string; sha256: string }> = [];
  for (const asset of assets) {
    entries.push({
      path: asset.path, size: asset.file.size,
      type: asset.file.type || "application/octet-stream", sha256: await sha256File(asset.file),
    });
  }
  return entries;
}

export function OnlineProjectPublishInterface({ hasPlatformCredentials, savePlatformCredentials, uploadFile, verifyOssUrl }: Props) {
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [entryPath, setEntryPath] = useState("");
  const [flowConfigText, setFlowConfigText] = useState("");
  const [flowConfigLoading, setFlowConfigLoading] = useState(false);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [selectedRepairs, setSelectedRepairs] = useState<Set<string>>(new Set());
  const [warningsAccepted, setWarningsAccepted] = useState(false);
  const [result, setResult] = useState<{ url: string; count: number; warnings: string[] } | null>(null);
  const directoryRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const flowLoadIdRef = useRef(0);
  const publishAssets = useMemo(() => {
    const sourceAssets = assets.filter((asset) => asset.path !== FLOW_CONFIG_PATH);
    const text = flowConfigText.trim();
    if (!text) return sourceAssets;
    const configFile = new File([text], FLOW_CONFIG_PATH, { type: "application/json" });
    return [...sourceAssets, { path: FLOW_CONFIG_PATH, file: configFile }].sort((a, b) => a.path.localeCompare(b.path));
  }, [assets, flowConfigText]);
  const htmlFiles = useMemo(() => publishAssets.filter((asset) => isHtmlFile(asset.path)), [publishAssets]);
  const totalBytes = useMemo(() => publishAssets.reduce((sum, asset) => sum + asset.file.size, 0), [publishAssets]);

  useEffect(() => {
    directoryRef.current?.setAttribute("webkitdirectory", "");
    directoryRef.current?.setAttribute("directory", "");
  }, []);

  const refreshJob = async (jobId: string) => {
    const response = await api<{ job: JobSnapshot }>(`/api/project-publish/jobs/${jobId}`);
    setJob(response.job);
    setEntryPath(response.job.revision.entryPath);
    setSelectedRepairs(new Set((response.job.revision.repairs || []).map((item) => item.id)));
    if (response.job.status === "published" && response.job.releaseUrl) {
      setResult({ url: response.job.releaseUrl, count: response.job.releaseResult?.assetCount || 0, warnings: response.job.revision.warnings || [] });
    }
    return response.job;
  };

  const pollJob = async (jobId: string) => {
    for (let attempt = 0; attempt < 720; attempt += 1) {
      const snapshot = await refreshJob(jobId);
      if (!["queued", "processing"].includes(snapshot.status)) {
        const names: Record<string, string> = {
          needs_repair: "发现可确定的路径修复候选，请检查差异并选择要应用的修复。",
          needs_attention: "预检发现需要人工处理的问题，请查看诊断后修正项目并重新上传。",
          passed: "静态资源预检与隔离浏览器巡检通过，可以检查报告并确认发布。",
          failed: snapshot.revision.error ? `在线预检任务失败（${snapshot.revision.error}）。` : "在线预检任务失败。",
          published: "项目已发布并完成 OSS 链接验证。",
        };
        setMessage(names[snapshot.status] || `任务状态：${snapshot.status}`);
        setProgress(snapshot.status === "passed" || snapshot.status === "published" ? 100 : 0);
        setProgressLabel("");
        return snapshot;
      }
      const taskProgress = snapshot.progress;
      if (taskProgress?.total) setProgress(Math.min(99, Math.round((taskProgress.completed || 0) / taskProgress.total * 100)));
      setProgressLabel(taskProgress?.phase === "browser_audit" ? "隔离浏览器正在逐页检查…" : "在线工作进程正在检查…");
      await new Promise((resolve) => window.setTimeout(resolve, 2500));
    }
    setMessage("预检仍在后台运行；任务已保存，可以稍后回来继续查看。");
  };

  useEffect(() => {
    const storedId = window.localStorage.getItem(LAST_JOB_KEY);
    if (!storedId) return;
    void refreshJob(storedId).then((restored) => {
      if (["queued", "processing"].includes(restored.status)) void pollJob(storedId);
      if (restored.status === "uploading") setMessage("已恢复未完成的暂存任务；重新选择同一项目文件夹后可继续上传。");
    }).catch(() => window.localStorage.removeItem(LAST_JOB_KEY));
    // Initial restoration should run once per mount; callbacks update local task state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onDirectoryChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files || []);
    event.target.value = "";
    const flowLoadId = ++flowLoadIdRef.current;
    const collected = collectProjectAssets(selected);
    setAssets(collected.assets);
    const flowAsset = collected.assets.find((asset) => asset.path === FLOW_CONFIG_PATH);
    if (flowAsset) {
      setFlowConfigLoading(true);
      void flowAsset.file.text().then((text) => {
        if (flowLoadId === flowLoadIdRef.current) setFlowConfigText(text);
      }).catch(() => { if (flowLoadId === flowLoadIdRef.current) setFlowConfigText(""); })
        .finally(() => { if (flowLoadId === flowLoadIdRef.current) setFlowConfigLoading(false); });
    } else {
      setFlowConfigLoading(false);
      setFlowConfigText("");
    }
    const html = collected.assets.filter((asset) => isHtmlFile(asset.path));
    const defaultEntry = html.find((asset) => /(^|\/)index\.html?$/i.test(asset.path)) || html[0];
    setEntryPath(defaultEntry?.path || "");
    setResult(null);
    setWarningsAccepted(false);
    if (collected.duplicates.length) setMessage(`已忽略 ${collected.duplicates.length} 个同路径重复文件。`);
    else setMessage(collected.assets.length ? "项目文件已读取，点击“开始在线预检”后网页会直接暂存并巡检。" : "未读取到项目文件。");
    if (job?.status !== "uploading") {
      setJob(null);
      window.localStorage.removeItem(LAST_JOB_KEY);
    }
  };

  const validateProject = () => {
    if (!publishAssets.length) throw new Error("请先选择项目文件夹。");
    if (!entryPath || !htmlFiles.some((asset) => asset.path === entryPath)) throw new Error("请选择项目入口 HTML。");
    if (publishAssets.length > PROJECT_PUBLISH_LIMITS.maxFiles) throw new Error(`项目最多支持 ${PROJECT_PUBLISH_LIMITS.maxFiles} 个文件。`);
    if (totalBytes > PROJECT_PUBLISH_LIMITS.maxProjectBytes) throw new Error(`项目总大小超过 ${Math.round(PROJECT_PUBLISH_LIMITS.maxProjectBytes / 1024 / 1024)} MB。`);
    if (flowConfigText.trim()) {
      let config: unknown;
      try { config = JSON.parse(flowConfigText); } catch { throw new Error("关键流程配置必须是有效 JSON。"); }
      if (!config || typeof config !== "object" || !Array.isArray((config as { flows?: unknown }).flows)) {
        throw new Error("关键流程配置需要包含 flows 数组。");
      }
    }
    const tooLarge = publishAssets.find((asset) => asset.file.size > PROJECT_PUBLISH_LIMITS.maxFileBytes);
    if (tooLarge) throw new Error(`文件 ${tooLarge.path} 超过 ${Math.round(PROJECT_PUBLISH_LIMITS.maxFileBytes / 1024 / 1024)} MB 限额。`);
  };

  const uploadAndQueue = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage("");
    setProgress(0);
    try {
      validateProject();
      setProgressLabel("正在计算文件指纹…");
      const manifest = await hashManifest(publishAssets);
      let activeJob = job;
      if (!activeJob || activeJob.status !== "uploading") {
        const created = await api<{ jobId: string; revisionId: string; expiresAt: string; fileCount: number; totalBytes: number }>(
          "/api/project-publish/jobs", "POST", { entryPath, files: manifest },
        );
        window.localStorage.setItem(LAST_JOB_KEY, created.jobId);
        await refreshJob(created.jobId);
        activeJob = await api<{ job: JobSnapshot }>(`/api/project-publish/jobs/${created.jobId}`).then((value) => value.job);
      } else {
        const staged = activeJob.revision.manifest;
        if (activeJob.revision.entryPath !== entryPath || staged.length !== manifest.length
          || staged.some((file, index) => file.path !== manifest[index]?.path || file.sha256 !== manifest[index]?.sha256)) {
          throw new Error("所选文件与未完成任务不一致。请清除旧任务后重新开始在线预检。");
        }
      }
      if (!activeJob) throw new Error("在线预检任务没有创建成功，请重新开始。");
      setJob(activeJob);
      const endpoint = resumableEndpoint();
      let completedBytes = 0;
      for (let offset = 0; offset < publishAssets.length; offset += 50) {
        const batch = publishAssets.slice(offset, offset + 50);
        const issued = await api<{ tickets: Record<string, { token?: string; bucket: string; path: string; uploaded: boolean }> }>(
          `/api/project-publish/jobs/${activeJob.id}/upload-tickets`, "POST", { paths: batch.map((asset) => asset.path) },
        );
        for (let index = 0; index < batch.length; index += 1) {
          const asset = batch[index];
          const fileRecord = manifest[offset + index];
          const ticket = issued.tickets[asset.path];
          setProgressLabel(`正在暂存 ${offset + index + 1}/${publishAssets.length}：${asset.path}`);
          if (!ticket) throw new Error(`无法取得文件暂存许可：${asset.path}`);
          if (!ticket.uploaded) {
            if (!ticket.token || !ticket.path) throw new Error(`上传许可无效：${asset.path}`);
            await startTusUpload(
              asset.file, endpoint, ticket.token, ticket.path, `${activeJob.id}|${ticket.path}|${fileRecord.sha256}`,
              (partProgress) => setProgress(Math.min(99, Math.round((completedBytes + asset.file.size * partProgress / 100) / Math.max(1, totalBytes) * 100))),
            );
          }
          completedBytes += asset.file.size;
        }
      }
      await api(`/api/project-publish/jobs/${activeJob.id}/seal`, "POST");
      setProgressLabel("已暂存全部文件，后台预检已排队…");
      await pollJob(activeJob.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "在线预检启动失败。");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const applyRepairs = async () => {
    if (!job || !selectedRepairs.size) return;
    setBusy(true);
    busyRef.current = true;
    try {
      await api(`/api/project-publish/jobs/${job.id}/repairs`, "POST", { selectedIds: [...selectedRepairs] });
      setMessage("已创建修复版本，正在重新进行静态扫描和浏览器巡检…");
      await pollJob(job.id);
    } catch (error) { setMessage(error instanceof Error ? error.message : "提交路径修复失败。"); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const recheck = async () => {
    if (!job) return;
    setBusy(true);
    busyRef.current = true;
    try {
      await api(`/api/project-publish/jobs/${job.id}/recheck`, "POST");
      await pollJob(job.id);
    } catch (error) { setMessage(error instanceof Error ? error.message : "重新预检失败。"); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const confirmAndPublish = async () => {
    if (!job || !["passed", "confirmed"].includes(job.status) || !job.revision.preflightReport) return;
    if (!warningsAccepted && (job.revision.warnings.length > 0 || !job.revision.browserAudit?.flows.length)) {
      setMessage("请先阅读并勾选预检限制与提示，再确认发布。");
      return;
    }
    if (!hasPlatformCredentials) { setMessage("请先在页面上方填写平台 Authorization 和 Cookie，再发布。预检阶段不会使用这些平台凭证。"); return; }
    setBusy(true);
    busyRef.current = true;
    setResult(null);
    try {
      setProgressLabel("正在锁定通过复检的项目版本…");
      savePlatformCredentials();
      const confirmed = await api<ConfirmedProject>(`/api/project-publish/jobs/${job.id}/confirm`, "POST", {
        acknowledgeLimitations: warningsAccepted,
      });
      const confirmedAssets: ProjectAsset[] = [];
      for (let index = 0; index < confirmed.files.length; index += 1) {
        const record = confirmed.files[index];
        setProgress(Math.round(index / Math.max(1, confirmed.files.length) * 20));
        setProgressLabel(`正在读取已确认版本 ${index + 1}/${confirmed.files.length}…`);
        const response = await fetch(record.url, { cache: "no-store" });
        if (!response.ok) throw new Error(`读取复检版本文件失败：${record.path}（HTTP ${response.status}）。`);
        const blob = await response.blob();
        const file = new File([blob], record.path.split("/").at(-1) || record.path, { type: record.type || blob.type || "application/octet-stream" });
        if (file.size !== record.size || await sha256File(file) !== record.sha256) throw new Error(`文件版本校验失败：${record.path}，请重新预检。`);
        confirmedAssets.push({ path: record.path, file });
      }

      const warnings = new Set(confirmed.warnings);
      const totalUploads = Math.max(1, confirmed.preflightReport.rawAssetPaths.length + confirmed.preflightReport.cssPaths.length
        + confirmed.preflightReport.scriptPaths.length + confirmed.preflightReport.secondaryHtmlPaths.length + 1);
      let completedUploads = 0;
      const uploadAsset = async (asset: ProjectAsset, file = asset.file) => {
        setProgressLabel(`正在发布并验证 ${asset.path}…`);
        const cached = await reuseOrUploadProjectFile({
          file, path: asset.path,
          sourceHash: file === asset.file ? confirmed.preflightReport.fileHashes[asset.path] : undefined,
          verify: (url) => verifyOssUrl(url, file),
          upload: async () => {
            const data = await uploadFile(file, (percent) => {
              setProgress(20 + Math.min(78, Math.round((completedUploads + percent / 100) / totalUploads * 78)));
            });
            if (!data.ossUrl) throw new Error(`平台没有返回 OSS 地址：${asset.path}`);
            return { ossUrl: data.ossUrl, fileId: data.fileId };
          },
        });
        if (!cached.persisted) warnings.add("当前浏览器未能保存 OSS 上传记录；失败重试时可能需要重新上传已完成文件。");
        completedUploads += 1;
        return cached.ossUrl;
      };
      const published = await executeProjectPublish(confirmedAssets, confirmed.preflightReport, uploadAsset);
      setProgress(99);
      setProgressLabel("正在登记已验证的入口链接…");
      await api(`/api/project-publish/jobs/${job.id}/release`, "POST", {
        entryPath: confirmed.entryPath, entryUrl: published.entryUrl,
        assetCount: published.publicUrls.size, replacementCount: published.replacementCount,
      });
      const nextJob = await refreshJob(job.id);
      setJob(nextJob);
      setProgress(100);
      setProgressLabel("");
      setResult({ url: published.entryUrl, count: published.publicUrls.size, warnings: [...warnings] });
      setMessage("项目文件已逐个上传并验证，入口链接已登记。");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "项目发布失败，请检查凭证后重试。";
      try {
        const latest = await api<{ job: JobSnapshot }>(`/api/project-publish/jobs/${job.id}`).then((value) => value.job);
        if (latest.status === "published" && latest.releaseUrl) {
          await refreshJob(job.id);
          setMessage("项目已发布并验证 OSS 链接。");
        } else setMessage(detail);
      } catch { setMessage(detail); }
    } finally { busyRef.current = false; setBusy(false); }
  };

  const clearJob = async () => {
    if (!job || busy) return;
    setBusy(true);
    try {
      await api(`/api/project-publish/jobs/${job.id}`, "DELETE");
      window.localStorage.removeItem(LAST_JOB_KEY);
      setJob(null); setResult(null); setMessage("临时项目任务已删除。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "删除任务失败。"); }
    finally { setBusy(false); }
  };

  const diagnostics = job?.revision.preflightReport?.diagnostics || [];
  const warnings = job?.revision.warnings || [];
  const suggestions = job?.revision.repairs || [];
  const hasPublishWarning = warnings.length > 0 || !job?.revision.browserAudit?.flows.length;

  return (
    <div>
      <input ref={directoryRef} type="file" multiple className="hidden" onChange={onDirectoryChange} />
      <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-4 text-sm leading-6 text-slate-700">
        <p className="flex items-center gap-2 font-semibold text-indigo-900"><ShieldCheck className="h-4 w-4" />在线预检、路径修复与确认发布</p>
        <p className="mt-1">项目文件直接暂存到私有空间；后台会检查资源路径并在隔离浏览器中逐页巡检。仅在你确认通过的版本后，网页才调用平台 OSS 上传。</p>
      </div>
      <div className="mt-4 flex min-h-44 flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-200 bg-slate-50/70 px-5 text-center">
        <div className="mb-3 rounded-xl bg-white p-3 shadow-sm"><FolderUp className="h-7 w-7 text-indigo-600" /></div>
        <p className="font-semibold text-slate-800">选择 HTML 项目文件夹</p>
        <p className="mt-1 text-sm text-slate-500">网页会保留目录结构；入口和图片、CSS、JavaScript 会一起检查。</p>
        <button type="button" onClick={() => directoryRef.current?.click()} disabled={busy} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300"><FolderUp className="h-4 w-4" />选择项目文件夹</button>
        <p className="mt-3 text-xs text-slate-400">建议使用 Chrome、Edge 或 Safari。单项目最多 500 个文件、300 MB。</p>
      </div>

      {assets.length > 0 && <div className="mt-4 space-y-4 rounded-xl border border-slate-200 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><p className="text-sm font-semibold text-slate-800">待预检 {publishAssets.length} 个文件 · {formatBytes(totalBytes)}</p><p className="mt-1 text-xs text-slate-500">系统文件、node_modules、.git 和凭证文件会自动忽略；其他文件按引用关系决定是否正式发布。</p></div>
          <button type="button" disabled={busy} onClick={() => { flowLoadIdRef.current += 1; setFlowConfigLoading(false); setAssets([]); setEntryPath(""); setFlowConfigText(""); setMessage(""); }} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" />清除所选文件</button>
        </div>
        <label className="block text-sm font-medium text-slate-700">网页入口 HTML
          <select value={entryPath} onChange={(event) => { setEntryPath(event.target.value); setJob(null); window.localStorage.removeItem(LAST_JOB_KEY); setMessage("入口已切换，请重新开始在线预检。"); }} disabled={busy || htmlFiles.length === 0} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
            {htmlFiles.length ? htmlFiles.map((asset) => <option key={asset.path} value={asset.path}>{asset.path}</option>) : <option value="">未发现 HTML 文件</option>}
          </select>
        </label>
        <details className="rounded-lg border border-slate-200 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-700">关键交互流程配置（可选）</summary>
          <p className="mt-2 text-xs leading-5 text-slate-500">填写后会作为项目根目录的 <code>polymas-publish-flows.json</code> 执行。步骤支持 click、select、fill、waitFor、expectPage、expectUrl、expectImage；例如：<code>{'{"flows":[{"name":"进入病例","steps":[{"click":"button.start"},{"expectPage":"scenes/inquiry.html"}]}]}'}</code>。选择了项目内已有配置时，会自动载入并可在这里修改。</p>
          <textarea value={flowConfigText} disabled={busy || flowConfigLoading} onChange={(event) => {
            setFlowConfigText(event.target.value);
            setJob(null);
            window.localStorage.removeItem(LAST_JOB_KEY);
            setWarningsAccepted(false);
            setResult(null);
            setMessage("关键流程配置已修改，请创建新任务重新预检。");
          }} spellCheck={false} rows={7} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-indigo-500" placeholder={'{"flows":[{"name":"主流程","steps":[{"click":"button.start"}]}]}'} />
        </details>
      </div>}

      {message && <div className={`mt-4 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${job?.status === "passed" || job?.status === "published" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{message}</div>}
      {(busy || progressLabel) && <div className="mt-4 space-y-1.5"><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${progress}%` }} /></div><p className="text-xs text-indigo-700">{progressLabel} {progress > 0 ? `${progress}%` : ""}</p></div>}

      {job && <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-semibold text-slate-800">在线任务：{job.status}</p><p className="mt-1 text-xs text-slate-500">版本 {job.revision.id} · 入口 {job.revision.entryPath} · 结果有效至 {new Date(job.expiresAt).toLocaleString()}</p></div><button type="button" onClick={() => void clearJob()} disabled={busy} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" />删除任务</button></div>
        {job.revision.preflightReport && <div className={`mt-3 rounded-lg border px-3 py-2.5 text-xs ${diagnostics.some((item) => item.severity === "error") ? "border-rose-200 bg-rose-50 text-rose-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>
          <p className="font-semibold">静态路径预检：{diagnostics.filter((item) => item.severity === "error").length} 个阻断，{diagnostics.filter((item) => item.severity === "warning").length} 个提示；{job.revision.preflightReport.skippedPaths.length} 个文件未进入发布清单。</p>
          {diagnostics.length > 0 && <ul className="mt-2 max-h-48 list-disc space-y-1 overflow-auto pl-4">{diagnostics.map((item, index) => <li key={`${item.code}-${index}`}><span className="font-mono">{item.source}{item.reference ? ` → ${item.reference}` : ""}</span>：{item.message}</li>)}</ul>}
        </div>}
        {job.revision.browserAudit && <div className={`mt-3 rounded-lg border px-3 py-2.5 text-xs ${job.revision.browserAudit.errors.length ? "border-rose-200 bg-rose-50 text-rose-800" : "border-sky-200 bg-sky-50 text-sky-800"}`}>
          <p className="font-semibold">浏览器巡检：{job.revision.browserAudit.coverage.checkedPages}/{job.revision.browserAudit.coverage.expectedPages} 个页面；{job.revision.browserAudit.coverage.passedFlows}/{job.revision.browserAudit.coverage.expectedFlows} 个关键流程。</p>
          {job.revision.browserAudit.errors.length > 0 && <ul className="mt-2 max-h-40 list-disc space-y-1 overflow-auto pl-4">{job.revision.browserAudit.errors.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>}
          {job.revision.browserAudit.warnings.length > 0 && <ul className="mt-2 max-h-32 list-disc space-y-1 overflow-auto pl-4">{job.revision.browserAudit.warnings.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>}
          {!job.revision.browserAudit.flows.length && <p className="mt-1">未配置关键流程；当前结果只覆盖页面加载，不能证明交互流程正常。</p>}
        </div>}
        {job.status === "needs_repair" && suggestions.length > 0 && <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <p className="font-semibold">确定性路径修复建议（仅匹配到唯一目标）</p>
          <div className="mt-2 space-y-2">{suggestions.map((suggestion) => <label key={suggestion.id} className="flex gap-2 rounded-md bg-white/80 p-2"><input type="checkbox" checked={selectedRepairs.has(suggestion.id)} onChange={(event) => setSelectedRepairs((current) => { const next = new Set(current); if (event.target.checked) next.add(suggestion.id); else next.delete(suggestion.id); return next; })} /><span className="min-w-0"><span className="block font-mono">{suggestion.source}</span><span className="mt-1 block break-all">{suggestion.reference} → {suggestion.replacement}</span><span className="mt-1 block text-amber-700">{suggestion.reason}</span></span></label>)}</div>
          <button type="button" onClick={() => void applyRepairs()} disabled={busy || !selectedRepairs.size} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-amber-600 px-3 py-2 font-semibold text-white disabled:bg-slate-300"><RefreshCw className="h-3.5 w-3.5" />应用所选修复并复检（{selectedRepairs.size}）</button>
        </div>}
        {["needs_attention", "failed"].includes(job.status) && <button type="button" onClick={() => void recheck()} disabled={busy} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-700 disabled:opacity-50"><RefreshCw className="h-3.5 w-3.5" />重新运行在线复检</button>}
        {["passed", "confirmed"].includes(job.status) && <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"><p className="flex items-center gap-2 font-semibold"><CheckCircle2 className="h-4 w-4" />复检通过，可以确认发布</p><p className="mt-1 text-xs">发布前页面会再次校验文件哈希，并按原有流程逐个上传和验证 OSS 地址。</p>
          {hasPublishWarning && <label className="mt-3 flex items-start gap-2 text-xs"><input type="checkbox" checked={warningsAccepted} onChange={(event) => setWarningsAccepted(event.target.checked)} /><span>我已阅读上方的覆盖范围和提示，理解未配置的交互流程及被隔离的外部资源未被完整验证。</span></label>}
          <button type="button" onClick={() => void confirmAndPublish()} disabled={busy || (hasPublishWarning && !warningsAccepted)} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300"><UploadCloud className="h-4 w-4" />确认并发布此版本</button>
        </div>}
      </div>}

      {job?.status === "uploading" && <button type="button" onClick={() => void uploadAndQueue()} disabled={busy || flowConfigLoading || assets.length === 0} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:bg-slate-300"><UploadCloud className="h-4 w-4" />继续暂存并开始在线预检</button>}
      {!job && assets.length > 0 && <button type="button" onClick={() => void uploadAndQueue()} disabled={busy || flowConfigLoading || !entryPath} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:bg-slate-300">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}开始在线预检</button>}

      {result && <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4"><p className="flex items-center gap-2 font-semibold text-emerald-900"><CheckCircle2 className="h-5 w-5" />项目已发布并验证 OSS 链接</p><p className="mt-1 text-sm text-emerald-800">发布 {result.count} 个文件。</p><div className="mt-3 flex items-center gap-2 rounded-lg bg-white p-2"><a href={result.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-mono text-xs text-emerald-800">{result.url}</a><button type="button" onClick={() => void navigator.clipboard.writeText(result.url)} className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-emerald-700"><Copy className="h-3.5 w-3.5" />复制</button></div>{result.warnings.length > 0 && <ul className="mt-3 list-disc pl-4 text-xs text-amber-800">{result.warnings.map((item) => <li key={item}>{item}</li>)}</ul>}</div>}
    </div>
  );
}
