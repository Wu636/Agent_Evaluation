import { unzipSync } from "fflate";
import { collectProjectAssets, isIgnoredProjectPath, type ProjectAsset } from "./html-project-publisher.ts";
import { PROJECT_PUBLISH_LIMITS } from "./project-publish-online.ts";

const MIME_TYPES: Record<string, string> = {
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript",
  mjs: "text/javascript", svg: "image/svg+xml", png: "image/png",
  jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", avif: "image/avif", ico: "image/x-icon",
  mp3: "audio/mpeg", mp4: "video/mp4", webm: "video/webm",
  wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
};

/** Read a ZIP locally. The selected file never goes to the preflight service. */
export async function collectZipProjectAssets(archive: File): Promise<{ assets: ProjectAsset[]; duplicates: string[] }> {
  if (!/\.zip$/i.test(archive.name)) throw new Error("请选择 ZIP 项目包。");
  if (archive.size > PROJECT_PUBLISH_LIMITS.maxProjectBytes) throw new Error("ZIP 文件超过 300 MB。");

  let fileCount = 0;
  let declaredBytes = 0;
  const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()), { filter: (entry) => {
    if (entry.name.endsWith("/")) return false;
    const path = entry.name.replace(/\\/g, "/");
    if (path.length > PROJECT_PUBLISH_LIMITS.maxPathLength || path.startsWith("/") || /^[a-z]:/i.test(path)
      || path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`ZIP 包含不安全的文件路径：${entry.name}`);
    }
    if (isIgnoredProjectPath(path)) return false;
    fileCount += 1;
    declaredBytes += entry.originalSize;
    if (fileCount > PROJECT_PUBLISH_LIMITS.maxFiles || declaredBytes > PROJECT_PUBLISH_LIMITS.maxProjectBytes) {
      throw new Error("ZIP 解压后超过 500 个文件或 300 MB，请精简项目包。");
    }
    return true;
  } });
  const files: File[] = [];
  let totalBytes = 0;
  for (const [rawPath, bytes] of Object.entries(entries)) {
    if (rawPath.endsWith("/")) continue;
    const path = rawPath.replace(/\\/g, "/");
    totalBytes += bytes.byteLength;
    if (files.length >= PROJECT_PUBLISH_LIMITS.maxFiles || totalBytes > PROJECT_PUBLISH_LIMITS.maxProjectBytes) {
      throw new Error("ZIP 解压后超过 500 个文件或 300 MB，请精简项目包。");
    }
    const name = path.split("/").at(-1) || path;
    const type = MIME_TYPES[name.split(".").at(-1)?.toLowerCase() || ""] || "application/octet-stream";
    const file = new File([new Uint8Array(bytes)], name, { type });
    Object.defineProperty(file, "webkitRelativePath", { value: path });
    files.push(file);
  }
  return collectProjectAssets(files);
}
