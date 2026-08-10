"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
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
  ListChecks,
  Loader2,
  Music2,
  ShieldCheck,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import {
  collectProjectAssets,
  createProjectFileIndex,
  findCssReferences,
  findHtmlReferences,
  injectRuntimeAssetResolver,
  isCssFile,
  isHtmlFile,
  isJavaScriptFile,
  isLocalProjectReference,
  type ProjectAsset,
  resolveProjectReference,
  rewriteCssReferences,
  rewriteHtmlReferences,
  rewriteJavaScriptNavigationReferences,
  rewriteJavaScriptReferences,
} from "@/lib/html-project-publisher";

const CREDENTIAL_STORAGE_KEY = "polymas-resource-uploader-credentials";
const SHARED_CREDENTIAL_STORAGE_KEY = "training-injector-credentials";
const PART_SIZE = 3 * 1024 * 1024;

type UploadStatus = "queued" | "uploading" | "success" | "error";
type UploadMode = "resource" | "project";
type ProjectPhase = "idle" | "ready" | "publishing" | "success" | "error";

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

interface ProjectResult {
  url: string;
  assetCount: number;
  replacementCount: number;
  warnings: string[];
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

function looksLikeStaticFileReference(reference: string): boolean {
  const pathname = reference.trim().split(/[?#]/, 1)[0];
  if (!pathname || /\s|["'`(){}<>]/.test(pathname)) return false;
  // A leading dot followed by a name is usually a CSS selector (for example
  // `.card.active`), while ./ and ../ are genuine relative file paths.
  if (/^\.[^./]/.test(pathname)) return false;
  return /(^|\/)[^/]+\.[a-z0-9]{1,12}$/i.test(pathname);
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
  const [projectAssets, setProjectAssets] = useState<ProjectAsset[]>([]);
  const [projectEntryPath, setProjectEntryPath] = useState("");
  const [projectPhase, setProjectPhase] = useState<ProjectPhase>("idle");
  const [projectProgress, setProjectProgress] = useState(0);
  const [projectMessage, setProjectMessage] = useState("");
  const [projectResult, setProjectResult] = useState<ProjectResult | null>(null);
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const directoryInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const credentials = readCredentials(CREDENTIAL_STORAGE_KEY) || readCredentials(SHARED_CREDENTIAL_STORAGE_KEY);
    if (!credentials) return;
    setAuthorization(credentials.authorization);
    setCookie(credentials.cookie);
  }, []);

  useEffect(() => {
    // Folder selection remains Chromium/Safari-specific, so set its vendor
    // attribute imperatively instead of depending on React's HTML typings.
    directoryInputRef.current?.setAttribute("webkitdirectory", "");
    directoryInputRef.current?.setAttribute("directory", "");
  }, [uploadMode]);

  const projectIndex = useMemo(
    () => createProjectFileIndex(projectAssets),
    [projectAssets],
  );
  const projectHtmlFiles = useMemo(
    () => projectAssets.filter((asset) => isHtmlFile(asset.path)),
    [projectAssets],
  );

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

  const selectProjectFiles = (files: FileList | File[]) => {
    const { assets, duplicates } = collectProjectAssets(Array.from(files));
    const htmlFiles = assets.filter((asset) => isHtmlFile(asset.path));
    const defaultEntry = htmlFiles.find((asset) => /(^|\/)index\.html?$/i.test(asset.path)) || htmlFiles[0];

    setProjectAssets(assets);
    setProjectEntryPath(defaultEntry?.path || "");
    setProjectPhase(assets.length ? "ready" : "idle");
    setProjectProgress(0);
    setProjectMessage(assets.length
      ? `已识别 ${assets.length} 个文件${defaultEntry ? `，默认入口为 ${defaultEntry.path}` : "，但未找到 HTML 文件"}。`
      : "未选择到文件。",
    );
    setProjectResult(null);
    setNotice(duplicates.length ? `已忽略 ${duplicates.length} 个同路径的重复文件。` : "");
  };

  const onDirectoryChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) selectProjectFiles(event.target.files);
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (uploadMode === "project") {
      const files = Array.from(event.dataTransfer.files);
      if (!files.every((file) => file.webkitRelativePath)) {
        setNotice("为保留 HTML 中的目录关系，请使用“选择项目文件夹”按钮，而不是拖入散落文件。");
        return;
      }
      selectProjectFiles(files);
      return;
    }
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

  const uploadFileToOss = async (
    file: File,
    onProgress?: (progress: number) => void,
  ): Promise<NonNullable<UploadResponse["data"]>> => {
    const chunks = Math.max(1, Math.ceil(file.size / PART_SIZE));
    const identifyCode = fileId();
    let lastData: UploadResponse["data"];

    for (let chunk = 0; chunk < chunks; chunk += 1) {
      const start = chunk * PART_SIZE;
      const part = file.slice(start, Math.min(start + PART_SIZE, file.size), file.type);
      const body = new FormData();
      body.append("file", part, file.name);
      body.append("name", file.name);
      body.append("identifyCode", identifyCode);
      body.append("chunk", String(chunk));
      body.append("chunks", String(chunks));
      body.append("size", String(file.size));
      body.append("authorization", authorization.trim());
      body.append("cookie", cookie.trim());

      const response = await fetch("/api/resource-upload", { method: "POST", body });
      const payload = await response.json().catch(() => ({})) as UploadResponse;
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || `第 ${chunk + 1} 个分片上传失败（HTTP ${response.status}）。`);
      }
      lastData = payload.data;
      onProgress?.(Math.round(((chunk + 1) / chunks) * 100));
    }

    if (!lastData?.ossUrl) {
      throw new Error("平台已接收文件，但没有返回 ossUrl。请确认当前账号拥有资源上传权限后重试。");
    }
    return lastData;
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

  const publishHtmlProject = async () => {
    if (!authorization.trim() || !cookie.trim()) {
      setNotice("请先填写平台 Authorization 和 Cookie。它们仅用于本次上传，并只会保存在当前浏览器中。");
      return;
    }
    const entry = projectIndex.byPath.get(projectEntryPath);
    if (!entry) {
      setProjectPhase("error");
      setProjectMessage("请选择一个 HTML 文件作为网页入口。");
      return;
    }

    let sourceHtml = "";
    const missingReferences = new Set<string>();
    try {
      for (const htmlAsset of projectHtmlFiles) {
        const html = await htmlAsset.file.text();
        if (htmlAsset.path === entry.path) sourceHtml = html;
        // Inline scripts contain selectors, event names and ordinary labels in
        // quotes. Only explicit HTML/CSS references are safe to treat as
        // required files during preflight; known JS paths are still rewritten
        // later and dynamic paths are handled by the runtime manifest.
        for (const reference of findHtmlReferences(html, { includeScriptStrings: false })) {
          if (!isLocalProjectReference(reference)) continue;
          if (looksLikeStaticFileReference(reference) && !resolveProjectReference(reference, htmlAsset.path, projectIndex)) {
            missingReferences.add(`${htmlAsset.path} → ${reference}`);
          }
        }
      }
      for (const stylesheet of projectAssets.filter((asset) => isCssFile(asset.path))) {
        const css = await stylesheet.file.text();
        for (const reference of findCssReferences(css)) {
          if (!isLocalProjectReference(reference)) continue;
          if (!resolveProjectReference(reference, stylesheet.path, projectIndex)) {
            missingReferences.add(`${stylesheet.path} → ${reference}`);
          }
        }
      }
    } catch {
      setProjectPhase("error");
      setProjectMessage("读取 HTML/CSS 文件失败，请重新选择项目文件夹。");
      return;
    }

    saveCredentials();
    setNotice("");
    setIsUploading(true);
    setProjectPhase("publishing");
    setProjectProgress(0);
    setProjectResult(null);

    const publicUrls = new Map<string, string>();
    const warnings = new Set<string>();
    if (missingReferences.size > 0) {
      const references = [...missingReferences];
      const examples = references.slice(0, 5).join("；");
      const remainder = references.length > 5 ? `；另有 ${references.length - 5} 处` : "";
      warnings.add(`发现 ${references.length} 个未匹配的显式本地引用，已保留原路径并继续发布：${examples}${remainder}。若页面对应内容显示异常，请检查这些路径。`);
    }
    let replacementCount = 0;
    const rawAssets = projectAssets.filter((asset) => !isHtmlFile(asset.path) && !isCssFile(asset.path) && !isJavaScriptFile(asset.path));
    const cssAssets = projectAssets.filter((asset) => isCssFile(asset.path));
    const scriptAssets = projectAssets.filter((asset) => isJavaScriptFile(asset.path));
    const secondaryHtmlAssets = projectHtmlFiles.filter((asset) => asset.path !== entry.path);
    const totalOperations = Math.max(1, rawAssets.length + cssAssets.length + scriptAssets.length + secondaryHtmlAssets.length + 1);
    let completedOperations = 0;

    const reportProgress = (partProgress = 0) => {
      setProjectProgress(Math.min(99, Math.round(((completedOperations + partProgress / 100) / totalOperations) * 100)));
    };

    const uploadAsset = async (asset: ProjectAsset, file = asset.file) => {
      setProjectMessage(`正在上传 ${asset.path}…`);
      const data = await uploadFileToOss(file, reportProgress);
      publicUrls.set(asset.path, data.ossUrl!);
      completedOperations += 1;
      reportProgress();
      return data.ossUrl!;
    };

    const preparingCss = new Set<string>();
    const prepareCss = async (path: string): Promise<string | undefined> => {
      const existing = publicUrls.get(path);
      if (existing) return existing;
      const asset = projectIndex.byPath.get(path);
      if (!asset) return undefined;
      if (preparingCss.has(path)) {
        warnings.add(`检测到 CSS 相互引用：${path}。其中一个引用将保持为原始路径。`);
        return undefined;
      }

      preparingCss.add(path);
      const content = await asset.file.text();
      for (const reference of findCssReferences(content)) {
        const target = resolveProjectReference(reference, path, projectIndex);
        if (target && isCssFile(target.path)) await prepareCss(target.path);
      }
      const rewritten = rewriteCssReferences(content, (reference) => {
        const target = resolveProjectReference(reference, path, projectIndex);
        if (!target) return reference;
        const url = publicUrls.get(target.path);
        if (!url) {
          warnings.add(`未能自动替换 CSS 引用：${path} → ${target.path}`);
          return reference;
        }
        replacementCount += 1;
        return `${url}${target.suffix}`;
      });
      const rewrittenFile = new File([rewritten], asset.file.name, {
        type: asset.file.type || "text/css",
        lastModified: asset.file.lastModified,
      });
      const url = await uploadAsset(asset, rewrittenFile);
      preparingCss.delete(path);
      return url;
    };

    const replaceKnownReference = (
      reference: string,
      sourcePath: string,
      allowDocumentRelativeFallback = false,
    ): string => {
      const target = resolveProjectReference(reference, sourcePath, projectIndex)
        || (allowDocumentRelativeFallback
          ? resolveProjectReference(reference, entry.path, projectIndex)
          : null);
      if (!target) return reference;
      const url = publicUrls.get(target.path);
      if (!url) return reference;
      replacementCount += 1;
      return `${url}${target.suffix}`;
    };

    const prepareJavaScript = async (asset: ProjectAsset) => {
      const content = await asset.file.text();
      const withStaticUrls = rewriteJavaScriptReferences(content, (reference) =>
        replaceKnownReference(reference, asset.path, true),
      );
      const rewritten = rewriteJavaScriptNavigationReferences(withStaticUrls);
      const rewrittenFile = new File([rewritten], asset.file.name, {
        type: asset.file.type || "text/javascript",
        lastModified: asset.file.lastModified,
      });
      return uploadAsset(asset, rewrittenFile);
    };

    const prepareHtml = async (asset: ProjectAsset, html: string) => {
      const rewritten = rewriteHtmlReferences(html, (reference) =>
        replaceKnownReference(reference, asset.path),
      );
      const unreplaced = findHtmlReferences(rewritten).filter((reference) => {
        if (!isLocalProjectReference(reference)) return false;
        const target = resolveProjectReference(reference, asset.path, projectIndex);
        return Boolean(target && !isHtmlFile(target.path) && publicUrls.has(target.path));
      });
      if (unreplaced.length > 0) {
        warnings.add(`静态替换后仍检测到 ${unreplaced.length} 个引用，已交给运行时映射继续处理：${asset.path} → ${unreplaced.slice(0, 5).join("；")}`);
      }
      return injectRuntimeAssetResolver(rewritten, publicUrls, asset.path);
    };

    try {
      for (const asset of rawAssets) await uploadAsset(asset);
      for (const asset of cssAssets) await prepareCss(asset.path);
      for (const asset of scriptAssets) await prepareJavaScript(asset);
      for (const htmlAsset of secondaryHtmlAssets) {
        const html = await htmlAsset.file.text();
        const preparedHtml = await prepareHtml(htmlAsset, html);
        const preparedFile = new File([preparedHtml], htmlAsset.file.name, {
          type: htmlAsset.file.type || "text/html",
          lastModified: htmlAsset.file.lastModified,
        });
        await uploadAsset(htmlAsset, preparedFile);
      }

      const runtimeResolvedHtml = await prepareHtml(entry, sourceHtml);
      const publishedHtml = new File([runtimeResolvedHtml], entry.file.name, {
        type: entry.file.type || "text/html",
        lastModified: entry.file.lastModified,
      });
      setProjectMessage(`正在发布网页入口 ${entry.path}…`);
      const finalData = await uploadFileToOss(publishedHtml, reportProgress);
      completedOperations += 1;
      setProjectProgress(100);
      setProjectPhase("success");
      setProjectMessage(replacementCount > 0
        ? `发布完成：已静态替换 ${replacementCount} 处路径，并启用 ${publicUrls.size} 个资源的动态路径解析。`
        : `发布完成：资源路径由 JavaScript 动态生成，已注入 ${publicUrls.size} 个资源的运行时 OSS 映射。`,
      );
      setProjectResult({
        url: finalData.ossUrl!,
        assetCount: publicUrls.size,
        replacementCount,
        warnings: [...warnings],
      });
    } catch (error) {
      setProjectPhase("error");
      setProjectMessage(error instanceof Error ? error.message : "项目发布失败，请检查文件和平台凭证后重试。");
    } finally {
      setIsUploading(false);
    }
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
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">上传本地资源，获取公网 ossUrl</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600 sm:text-base">支持 HTML、图片、视频、音频及其他常见文件。上传完成后可复制公网链接，直接用于分享或在系统中引用。</p>
        </section>

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-5 py-4 sm:px-6">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><ShieldCheck className="h-4 w-4 text-emerald-600" /> 平台认证</div>
              <button type="button" onClick={() => setShowCredentials((value) => !value)} className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-700">
                {showCredentials ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}{showCredentials ? "收起" : "填写 / 查看"}
              </button>
            </div>
            {!showCredentials && <p className="mt-1 text-xs text-slate-500">需要智慧树平台请求头中的 Authorization 和 Cookie。凭证不会写入服务器日志。</p>}
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
            <p className="mt-3 text-xs text-slate-400">大文件会自动按 3 MB 分片传输，单文件上限 1 GB</p>
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
          </> : <>
          <input ref={directoryInputRef} type="file" multiple className="hidden" onChange={onDirectoryChange} />
          <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-4 text-sm leading-6 text-slate-700">
            <p className="flex items-center gap-2 font-semibold text-indigo-900"><ListChecks className="h-4 w-4" />一键发布静态 HTML 项目</p>
            <p className="mt-1">选择项目根目录后，系统会先上传图片、视频、音频、JS 等资源，再重写 CSS 与入口 HTML 中的静态本地路径，最终输出可分享的 HTML 链接。无法确定的引用会原样保留并显示诊断，不会阻断整个项目发布。</p>
          </div>
          <div className="mt-4 flex min-h-48 flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-200 bg-slate-50/70 px-5 text-center">
            <div className="mb-3 rounded-xl bg-white p-3 shadow-sm"><FolderUp className="h-7 w-7 text-indigo-600" /></div>
            <p className="font-semibold text-slate-800">选择 HTML 项目文件夹</p>
            <p className="mt-1 text-sm text-slate-500">文件夹内应包含入口 HTML 及其引用的资源目录</p>
            <button type="button" onClick={() => directoryInputRef.current?.click()} disabled={isUploading} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"><FolderUp className="h-4 w-4" />选择项目文件夹</button>
            <p className="mt-3 text-xs text-slate-400">建议使用 Chrome、Edge 或 Safari；Firefox 暂不支持网页选择整个文件夹。</p>
          </div>

          {notice && <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{notice}</div>}

          {projectAssets.length > 0 && <div className="mt-5 overflow-hidden rounded-xl border border-slate-200">
            <div className="flex flex-col gap-3 border-b border-slate-100 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div><p className="text-sm font-semibold text-slate-800">已识别 {projectAssets.length} 个项目文件</p><p className="mt-0.5 text-xs text-slate-500">资源会保留引用关系，但上传后的 OSS 文件名由平台生成。</p></div>
              <button type="button" onClick={() => { setProjectAssets([]); setProjectEntryPath(""); setProjectPhase("idle"); setProjectResult(null); setProjectMessage(""); }} disabled={isUploading} className="inline-flex items-center gap-1.5 self-start rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-500 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" />清除项目</button>
            </div>
            <div className="space-y-4 p-4">
              <label className="block text-sm font-medium text-slate-700">网页入口 HTML
                <select value={projectEntryPath} onChange={(event) => { setProjectEntryPath(event.target.value); setProjectPhase("ready"); setProjectResult(null); }} disabled={isUploading || projectHtmlFiles.length === 0} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100">
                  {projectHtmlFiles.length === 0 && <option value="">未发现 HTML 文件</option>}
                  {projectHtmlFiles.map((asset) => <option key={asset.path} value={asset.path}>{asset.path}</option>)}
                </select>
              </label>
              {projectMessage && <p className={`text-sm ${projectPhase === "error" ? "text-rose-600" : projectPhase === "success" ? "text-emerald-700" : "text-slate-600"}`}>{projectMessage}</p>}
              {projectPhase === "publishing" && <div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${projectProgress}%` }} /></div><p className="mt-1.5 text-xs text-indigo-600">发布进度：{projectProgress}%</p></div>}
              <button type="button" onClick={() => void publishHtmlProject()} disabled={isUploading || !projectEntryPath} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300">{projectPhase === "publishing" ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}{projectPhase === "publishing" ? "正在发布项目" : "自动替换路径并发布"}</button>
            </div>
          </div>}

          {projectResult && <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4"><div className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" /><div className="min-w-0 flex-1"><p className="font-semibold text-emerald-900">项目发布完成</p><p className="mt-0.5 text-sm text-emerald-700">已上传 {projectResult.assetCount} 个资源；静态替换 {projectResult.replacementCount} 处，并已启用动态路径 OSS 映射。</p><div className="mt-3 flex min-w-0 items-center gap-2 rounded-lg bg-white/80 px-2.5 py-2"><LinkIcon className="h-4 w-4 shrink-0 text-emerald-600" /><a href={projectResult.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-mono text-xs text-emerald-800 hover:underline" title={projectResult.url}>{projectResult.url}</a><button type="button" onClick={() => void copyText(projectResult.url, "project")} className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100">{copied === "project" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied === "project" ? "已复制" : "复制"}</button></div></div></div>
            {projectResult.warnings.length > 0 && <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800"><p className="font-semibold">注意事项</p><ul className="mt-1 list-disc pl-4">{projectResult.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
          </div>}
          </>}
        </section>

        {successItems.length > 1 && <section className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-5 sm:p-6"><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><h2 className="font-semibold text-emerald-900">已获得 {successItems.length} 个公网链接</h2><p className="mt-1 text-sm text-emerald-700">可一次复制全部 ossUrl，用于批量粘贴或记录。</p></div><button type="button" onClick={() => void copyText(successItems.map((item) => item.ossUrl).join("\n"), "all")} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"><Clipboard className="h-4 w-4" />{copied === "all" ? "已复制全部" : "复制全部链接"}</button></div></section>}

        <p className="mt-5 text-center text-xs leading-5 text-slate-400">上传成功表示平台已返回 ossUrl。HTML 是否以网页形式预览取决于 OSS 的响应头策略；即使浏览器下载该文件，链接仍可用于系统资源引用。</p>
      </div>
    </main>
  );
}
