import {
  createProjectFileIndex,
  isCssFile,
  isHtmlFile,
  isJavaScriptFile,
  isLocalProjectReference,
  isSvgFile,
  resolveProjectReference,
  rewriteCssReferences,
  rewriteHtmlReferences,
  rewriteJavaScriptNavigationReferences,
  rewriteJavaScriptReferences,
  rewriteSvgReferences,
  type ProjectAsset,
} from "./html-project-publisher.ts";
import type { ProjectPublishPreflight, PublishDiagnostic } from "./project-publish-preflight.ts";

export interface DeterministicPathRepair {
  id: string;
  source: string;
  reference: string;
  replacement: string;
  targetPath: string;
  reason: string;
  diagnosticCode: string;
}

function splitSuffix(value: string): { pathname: string; suffix: string } {
  const index = value.search(/[?#]/);
  return index < 0 ? { pathname: value, suffix: "" } : { pathname: value.slice(0, index), suffix: value.slice(index) };
}

function encodeRelativePath(value: string): string {
  return value.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function uniqueBasenameTarget(reference: string, assets: ProjectAsset[]): string | null {
  const { pathname } = splitSuffix(reference.trim().replace(/\\/g, "/"));
  let decoded = pathname;
  try { decoded = decodeURIComponent(pathname); } catch { /* keep the literal path */ }
  const basename = decoded.split("/").filter(Boolean).at(-1)?.toLowerCase();
  if (!basename) return null;
  const matches = assets.filter((asset) => asset.path.split("/").at(-1)?.toLowerCase() === basename);
  return matches.length === 1 ? matches[0].path : null;
}

function replacementFor(source: string, target: string, reference: string): string {
  const directory = source.includes("/") ? source.slice(0, source.lastIndexOf("/")) : "";
  const from = directory ? directory.split("/") : [];
  const to = target.split("/");
  while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
  const relative = [...from.map(() => ".."), ...to].join("/") || target.split("/").at(-1) || target;
  return `${encodeRelativePath(relative)}${splitSuffix(reference).suffix}`;
}

function diagnosticTarget(
  diagnostic: PublishDiagnostic,
  assets: ProjectAsset[],
  index: ReturnType<typeof createProjectFileIndex>,
): string | null {
  if (!diagnostic.reference || !diagnostic.source || !isLocalProjectReference(diagnostic.reference)) return null;
  const resolved = resolveProjectReference(diagnostic.reference, diagnostic.source, index);
  if (resolved?.caseMismatch) return resolved.path;
  if (diagnostic.code !== "MISSING_RESOURCE" || resolved) return null;
  return uniqueBasenameTarget(diagnostic.reference, assets);
}

/** Suggest fixes only when a case-insensitive or unique basename match identifies one exact file. */
export function suggestDeterministicPathRepairs(
  assets: ProjectAsset[],
  report: ProjectPublishPreflight,
): DeterministicPathRepair[] {
  const index = createProjectFileIndex(assets);
  const suggestions = new Map<string, DeterministicPathRepair>();
  for (const diagnostic of report.diagnostics) {
    if (diagnostic.code !== "MISSING_RESOURCE" && diagnostic.code !== "PATH_CASE_MISMATCH") continue;
    const targetPath = diagnosticTarget(diagnostic, assets, index);
    if (!targetPath) continue;
    const replacement = replacementFor(diagnostic.source, targetPath, diagnostic.reference!);
    if (replacement === diagnostic.reference) continue;
    const id = `${diagnostic.source}\n${diagnostic.reference}\n${replacement}`;
    suggestions.set(id, {
      id,
      source: diagnostic.source,
      reference: diagnostic.reference!,
      replacement,
      targetPath,
      reason: diagnostic.code === "PATH_CASE_MISMATCH"
        ? `引用大小写与实际文件不一致；项目中唯一匹配文件为 ${targetPath}`
        : `项目中只有一个文件名匹配该引用：${targetPath}`,
      diagnosticCode: diagnostic.code,
    });
  }
  return [...suggestions.values()].sort((a, b) => a.source.localeCompare(b.source) || a.reference.localeCompare(b.reference));
}

/** Apply only user-selected suggestions, preserving the rest of each source file byte-for-byte where possible. */
export async function applyDeterministicPathRepairs(
  assets: ProjectAsset[],
  suggestions: DeterministicPathRepair[],
  selectedIds: string[],
): Promise<{ assets: ProjectAsset[]; changedPaths: string[] }> {
  const selected = new Set(selectedIds);
  const mappings = new Map<string, Map<string, string>>();
  for (const suggestion of suggestions) {
    if (!selected.has(suggestion.id)) continue;
    const byReference = mappings.get(suggestion.source) || new Map<string, string>();
    byReference.set(suggestion.reference, suggestion.replacement);
    mappings.set(suggestion.source, byReference);
  }
  if (selected.size !== [...suggestions].filter((item) => selected.has(item.id)).length) {
    throw new Error("修复清单已过期，请重新运行预检。");
  }

  const changedPaths: string[] = [];
  const repaired = await Promise.all(assets.map(async (asset) => {
    const changes = mappings.get(asset.path);
    if (!changes || (!isHtmlFile(asset.path) && !isCssFile(asset.path) && !isSvgFile(asset.path) && !isJavaScriptFile(asset.path))) return asset;
    const original = await asset.file.text();
    const replace = (reference: string) => changes.get(reference.trim()) || reference;
    const content = isHtmlFile(asset.path)
      ? rewriteHtmlReferences(original, replace)
      : isCssFile(asset.path)
        ? rewriteCssReferences(original, replace)
        : isSvgFile(asset.path)
          ? rewriteSvgReferences(original, replace)
          : rewriteJavaScriptNavigationReferences(rewriteJavaScriptReferences(original, replace));
    if (content === original) return asset;
    changedPaths.push(asset.path);
    return { ...asset, file: new File([content], asset.file.name, { type: asset.file.type || "text/plain", lastModified: asset.file.lastModified }) };
  }));
  return { assets: repaired, changedPaths: changedPaths.sort() };
}
