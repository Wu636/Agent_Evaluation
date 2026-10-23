"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Copy, FolderUp, Loader2, UploadCloud } from "lucide-react";
import { collectProjectAssets, isHtmlFile, type ProjectAsset } from "@/lib/html-project-publisher";
import { collectZipProjectAssets } from "@/lib/project-publish-input";
import { executeProjectPublish, inspectProjectForPublishing, type ProjectPublishPreflight } from "@/lib/project-publish-preflight";
import { PROJECT_PUBLISH_LIMITS } from "@/lib/project-publish-online";
import { reuseOrUploadProjectFile, type UploadUrlState } from "@/lib/project-upload-cache";

type Phase = "idle" | "reading" | "checking" | "ready" | "blocked" | "publishing" | "publish-error" | "published";

interface Props {
  hasPlatformCredentials: boolean;
  savePlatformCredentials: () => void;
  uploadFile: (file: File, onProgress?: (progress: number) => void) => Promise<{ ossUrl?: string; fileId?: string }>;
  verifyOssUrl: (url: string, file: File) => Promise<UploadUrlState>;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ProjectPublishInterface({ hasPlatformCredentials, savePlatformCredentials, uploadFile, verifyOssUrl }: Props) {
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [entryPath, setEntryPath] = useState("");
  const [report, setReport] = useState<ProjectPublishPreflight | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ url: string; count: number; warnings: string[] } | null>(null);
  const directoryRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const selectionId = useRef(0);
  const publishing = useRef(false);
  const htmlFiles = useMemo(() => assets.filter((asset) => isHtmlFile(asset.path)), [assets]);
  const errors = report?.diagnostics.filter((item) => item.severity === "error") || [];
  const warnings = report?.diagnostics.filter((item) => item.severity === "warning") || [];
  const uploadCount = report ? report.rawAssetPaths.length + report.cssPaths.length + report.scriptPaths.length
    + report.secondaryHtmlPaths.length + 1 : 0;

  useEffect(() => {
    directoryRef.current?.setAttribute("webkitdirectory", "");
    directoryRef.current?.setAttribute("directory", "");
  }, []);

  const inspect = async (selected: ProjectAsset[], entry: string, id: number) => {
    setReport(null);
    setResult(null);
    if (!selected.length) { setPhase("idle"); setMessage("没有读取到项目文件。"); return; }
    if (selected.length > PROJECT_PUBLISH_LIMITS.maxFiles) {
      setPhase("blocked"); setMessage("项目超过 500 个文件，请精简后重新选择。"); return;
    }
    const size = selected.reduce((sum, asset) => sum + asset.file.size, 0);
    if (size > PROJECT_PUBLISH_LIMITS.maxProjectBytes) {
      setPhase("blocked"); setMessage("项目超过 300 MB，请精简后重新选择。"); return;
    }
    if (!entry) { setPhase("blocked"); setMessage("项目中没有 HTML 页面，请选择包含 index.html 的文件夹或 ZIP。"); return; }
    setPhase("checking");
    setMessage("正在本地检查文件和资源路径…");
    try {
      const checked = await inspectProjectForPublishing(selected, entry);
      if (selectionId.current !== id) return;
      setReport(checked);
      const blockers = checked.diagnostics.filter((item) => item.severity === "error");
      setPhase(blockers.length ? "blocked" : "ready");
      setMessage(blockers.length ? `发现 ${blockers.length} 处需要修正的资源路径，见下方详情。`
        : `本地检查通过：将发布 ${checked.rawAssetPaths.length + checked.cssPaths.length + checked.scriptPaths.length + checked.secondaryHtmlPaths.length + 1} 个文件。`);
    } catch (error) {
      if (selectionId.current !== id) return;
      setPhase("blocked");
      setMessage(error instanceof Error ? error.message : "项目检查失败，请重新选择。");
    }
  };

  const selectAssets = (selected: ProjectAsset[], duplicates: string[]) => {
    const id = ++selectionId.current;
    const html = selected.filter((asset) => isHtmlFile(asset.path));
    const entry = (html.find((asset) => /^index\.html?$/i.test(asset.path))
      || html.find((asset) => /(^|\/)index\.html?$/i.test(asset.path)) || html[0])?.path || "";
    setAssets(selected);
    setEntryPath(entry);
    setProgress(0);
    if (duplicates.length) setMessage(`已忽略 ${duplicates.length} 个重复路径，正在检查项目…`);
    void inspect(selected, entry, id);
  };

  const onDirectoryChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    const selected = collectProjectAssets(files);
    selectAssets(selected.assets, selected.duplicates);
  };

  const readZip = async (file?: File) => {
    if (!file) return;
    const id = ++selectionId.current;
    setPhase("reading"); setReport(null); setResult(null); setMessage("正在读取 ZIP 项目包…");
    try {
      const selected = await collectZipProjectAssets(file);
      if (selectionId.current !== id) return;
      selectAssets(selected.assets, selected.duplicates);
    } catch (error) {
      if (selectionId.current !== id) return;
      setAssets([]); setEntryPath(""); setPhase("blocked");
      setMessage(error instanceof Error ? error.message : "ZIP 项目包读取失败。");
    }
  };

  const onZipChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    void readZip(file);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const file = Array.from(event.dataTransfer.files).find((item) => /\.zip$/i.test(item.name));
    if (file) void readZip(file);
    else setMessage("请拖入 ZIP 项目包，或点击按钮选择项目文件夹。");
  };

  const publish = async () => {
    if (publishing.current || (phase !== "ready" && phase !== "publish-error") || !report) return;
    if (!hasPlatformCredentials) {
      setPhase("publish-error");
      setMessage("请先在页面上方填写平台 Authorization 和 Cookie，再点击发布。");
      return;
    }
    publishing.current = true;
    setPhase("publishing"); setProgress(0); setResult(null);
    savePlatformCredentials();
    try {
      const current = await inspectProjectForPublishing(assets, entryPath);
      if (current.fingerprint !== report.fingerprint || current.diagnostics.some((item) => item.severity === "error")) {
        throw new Error("项目文件已变化，请重新选择后发布。");
      }
      let completed = 0;
      const publishWarnings = new Set(warnings.map((item) => item.message));
      if (report.skippedPaths.length) publishWarnings.add(`已跳过 ${report.skippedPaths.length} 个未用于网页运行的文件。`);
      const published = await executeProjectPublish(assets, current, async (asset, file) => {
        setMessage(`正在上传并验证 ${asset.path}（${completed + 1}/${uploadCount}）…`);
        const cached = await reuseOrUploadProjectFile({
          file, path: asset.path,
          sourceHash: file === asset.file ? current.fileHashes[asset.path] : undefined,
          verify: (url) => verifyOssUrl(url, file),
          upload: async () => {
            const data = await uploadFile(file, (percent) => setProgress(Math.min(99, Math.round((completed + percent / 100) / uploadCount * 100))));
            if (!data.ossUrl) throw new Error(`平台未返回资源链接：${asset.path}`);
            return { ossUrl: data.ossUrl, fileId: data.fileId };
          },
        });
        if (!cached.persisted) publishWarnings.add("浏览器未保存上传记录；重试时可能重新上传已完成文件。");
        completed += 1;
        setProgress(Math.min(99, Math.round(completed / uploadCount * 100)));
        return cached.ossUrl;
      });
      setProgress(100); setPhase("published");
      setResult({ url: published.entryUrl, count: published.publicUrls.size, warnings: [...publishWarnings] });
      setMessage("项目已发布，入口链接已验证。");
    } catch (error) {
      setPhase("publish-error");
      setMessage(error instanceof Error ? error.message : "发布中断，请检查网络和凭证后重试。");
    } finally { publishing.current = false; }
  };

  return <div>
    <input ref={directoryRef} type="file" multiple className="hidden" onChange={onDirectoryChange} aria-label="选择项目文件夹" />
    <input ref={zipRef} type="file" accept=".zip,application/zip" className="hidden" onChange={onZipChange} aria-label="选择 ZIP 项目包" />
    <div onDragOver={(event) => event.preventDefault()} onDrop={onDrop} className="rounded-xl border-2 border-dashed border-indigo-200 bg-indigo-50/50 p-6 text-center">
      <FolderUp className="mx-auto h-7 w-7 text-indigo-600" />
      <p className="mt-2 font-semibold text-slate-800">选择项目文件夹或 ZIP 包</p>
      <p className="mt-1 text-sm text-slate-600">选完自动检查；通过后点击发布，即可得到在线链接。</p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <button type="button" disabled={phase === "publishing"} onClick={() => directoryRef.current?.click()} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">选择文件夹</button>
        <button type="button" disabled={phase === "publishing"} onClick={() => zipRef.current?.click()} className="rounded-lg border border-indigo-300 bg-white px-4 py-2 text-sm font-semibold text-indigo-700 disabled:opacity-50">选择 ZIP</button>
      </div>
      <p className="mt-3 text-xs text-slate-500">也可把 ZIP 拖到这里。项目只在点击发布后上传。</p>
    </div>
    {assets.length > 0 && <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-sm font-semibold text-slate-800">已读取 {assets.length} 个文件 · {formatBytes(assets.reduce((sum, asset) => sum + asset.file.size, 0))}</p>
      <label className="mt-3 block text-sm text-slate-700">网页入口
        <select value={entryPath} disabled={phase === "publishing"} onChange={(event) => {
          const next = event.target.value; setEntryPath(next); void inspect(assets, next, ++selectionId.current);
        }} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2">
          {htmlFiles.map((asset) => <option key={asset.path} value={asset.path}>{asset.path}</option>)}
        </select>
      </label>
    </div>}
    {message && <div role="status" className={`mt-4 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${phase === "ready" || phase === "published" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : phase === "blocked" || phase === "publish-error" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
      {phase === "reading" || phase === "checking" || phase === "publishing" ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" /> : phase === "ready" || phase === "published" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}{message}
    </div>}
    {errors.length > 0 && <ul className="mt-3 max-h-56 list-disc overflow-auto rounded-lg border border-rose-200 bg-white p-4 pl-8 text-xs text-rose-800">{errors.map((item, index) => <li key={`${item.code}-${index}`}>{item.message}</li>)}</ul>}
    {(phase === "ready" || phase === "publish-error") && <div className="mt-4 flex flex-wrap items-center gap-3">
      <button type="button" onClick={() => void publish()} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"><UploadCloud className="h-4 w-4" />发布项目并获取链接</button>
      <span className="text-xs text-slate-500">检查在本地完成，无需等待后台任务。</span>
    </div>}
    {phase === "publishing" && <div className="mt-4"><div className="h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-indigo-600" style={{ width: `${progress}%` }} /></div><p className="mt-1 text-xs text-indigo-700">上传进度 {progress}%</p></div>}
    {report && (warnings.length > 0 || report.skippedPaths.length > 0 || report.requiredFlows.length > 0) && <details className="mt-4 rounded-lg border border-slate-200 p-3 text-xs text-slate-600"><summary className="cursor-pointer font-medium">检查提示</summary>
      <p className="mt-2">本地检查覆盖资源路径；需要登录、点击或跳转才能出现的交互请在发布后打开链接检查。</p>
      {report.skippedPaths.length > 0 && <p className="mt-1">{report.skippedPaths.length} 个未用于网页运行的文件不会上传。</p>}
      {report.requiredFlows.length > 0 && <p className="mt-1">项目含 {report.requiredFlows.length} 个流程配置，发布后请按配置检查。</p>}
      {warnings.length > 0 && <ul className="mt-2 list-disc pl-4">{warnings.map((item, index) => <li key={`${item.code}-${index}`}>{item.message}</li>)}</ul>}
    </details>}
    {result && <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4"><p className="font-semibold text-emerald-900">发布成功 · {result.count} 个文件</p>
      <div className="mt-3 flex items-center gap-2 rounded-lg bg-white p-2"><a href={result.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-xs text-emerald-800 underline">{result.url}</a><button type="button" onClick={() => void navigator.clipboard.writeText(result.url)} className="inline-flex items-center gap-1 text-xs text-emerald-700"><Copy className="h-3.5 w-3.5" />复制</button></div>
      {result.warnings.length > 0 && <details className="mt-2 text-xs text-amber-800"><summary>发布提示（{result.warnings.length}）</summary><ul className="mt-1 list-disc pl-4">{result.warnings.map((item) => <li key={item}>{item}</li>)}</ul></details>}
    </div>}
  </div>;
}
