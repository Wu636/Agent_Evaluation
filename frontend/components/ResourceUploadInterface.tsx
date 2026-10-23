"use client";

import { ChangeEvent, DragEvent, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clipboard,
  Copy,
  Eye,
  EyeOff,
  File as FileIcon,
  FileCode2,
  FileImage,
  FileText,
  FileVideo,
  FolderUp,
  Link as LinkIcon,
  Loader2,
  Music2,
  ShieldCheck,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { isHtmlFile } from "@/lib/html-project-publisher";
import { type UploadUrlState } from "@/lib/project-upload-cache";
import { ProjectPublishInterface } from "@/components/ProjectPublishInterface";

const CREDENTIAL_STORAGE_KEY = "polymas-resource-uploader-credentials";
const SHARED_CREDENTIAL_STORAGE_KEY = "training-injector-credentials";
const PLATFORM_UPLOAD_URL = "https://cloudapi.polymas.com/basic-resource/file/upload";
// The serverless proxy route rejects bodies above 4 MB; direct uploads skip it.
const MAX_PROXY_BYTES = 4 * 1024 * 1024;

type UploadStatus = "queued" | "uploading" | "success" | "error";
type UploadMode = "resource" | "project";

interface UploadItem {
  id: string;
  file: File;
  status: UploadStatus;
  progress: number;
  ossUrl?: string;
  fileId?: string;
  error?: string;
}

interface UploadResponse {
  success?: boolean;
  error?: string;
  data?: { fileId?: string; ossUrl?: string };
}

interface PlatformUploadResponse {
  success?: boolean;
  code?: number;
  msg?: string;
  message?: string;
  error?: string;
  data?: { fileId?: string; ossUrl?: string; fileUrl?: string };
}

function readCredentials(key: string): { authorization: string; cookie: string } | null {
  try {
    const stored = window.localStorage.getItem(key);
    if (!stored) return null;
    const value = JSON.parse(stored) as { authorization?: unknown; cookie?: unknown };
    return {
      authorization: typeof value.authorization === "string" ? value.authorization : "",
      cookie: typeof value.cookie === "string" ? value.cookie : "",
    };
  } catch {
    return null;
  }
}

function fileId(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function FileTypeIcon({ type, name }: { type: string; name: string }) {
  const className = "h-5 w-5";
  if (type.startsWith("image/")) return <FileImage className={`${className} text-pink-500`} />;
  if (type.startsWith("video/")) return <FileVideo className={`${className} text-violet-500`} />;
  if (type.startsWith("audio/")) return <Music2 className={`${className} text-amber-500`} />;
  if (/\.html?$/i.test(name)) return <FileCode2 className={`${className} text-orange-500`} />;
  if (/\.(txt|md|pdf|docx?)$/i.test(name)) return <FileText className={`${className} text-sky-500`} />;
  return <FileIcon className={`${className} text-slate-500`} />;
}

export function ResourceUploadInterface() {
  const [authorization, setAuthorization] = useState("");
  const [cookie, setCookie] = useState("");
  const [showCredentials, setShowCredentials] = useState(false);
  const [uploadMode, setUploadMode] = useState<UploadMode>("resource");
  const [items, setItems] = useState<UploadItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const credentials = readCredentials(CREDENTIAL_STORAGE_KEY) || readCredentials(SHARED_CREDENTIAL_STORAGE_KEY);
    if (!credentials) return;
    setAuthorization(credentials.authorization);
    setCookie(credentials.cookie);
  }, []);

  const updateItem = (id: string, update: Partial<UploadItem>) => {
    setItems((previous) => previous.map((item) => item.id === id ? { ...item, ...update } : item));
  };

  const addFiles = (files: FileList | File[]) => {
    const newItems = Array.from(files).map((file) => ({
      id: fileId(),
      file,
      status: "queued" as const,
      progress: 0,
    }));
    if (!newItems.length) return;
    setItems((previous) => [...previous, ...newItems]);
    setNotice("");
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) addFiles(event.target.files);
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    addFiles(event.dataTransfer.files);
  };

  const saveCredentials = () => {
    try {
      window.localStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify({
        authorization: authorization.trim(),
        cookie: cookie.trim(),
      }));
    } catch {
      // Browser storage may be unavailable; the current upload can continue.
    }
  };

  // The platform stores every chunk request as a standalone object instead
  // of merging parts server-side, so multi-part uploads leave only the last
  // part on OSS. CORS is open on the upload endpoint, therefore the browser
  // posts each file in a single request directly to the platform.
  const uploadDirectToPlatform = async (
    file: File,
    onProgress?: (progress: number) => void,
  ): Promise<NonNullable<UploadResponse["data"]>> => {
    const body = new FormData();
    body.append("identifyCode", fileId());
    body.append("name", file.name);
    body.append("chunk", "0");
    body.append("chunks", "1");
    body.append("size", String(file.size));
    body.append("file", file, file.name);

    const response = await fetch(PLATFORM_UPLOAD_URL, {
      method: "POST",
      headers: { Authorization: authorization.trim() },
      // Browsers cannot set the Cookie header; include mode lets the current
      // platform session cookies ride along automatically.
      credentials: "include",
      body,
    });
    const payload = await response.json().catch(() => ({})) as PlatformUploadResponse;
    const data = payload.data && typeof payload.data === "object" ? payload.data : {};
    const ossUrl = data.ossUrl || data.fileUrl || "";
    if (!response.ok || !(payload.success === true || payload.code === 200)) {
      throw new Error(String(payload.msg || payload.message || payload.error || `平台上传失败（HTTP ${response.status}）。`));
    }
    if (!ossUrl) {
      throw new Error("平台已接收文件，但没有返回 ossUrl。请确认当前账号拥有资源上传权限后重试。");
    }
    onProgress?.(100);
    return { ossUrl, fileId: data.fileId || "" };
  };

  const uploadViaProxy = async (
    file: File,
    onProgress?: (progress: number) => void,
  ): Promise<NonNullable<UploadResponse["data"]>> => {
    const body = new FormData();
    body.append("file", file, file.name);
    body.append("name", file.name);
    body.append("identifyCode", fileId());
    body.append("chunk", "0");
    body.append("chunks", "1");
    body.append("size", String(file.size));
    body.append("authorization", authorization.trim());
    body.append("cookie", cookie.trim());

    const response = await fetch("/api/resource-upload", { method: "POST", body });
    const payload = await response.json().catch(() => ({})) as UploadResponse;
    if (!response.ok || !payload.success) {
      throw new Error(payload.error || `上传失败（HTTP ${response.status}）。`);
    }
    if (!payload.data?.ossUrl) {
      throw new Error("平台已接收文件，但没有返回 ossUrl。请确认当前账号拥有资源上传权限后重试。");
    }
    onProgress?.(100);
    return payload.data;
  };

  const uploadFileToOss = async (
    file: File,
    onProgress?: (progress: number) => void,
  ): Promise<NonNullable<UploadResponse["data"]>> => {
    try {
      return await uploadDirectToPlatform(file, onProgress);
    } catch (error) {
      // TypeError means the browser blocked or failed the cross-origin
      // request entirely; the platform response itself is not retried via
      // the proxy because it would return the same result.
      if (!(error instanceof TypeError)) throw error;
      if (file.size > MAX_PROXY_BYTES) {
        throw new Error("浏览器直连平台上传失败，且文件超过 4 MB 无法改走服务器中转。请检查浏览器网络设置后重试。");
      }
      return uploadViaProxy(file, onProgress);
    }
  };

  const verifyOssUrl = async (ossUrl: string, file: File): Promise<UploadUrlState> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(`/api/resource-upload/verify?url=${encodeURIComponent(ossUrl)}&size=${file.size}&html=${isHtmlFile(file.name) ? "1" : "0"}`, { cache: "no-store", signal: AbortSignal.timeout(12000) });
        const result = await response.json() as { ok?: boolean; invalid?: boolean; status?: number };
        if (response.ok && result.ok) return "valid";
        if (result.invalid || response.status === 400 || [403, 404, 410].includes(result.status || 0)) return "invalid";
      } catch {
        // A short retry covers OSS propagation and transient network errors.
      }
      if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 400 * (attempt + 1)));
    }
    return "unavailable";
  };

  const uploadOne = async (item: UploadItem) => {
    updateItem(item.id, { status: "uploading", progress: 0, error: undefined, ossUrl: undefined });
    const lastData = await uploadFileToOss(item.file, (progress) => {
      updateItem(item.id, { progress });
    });
    updateItem(item.id, {
      status: "success",
      progress: 100,
      ossUrl: lastData.ossUrl,
      fileId: lastData.fileId,
    });
  };

  const uploadQueued = async (retryId?: string) => {
    if (!authorization.trim() || !cookie.trim()) {
      setNotice("请先填写平台 Authorization 和 Cookie。它们仅用于本次上传，并只会保存在当前浏览器中。");
      return;
    }
    const targets = retryId
      ? items.filter((item) => item.id === retryId)
      : items.filter((item) => item.status === "queued" || item.status === "error");
    if (!targets.length) return;

    saveCredentials();
    setNotice("");
    setIsUploading(true);
    for (const item of targets) {
      try {
        await uploadOne(item);
      } catch (error) {
        updateItem(item.id, {
          status: "error",
          error: error instanceof Error ? error.message : "上传失败，请重试。",
        });
      }
    }
    setIsUploading(false);
  };

  const copyText = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => current === key ? null : current), 1600);
    } catch {
      setNotice("复制失败，请手动选中链接复制。");
    }
  };

  const successItems = items.filter((item) => item.status === "success" && item.ossUrl);
  const queuedCount = items.filter((item) => item.status === "queued" || item.status === "error").length;

  return (
    <main className="min-h-[calc(100vh-4rem)] bg-gradient-to-b from-slate-50 to-white py-8 sm:py-12">
      <div className="mx-auto w-full max-w-5xl px-4 sm:px-6">
        <section className="mb-7 max-w-3xl">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
            <LinkIcon className="h-3.5 w-3.5" /> Polymas OSS 资源上传
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">{uploadMode === "project" ? "发布 HTML 项目，获取在线链接" : "上传本地资源，获取公网 ossUrl"}</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600 sm:text-base">{uploadMode === "project" ? "选择文件夹或 ZIP 后自动检查，确认无资源路径错误即可发布。" : "支持 HTML、图片、视频、音频及其他常见文件。上传完成后可复制公网链接，直接用于分享或在系统中引用。"}</p>
        </section>

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-5 py-4 sm:px-6">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><ShieldCheck className="h-4 w-4 text-emerald-600" /> 平台认证</div>
              <button type="button" onClick={() => setShowCredentials((value) => !value)} className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-700">
                {showCredentials ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}{showCredentials ? "收起" : "填写 / 查看"}
              </button>
            </div>
            {!showCredentials && <p className="mt-1 text-xs text-slate-500">{uploadMode === "project" ? "可以先选项目并完成本地检查，发布时再填写平台 Authorization 和 Cookie。" : "需要智慧树平台请求头中的 Authorization 和 Cookie。凭证不会写入服务器日志。"}</p>}
          </div>
          {showCredentials && <div className="grid gap-4 px-5 py-5 sm:grid-cols-2 sm:px-6">
            <label className="block text-sm font-medium text-slate-700">Authorization
              <textarea value={authorization} onChange={(event) => setAuthorization(event.target.value)} placeholder="粘贴 Authorization" rows={4} spellCheck={false} className="mt-1.5 w-full resize-y rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-800 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100" />
            </label>
            <label className="block text-sm font-medium text-slate-700">Cookie
              <textarea value={cookie} onChange={(event) => setCookie(event.target.value)} placeholder="粘贴完整 Cookie" rows={4} spellCheck={false} className="mt-1.5 w-full resize-y rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-800 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100" />
            </label>
            <p className="sm:col-span-2 text-xs leading-5 text-slate-500">凭证只保存到当前浏览器，便于下次使用；请勿在公共设备使用。服务端仅将其转发给 polymas 上传接口。</p>
          </div>}
        </section>

        <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-5 flex flex-wrap gap-2 border-b border-slate-100 pb-4">
            <button type="button" onClick={() => setUploadMode("resource")} className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition ${uploadMode === "resource" ? "bg-indigo-600 text-white shadow-sm" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}><UploadCloud className="h-4 w-4" />单个资源上传</button>
            <button type="button" onClick={() => setUploadMode("project")} className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition ${uploadMode === "project" ? "bg-indigo-600 text-white shadow-sm" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}><FolderUp className="h-4 w-4" />HTML 项目发布</button>
          </div>
          {uploadMode === "resource" ? <>
          <input ref={inputRef} type="file" multiple className="hidden" onChange={onFileChange} />
          <div
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") inputRef.current?.click(); }}
            onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => { if (event.currentTarget === event.target) setIsDragging(false); }}
            onDrop={onDrop}
            className={`flex min-h-48 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-5 text-center transition ${isDragging ? "border-indigo-500 bg-indigo-50" : "border-slate-200 bg-slate-50/70 hover:border-indigo-300 hover:bg-indigo-50/40"}`}
          >
            <div className="mb-3 rounded-xl bg-white p-3 shadow-sm"><UploadCloud className="h-7 w-7 text-indigo-600" /></div>
            <p className="font-semibold text-slate-800">拖放文件到这里，或点击选择文件</p>
            <p className="mt-1 text-sm text-slate-500">HTML、图片、视频、音频和其他资源均可上传</p>
            <p className="mt-3 text-xs text-slate-400">文件由浏览器直传平台 OSS，无需分片中转</p>
          </div>

          {notice && <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{notice}</div>}

          {items.length > 0 && <div className="mt-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-slate-700">待处理资源（{items.length}）</span>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setItems((previous) => previous.filter((item) => item.status === "success" || item.status === "uploading"))} disabled={isUploading} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50">清除未完成</button>
                <button type="button" onClick={() => void uploadQueued()} disabled={isUploading || queuedCount === 0} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300">
                  {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}{isUploading ? "正在上传" : `上传 ${queuedCount} 个文件`}
                </button>
              </div>
            </div>
            <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
              {items.map((item) => <div key={item.id} className="p-3.5 sm:p-4">
                <div className="flex items-start gap-3">
                  <div className="rounded-lg bg-slate-50 p-2"><FileTypeIcon type={item.file.type} name={item.file.name} /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-medium text-slate-800" title={item.file.name}>{item.file.name}</p><p className="mt-0.5 text-xs text-slate-500">{formatBytes(item.file.size)}{item.file.type ? ` · ${item.file.type}` : ""}</p></div>
                      {item.status === "success" ? <div className="flex shrink-0 items-center gap-1"><CheckCircle2 className="h-5 w-5 text-emerald-500" /><button type="button" onClick={() => setItems((previous) => previous.filter((current) => current.id !== item.id))} aria-label={`从列表移除 ${item.file.name}`} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-3.5 w-3.5" /><span className="hidden sm:inline">删除</span></button></div> : item.status === "uploading" ? <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-indigo-600" /> : <button type="button" onClick={() => setItems((previous) => previous.filter((current) => current.id !== item.id))} disabled={isUploading} aria-label={`移除 ${item.file.name}`} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:hidden"><X className="h-4 w-4" /></button>}</div>
                    {item.status === "uploading" && <div className="mt-3"><div className="h-1.5 overflow-hidden rounded-full bg-slate-100"><div style={{ width: `${item.progress}%` }} className="h-full rounded-full bg-indigo-600 transition-all" /></div><p className="mt-1 text-xs text-indigo-600">正在上传：{item.progress}%</p></div>}
                    {item.status === "error" && <div className="mt-2 flex flex-wrap items-center gap-2"><p className="text-xs text-rose-600">{item.error}</p><button type="button" disabled={isUploading} onClick={() => void uploadQueued(item.id)} className="text-xs font-semibold text-indigo-600 hover:text-indigo-700">重试</button></div>}
                    {item.ossUrl && <div className="mt-3 flex min-w-0 items-center gap-2 rounded-lg bg-emerald-50 px-2.5 py-2"><LinkIcon className="h-4 w-4 shrink-0 text-emerald-600" /><a href={item.ossUrl} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-mono text-xs text-emerald-800 hover:underline" title={item.ossUrl}>{item.ossUrl}</a><button type="button" onClick={() => void copyText(item.ossUrl!, item.id)} className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100">{copied === item.id ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied === item.id ? "已复制" : "复制"}</button></div>}
                  </div>
                </div>
              </div>)}
            </div>
          </div>}
          </> : <ProjectPublishInterface
            hasPlatformCredentials={Boolean(authorization.trim() && cookie.trim())}
            savePlatformCredentials={saveCredentials}
            uploadFile={uploadFileToOss}
            verifyOssUrl={verifyOssUrl}
          />}
        </section>

        {successItems.length > 1 && <section className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-5 sm:p-6"><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><h2 className="font-semibold text-emerald-900">已获得 {successItems.length} 个公网链接</h2><p className="mt-1 text-sm text-emerald-700">可一次复制全部 ossUrl，用于批量粘贴或记录。</p></div><button type="button" onClick={() => void copyText(successItems.map((item) => item.ossUrl).join("\n"), "all")} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"><Clipboard className="h-4 w-4" />{copied === "all" ? "已复制全部" : "复制全部链接"}</button></div></section>}

        <p className="mt-5 text-center text-xs leading-5 text-slate-400">{uploadMode === "project" ? "项目发布会逐个验证资源链接和入口网页，再显示最终在线链接。" : "上传成功表示平台已返回 ossUrl。HTML 是否以网页形式预览取决于 OSS 的响应头策略；即使浏览器下载该文件，链接仍可用于系统资源引用。"}</p>
      </div>
    </main>
  );
}
