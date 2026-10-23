import {
  createProjectFileIndex,
  findCssReferences,
  findHtmlReferences,
  findJavaScriptReferences,
  findSvgReferences,
  injectRuntimeAssetResolver,
  isCssFile,
  isHtmlFile,
  isIgnoredProjectPath,
  isJavaScriptFile,
  isLocalProjectReference,
  isSvgFile,
  isWebMediaFile,
  resolveProjectReference,
  rewriteCssReferences,
  rewriteHtmlReferences,
  rewriteJavaScriptNavigationReferences,
  rewriteJavaScriptReferences,
  rewriteSvgReferences,
  isBareRuntimeAssetFilename,
  type ProjectAsset,
} from "./html-project-publisher.ts";

export const PROJECT_PUBLISH_RULE_VERSION = "preflight-6";

export interface PublishDiagnostic {
  severity: "error" | "warning";
  code: string;
  source: string;
  reference?: string;
  message: string;
}

export interface ProjectPublishPreflight {
  entryPath: string;
  fingerprint: string;
  fileHashes: Record<string, string>;
  rawAssetPaths: string[];
  cssPaths: string[];
  scriptPaths: string[];
  secondaryHtmlPaths: string[];
  skippedPaths: string[];
  diagnostics: PublishDiagnostic[];
  simulatedReplacementCount: number;
  requiredFlows: Array<{ name: string; start: string; steps: number }>;
}

export interface FlatPreviewAsset {
  pathname: string;
  contentType: string;
  bytes: Uint8Array;
}

const RUNTIME_EXTENSION = /\.(?:html?|css|c?m?js|json|wasm|md|markdown|py|ts|tsx|jsx|png|jpe?g|gif|webp|avif|svg|ico|bmp|glb|mp4|webm|ogv|mov|m4v|mp3|wav|ogg|m4a|aac|flac|woff2?|ttf|otf|eot|pdf)(?:[?#]|$)/i;
const KNOWN_UNSUPPORTED_RUNTIME = /\.(?:json|wasm|md|markdown|py|ts|tsx|jsx)(?:[?#]|$)/i;

function looksLikeRuntimePath(reference: string): boolean {
  return !reference.startsWith("?") && !/^\.[^./]+$/.test(reference)
    && !/\s|["'`(){}<>]/.test(reference) && RUNTIME_EXTENSION.test(reference);
}

function stripHtmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, "");
}

export async function sha256File(file: File): Promise<string> {
  const chunkSize = 4 * 1024 * 1024;
  if (file.size > chunkSize) {
    const chunks: string[] = [];
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      const digest = await crypto.subtle.digest("SHA-256", await file.slice(offset, offset + chunkSize).arrayBuffer());
      chunks.push(Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, "0")).join(""));
    }
    return sha256Text(`chunked:${file.size}:${chunks.join("")}`);
  }
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, "0")).join("");
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, "0")).join("");
}

/** The same inventory and rewrite functions are used by the UI and CLI before any real upload. */
export async function inspectProjectForPublishing(
  assets: ProjectAsset[],
  entryPath: string,
): Promise<ProjectPublishPreflight> {
  assets = assets.filter((asset) => !isIgnoredProjectPath(asset.path)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const index = createProjectFileIndex(assets);
  const diagnostics: PublishDiagnostic[] = [];
  const seenDiagnostics = new Set<string>();
  const referencedPaths = new Set(assets.filter((asset) => isSvgFile(asset.path)).map((asset) => asset.path));
  const fileHashes: Record<string, string> = {};
  const addDiagnostic = (diagnostic: PublishDiagnostic) => {
    const key = `${diagnostic.code}:${diagnostic.source}:${diagnostic.reference || ""}`;
    if (!seenDiagnostics.has(key)) {
      seenDiagnostics.add(key);
      diagnostics.push(diagnostic);
    }
  };
  const checkReferences = (
    references: string[],
    source: string,
    explicit: boolean,
    allowEntryFallback = false,
  ) => {
    for (const reference of references) {
      if (explicit && /^http:\/\//i.test(reference) && !/^http:\/\/www\.w3\.org\//i.test(reference)) {
        addDiagnostic({ severity: "warning", code: "HTTP_EXTERNAL_RESOURCE", source, reference,
          message: `HTTPS 公网页面引用了 HTTP 地址，浏览器可能拦截：${source} → ${reference}` });
      }
      if (!isLocalProjectReference(reference) || (!explicit && !looksLikeRuntimePath(reference))) continue;
      const target = resolveProjectReference(reference, source, index)
        || (allowEntryFallback ? resolveProjectReference(reference, entryPath, index) : null);
      if (!target) {
        if (explicit || !isBareRuntimeAssetFilename(reference)) {
          addDiagnostic({
            severity: "error", code: "MISSING_RESOURCE", source, reference,
            message: `找不到资源：${source} → ${reference}`,
          });
        } else {
          addDiagnostic({
            severity: "warning", code: "DYNAMIC_FILENAME", source, reference,
            message: `脚本中的单独文件名需要运行时路径：${source} → ${reference}`,
          });
        }
        continue;
      }
      referencedPaths.add(target.path);
      if (target.caseMismatch) {
        addDiagnostic({ severity: "error", code: "PATH_CASE_MISMATCH", source, reference,
          message: `资源路径大小写不一致：${source} → ${reference}，实际文件为 ${target.path}` });
      }
      if (KNOWN_UNSUPPORTED_RUNTIME.test(target.path)) {
        addDiagnostic({
          severity: "error", code: "UNSUPPORTED_RUNTIME_FILE", source, reference,
          message: `运行时引用了平台不支持的文件类型：${source} → ${target.path}`,
        });
      } else if (!isHtmlFile(target.path) && !isCssFile(target.path)
        && !isJavaScriptFile(target.path) && !isWebMediaFile(target.path)
        && !/\.glb$/i.test(target.path)) {
        addDiagnostic({
          severity: "warning", code: "UNVERIFIED_UPLOAD_TYPE", source, reference,
          message: `该资源格式尚未在发布器允许类型中验证：${source} → ${target.path}`,
        });
      }
    }
  };

  if (!entryPath || !index.byPath.has(entryPath) || !isHtmlFile(entryPath)) {
    addDiagnostic({ severity: "error", code: "NO_ENTRY", source: entryPath || "项目", message: "请选择项目内的 HTML 入口。" });
  }

  const casePaths = new Map<string, string>();
  for (const asset of assets) {
    const key = asset.path.toLowerCase();
    if (casePaths.has(key)) addDiagnostic({ severity: "error", code: "DUPLICATE_PATH", source: asset.path,
      message: `存在重复或仅大小写不同的文件：${casePaths.get(key)} / ${asset.path}` });
    casePaths.set(key, asset.path);
    fileHashes[asset.path] = await sha256File(asset.file);
  }
  const requiredFlows: ProjectPublishPreflight["requiredFlows"] = [];
  const flowAsset = index.byPath.get("polymas-publish-flows.json");
  if (flowAsset) {
    try {
      const config = JSON.parse(await flowAsset.file.text());
      if (!Array.isArray(config.flows)) throw new Error("缺少 flows 数组");
      for (const flow of config.flows) {
        if (!flow || typeof flow.name !== "string" || !flow.name.trim() || !Array.isArray(flow.steps) || !flow.steps.length
          || (flow.start !== undefined && typeof flow.start !== "string")) throw new Error("流程名称、起点或步骤无效");
        requiredFlows.push({ name: flow.name, start: flow.start || entryPath, steps: flow.steps.length });
      }
      if (new Set(requiredFlows.map((flow) => flow.name)).size !== requiredFlows.length) throw new Error("流程名称重复");
    } catch {
      addDiagnostic({ severity: "error", code: "INVALID_FLOWS", source: flowAsset.path, message: "关键流程配置无效，请修复 polymas-publish-flows.json。" });
    }
  }
  for (const asset of assets.filter((item) => isHtmlFile(item.path))) {
    const html = stripHtmlComments(await asset.file.text());
    checkReferences(findHtmlReferences(html, { includeScriptStrings: false }), asset.path, true);
    checkReferences(findHtmlReferences(html), asset.path, false, true);
  }
  const scanned = new Set<string>();
  while (true) {
    const nextPath = [...referencedPaths].find((path) => !scanned.has(path)
      && (isCssFile(path) || isJavaScriptFile(path) || isSvgFile(path)));
    if (!nextPath) break;
    scanned.add(nextPath);
    const asset = index.byPath.get(nextPath);
    if (!asset) continue;
    if (isCssFile(nextPath)) {
      checkReferences(findCssReferences((await asset.file.text()).replace(/\/\*[\s\S]*?\*\//g, "")), nextPath, true);
    } else if (isJavaScriptFile(nextPath)) {
      const script = await asset.file.text();
      checkReferences(findJavaScriptReferences(script), nextPath, false, true);
      if (/\bnew\s+URL\s*\(\s*`[^`]*\$\{[^`]*`\s*,\s*import\.meta\.url\s*\)/.test(script)) {
        addDiagnostic({ severity: "error", code: "DYNAMIC_IMPORT_META_URL", source: nextPath,
          message: `脚本用 import.meta.url 拼接动态资源路径，平铺发布后会指向不存在的原目录：${nextPath}。请把完整资源路径放在单独字符串中。` });
      }
      if (/\b(?:loadAsync|load|fetch)\s*\(\s*`[^`]*\$\{[^`]*\.(?:glb|gltf)(?:[?#][^`]*)?`/i.test(script)) {
        addDiagnostic({ severity: "error", code: "DYNAMIC_MODEL_PATH", source: nextPath,
          message: `脚本动态拼接 3D 模型文件名，发布器无法确定需上传的模型：${nextPath}。请将每个模型的完整路径写为独立字符串。` });
      }
    } else if (isSvgFile(nextPath)) {
      checkReferences(findSvgReferences((await asset.file.text()).replace(/<!--[\s\S]*?-->/g, "")), nextPath, true);
    }
  }

  const dependencyEdges = new Map<string, string[]>();
  for (const path of scanned) {
    if (!isCssFile(path) && !isSvgFile(path) && !isJavaScriptFile(path)) continue;
    const asset = index.byPath.get(path);
    if (!asset) continue;
    const references = isCssFile(path)
      ? findCssReferences((await asset.file.text()).replace(/\/\*[\s\S]*?\*\//g, ""))
      : isSvgFile(path) ? findSvgReferences((await asset.file.text()).replace(/<!--[\s\S]*?-->/g, ""))
        : findJavaScriptReferences(await asset.file.text());
    dependencyEdges.set(path, references.flatMap((reference) => {
      const target = resolveProjectReference(reference, path, index)
        || (isJavaScriptFile(path) ? resolveProjectReference(reference, entryPath, index) : null);
      return target && (isCssFile(target.path) || isSvgFile(target.path) || isJavaScriptFile(target.path)) ? [target.path] : [];
    }));
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visitDependency = (path: string) => {
    if (visiting.has(path)) {
      addDiagnostic({ severity: "error", code: "CYCLIC_REFERENCE", source: path, message: `CSS/SVG/脚本资源存在循环引用，无法稳定改写：${path}` });
      return;
    }
    if (visited.has(path)) return;
    visiting.add(path);
    for (const next of dependencyEdges.get(path) || []) visitDependency(next);
    visiting.delete(path);
    visited.add(path);
  };
  for (const path of dependencyEdges.keys()) visitDependency(path);

  const rawAssetPaths = assets.filter((asset) =>
    !isHtmlFile(asset.path) && !isCssFile(asset.path) && !isJavaScriptFile(asset.path)
    && (referencedPaths.has(asset.path) || isWebMediaFile(asset.path)),
  ).map((asset) => asset.path);
  const cssPaths = assets.filter((asset) => isCssFile(asset.path) && referencedPaths.has(asset.path)).map((asset) => asset.path);
  const scriptPaths = assets.filter((asset) => isJavaScriptFile(asset.path) && referencedPaths.has(asset.path)).map((asset) => asset.path);
  const secondaryHtmlPaths = assets.filter((asset) => isHtmlFile(asset.path) && asset.path !== entryPath).map((asset) => asset.path);
  const uploaded = new Set([...rawAssetPaths, ...cssPaths, ...scriptPaths, ...secondaryHtmlPaths, entryPath]);
  const skippedPaths = assets.filter((asset) => !uploaded.has(asset.path)).map((asset) => asset.path);

  for (const path of referencedPaths) {
    if (!uploaded.has(path)) {
      addDiagnostic({ severity: "error", code: "REFERENCED_BUT_SKIPPED", source: path, message: `运行时资源未进入上传清单：${path}` });
    }
  }

  // A flat, random-looking URL for each selected file exposes assumptions
  // about the original directory layout without contacting OSS.
  const fakeUrls = new Map([...uploaded].filter(Boolean).sort().map((path, position) => {
    const extension = path.match(/\.[a-z0-9]+$/i)?.[0] || "";
    return [path, `https://publish-preview.invalid/r${position.toString(36)}${extension}`] as const;
  }));
  let simulatedReplacementCount = 0;
  const replaceReference = (reference: string, source: string, fallback = false) => {
    const target = resolveProjectReference(reference, source, index)
      || (fallback ? resolveProjectReference(reference, entryPath, index) : null);
    const url = target && fakeUrls.get(target.path);
    if (!url) return reference;
    simulatedReplacementCount += 1;
    return `${url}${target.suffix}`;
  };
  for (const asset of assets) {
    if (!uploaded.has(asset.path)) continue;
    let rewritten = "";
    if (isHtmlFile(asset.path)) {
      rewritten = rewriteHtmlReferences(await asset.file.text(), (reference) => replaceReference(reference, asset.path), { preserveBareScriptAssetNames: true });
    } else if (isCssFile(asset.path)) {
      rewritten = rewriteCssReferences(await asset.file.text(), (reference) => replaceReference(reference, asset.path));
    } else if (isJavaScriptFile(asset.path)) {
      rewritten = rewriteJavaScriptNavigationReferences(rewriteJavaScriptReferences(await asset.file.text(), (reference) =>
        isBareRuntimeAssetFilename(reference) ? reference : replaceReference(reference, asset.path, true)));
    } else if (isSvgFile(asset.path)) {
      rewritten = rewriteSvgReferences(await asset.file.text(), (reference) => replaceReference(reference, asset.path));
    }
    if (/(?:\/|\\)https?:\/\//i.test(rewritten)) {
      addDiagnostic({ severity: "error", code: "URL_CONCATENATION", source: asset.path, message: `改写后出现目录与完整 URL 拼接：${asset.path}` });
    }
  }

  const fingerprint = await sha256Text(JSON.stringify({
    version: PROJECT_PUBLISH_RULE_VERSION,
    entryPath,
    files: Object.entries(fileHashes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  }));
  return {
    entryPath, fingerprint, fileHashes, rawAssetPaths, cssPaths, scriptPaths,
    secondaryHtmlPaths, skippedPaths, diagnostics, simulatedReplacementCount, requiredFlows,
  };
}

export interface BrowserAuditReport {
  kind: "polymas-project-browser-audit";
  ruleVersion: string;
  entryPath: string;
  fingerprint: string;
  expectedPages: number;
  pages: Array<{ logicalPath: string; completed: boolean; errors: string[] }>;
  flows: Array<{ name: string; start: string; completed: boolean; errors: string[]; steps: Array<{ status: string; errors: string[] }> }>;
  coverage: {
    complete: boolean;
    mode: string;
    expectedPages: number;
    checkedPages: number;
    passedPages: number;
    expectedFlows: number;
    executedFlows: number;
    passedFlows: number;
    expectedSteps: number;
    executedSteps: number;
    passedSteps: number;
    independentSecondaryPages: boolean;
  };
  errors: string[];
  warnings: string[];
  createdAt: string;
}

export function isBrowserAuditReport(value: unknown): value is BrowserAuditReport {
  if (!value || typeof value !== "object") return false;
  const report = value as BrowserAuditReport;
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every((item) => typeof item === "string");
  return report.kind === "polymas-project-browser-audit" && typeof report.ruleVersion === "string"
    && typeof report.entryPath === "string" && typeof report.fingerprint === "string"
    && Number.isInteger(report.expectedPages) && report.expectedPages > 0
    && Array.isArray(report.pages) && report.pages.every((page) => page && typeof page.logicalPath === "string"
      && typeof page.completed === "boolean" && strings(page.errors))
    && Array.isArray(report.flows) && report.flows.every((flow) => flow && typeof flow.name === "string" && typeof flow.start === "string"
      && typeof flow.completed === "boolean" && strings(flow.errors) && Array.isArray(flow.steps)
      && flow.steps.every((step) => step && typeof step.status === "string" && strings(step.errors)))
    && Boolean(report.coverage) && typeof report.coverage.complete === "boolean" && typeof report.coverage.mode === "string"
    && strings(report.errors) && strings(report.warnings) && typeof report.createdAt === "string";
}

export function browserAuditMatches(audit: BrowserAuditReport | null, report: ProjectPublishPreflight | null, htmlPaths: string[], now = Date.now()): boolean {
  if (!isBrowserAuditReport(audit) || !report || audit.ruleVersion !== PROJECT_PUBLISH_RULE_VERSION
    || audit.entryPath !== report.entryPath || audit.fingerprint !== report.fingerprint
    || report.diagnostics.some((item) => item.severity === "error")) return false;
  const age = now - Date.parse(audit.createdAt);
  const checkedPaths = new Set(audit.pages.map((page) => page.logicalPath));
  return Number.isFinite(age) && age >= -5 * 60 * 1000 && age < 24 * 60 * 60 * 1000
    && audit.coverage.complete && audit.errors.length === 0 && audit.pages.every((page) => page.completed && !page.errors.length)
    && audit.expectedPages === htmlPaths.length && audit.pages.length === htmlPaths.length
    && checkedPaths.size === htmlPaths.length && htmlPaths.every((path) => checkedPaths.has(path))
    && new Set(audit.flows.map((flow) => flow.name)).size === audit.flows.length
    && audit.flows.every((flow) => flow.completed && !flow.errors.length && flow.steps.length > 0
      && flow.steps.every((step) => step.status === "passed" && !step.errors.length))
    && report.requiredFlows.every((required) => audit.flows.some((flow) => flow.name === required.name
      && flow.start === required.start && flow.steps.length === required.steps));
}

/** 真实上传与随机平铺预览共用同一依赖顺序、改写内容和运行时映射。 */
export async function executeProjectPublish(
  assets: ProjectAsset[],
  report: ProjectPublishPreflight,
  upload: (asset: ProjectAsset, file: File) => Promise<string>,
): Promise<{ entryUrl: string; publicUrls: Map<string, string>; replacementCount: number }> {
  if (report.diagnostics.some((item) => item.severity === "error")) throw new Error("项目预检未通过，禁止发布。");
  const index = createProjectFileIndex(assets);
  const publicUrls = new Map<string, string>();
  const preparing = new Set<string>();
  const uploadedPaths = new Set([...report.rawAssetPaths, ...report.cssPaths, ...report.scriptPaths, ...report.secondaryHtmlPaths, report.entryPath]);
  let replacementCount = 0;
  const resolve = (reference: string, source: string, fallback = false) => resolveProjectReference(reference, source, index)
    || (fallback ? resolveProjectReference(reference, report.entryPath, index) : null);
  const replace = (reference: string, source: string, fallback = false) => {
    const target = resolve(reference, source, fallback);
    const url = target && publicUrls.get(target.path);
    if (!url) return reference;
    replacementCount += 1;
    return `${url}${target.suffix}`;
  };
  const prepare = async (path: string): Promise<string> => {
    const existing = publicUrls.get(path);
    if (existing) return existing;
    const asset = index.byPath.get(path);
    if (!asset) throw new Error(`发布清单中的文件不存在：${path}`);
    if (preparing.has(path)) throw new Error(`发布依赖存在循环引用：${path}`);
    preparing.add(path);
    try {
      let text: string | null = null;
      if (isHtmlFile(path) || isCssFile(path) || isSvgFile(path) || isJavaScriptFile(path)) text = await asset.file.text();
      if (text !== null && !isHtmlFile(path)) {
        const references = isCssFile(path) ? findCssReferences(text.replace(/\/\*[\s\S]*?\*\//g, ""))
          : isSvgFile(path) ? findSvgReferences(text.replace(/<!--[\s\S]*?-->/g, ""))
            : findJavaScriptReferences(text);
        for (const reference of references) {
          const target = resolve(reference, path, isJavaScriptFile(path));
          if (target && uploadedPaths.has(target.path) && !isHtmlFile(target.path)) await prepare(target.path);
        }
      }
      if (text !== null) {
        if (isHtmlFile(path)) text = injectRuntimeAssetResolver(rewriteHtmlReferences(text,
          (reference) => replace(reference, path), { preserveBareScriptAssetNames: true }), publicUrls, path, report.fingerprint);
        else if (isCssFile(path)) text = rewriteCssReferences(text, (reference) => replace(reference, path));
        else if (isSvgFile(path)) text = rewriteSvgReferences(text, (reference) => replace(reference, path));
        else text = rewriteJavaScriptNavigationReferences(rewriteJavaScriptReferences(text,
          (reference) => isBareRuntimeAssetFilename(reference) ? reference : replace(reference, path, true)));
      }
      const file = text === null ? asset.file : new File([text], asset.file.name,
        { type: asset.file.type || contentType(path).split(";")[0], lastModified: asset.file.lastModified });
      const url = await upload(asset, file);
      publicUrls.set(path, url);
      return url;
    } finally { preparing.delete(path); }
  };
  for (const path of [...report.rawAssetPaths, ...report.cssPaths, ...report.scriptPaths]) await prepare(path);
  for (const path of report.secondaryHtmlPaths) await prepare(path);
  const entryUrl = await prepare(report.entryPath);
  return { entryUrl, publicUrls, replacementCount };
}

function contentType(path: string): string {
  if (isHtmlFile(path)) return "text/html; charset=utf-8";
  if (isCssFile(path)) return "text/css; charset=utf-8";
  if (isJavaScriptFile(path)) return "text/javascript; charset=utf-8";
  if (isSvgFile(path)) return "image/svg+xml";
  const extension = path.split(".").pop()?.toLowerCase();
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", pdf: "application/pdf" } as Record<string, string>)[extension || ""] || "application/octet-stream";
}

/** Build a flat local preview with the publisher's rewrite rules and upload order. */
export async function buildFlatProjectPreview(
  assets: ProjectAsset[],
  report: ProjectPublishPreflight,
  origin: string,
): Promise<{ entryUrl: string; logicalUrls: Record<string, string>; files: FlatPreviewAsset[] }> {
  const files: FlatPreviewAsset[] = [];
  const result = await executeProjectPublish(assets, report, async (asset, file) => {
    const extension = asset.path.match(/\.[a-z0-9]+$/i)?.[0] || "";
    const url = `${origin}/${crypto.randomUUID()}${extension}`;
    files.push({ pathname: new URL(url).pathname, contentType: contentType(asset.path), bytes: new Uint8Array(await file.arrayBuffer()) });
    return url;
  });
  return { entryUrl: result.entryUrl, logicalUrls: Object.fromEntries(result.publicUrls), files };
}
