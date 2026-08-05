export interface ProjectAsset {
  file: File;
  path: string;
}

export interface ProjectFileIndex {
  byPath: Map<string, ProjectAsset>;
  caseInsensitivePaths: Map<string, string>;
}

function normalizePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function isRootFolderPath(paths: string[]): boolean {
  if (paths.length < 2) return false;
  const roots = new Set(paths.map((path) => path.split("/")[0]));
  return roots.size === 1 && paths.every((path) => path.includes("/"));
}

/** Creates project-relative paths from files selected through a folder input. */
export function collectProjectAssets(files: File[]): { assets: ProjectAsset[]; duplicates: string[] } {
  const rawPaths = files.map((file) => normalizePath(file.webkitRelativePath || file.name));
  const removeRoot = isRootFolderPath(rawPaths);
  const assets: ProjectAsset[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const rawPath = rawPaths[index];
    const path = removeRoot ? rawPath.split("/").slice(1).join("/") : rawPath;
    if (!path) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) {
      duplicates.push(path);
      continue;
    }
    seen.add(key);
    assets.push({ file: files[index], path });
  }

  return { assets, duplicates };
}

export function createProjectFileIndex(assets: ProjectAsset[]): ProjectFileIndex {
  return {
    byPath: new Map(assets.map((asset) => [asset.path, asset])),
    caseInsensitivePaths: new Map(assets.map((asset) => [asset.path.toLowerCase(), asset.path])),
  };
}

export function isHtmlFile(path: string): boolean {
  return /\.html?$/i.test(path);
}

export function isCssFile(path: string): boolean {
  return /\.css$/i.test(path);
}

function splitReference(reference: string): { pathname: string; suffix: string } {
  const match = reference.match(/^([^?#]*)([?#][\s\S]*)?$/);
  return { pathname: match?.[1] || reference, suffix: match?.[2] || "" };
}

function isExternalReference(pathname: string): boolean {
  return !pathname
    || pathname.startsWith("#")
    || pathname.startsWith("//")
    || /^[a-z][a-z0-9+.-]*:/i.test(pathname);
}

/** Resolves a relative HTML/CSS reference to a selected project file path. */
export function resolveProjectReference(
  reference: string,
  sourcePath: string,
  index: ProjectFileIndex,
): { path: string; suffix: string } | null {
  const { pathname, suffix } = splitReference(reference.trim());
  if (isExternalReference(pathname)) return null;

  const sourceDirectory = sourcePath.includes("/")
    ? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
    : "";
  const candidate = normalizePath(
    pathname.startsWith("/") ? pathname.slice(1) : `${sourceDirectory}/${pathname}`,
  );
  const decodedCandidate = (() => {
    try {
      return decodeURIComponent(candidate);
    } catch {
      return candidate;
    }
  })();
  const path = index.byPath.has(candidate)
    ? candidate
    : index.caseInsensitivePaths.get(candidate.toLowerCase())
      || index.caseInsensitivePaths.get(decodedCandidate.toLowerCase());

  return path ? { path, suffix } : null;
}

export function findCssReferences(content: string): string[] {
  const found = new Set<string>();
  const urlPattern = /url\(\s*(["']?)([^'"\)]+)\1\s*\)/gi;
  const importPattern = /@import\s+(["'])([^'"\n]+)\1/gi;
  let match: RegExpExecArray | null;

  while ((match = urlPattern.exec(content))) found.add(match[2].trim());
  while ((match = importPattern.exec(content))) found.add(match[2].trim());
  return [...found];
}

export function rewriteCssReferences(
  content: string,
  replaceReference: (reference: string) => string,
): string {
  const withUrls = content.replace(
    /url\(\s*(["']?)([^'"\)]+)\1\s*\)/gi,
    (_match, quote: string, reference: string) => `url(${quote}${replaceReference(reference)}${quote})`,
  );
  return withUrls.replace(
    /(@import\s+)(["'])([^'"\n]+)\2/gi,
    (_match, prefix: string, quote: string, reference: string) => `${prefix}${quote}${replaceReference(reference)}${quote}`,
  );
}

function rewriteSrcset(value: string, replaceReference: (reference: string) => string): string {
  if (value.trim().startsWith("data:")) return value;
  return value.split(",").map((candidate) => {
    const match = candidate.match(/^(\s*)(\S+)([\s\S]*)$/);
    if (!match) return candidate;
    return `${match[1]}${replaceReference(match[2])}${match[3]}`;
  }).join(",");
}

/** Rewrites static asset paths in ordinary HTML documents. */
export function rewriteHtmlReferences(
  content: string,
  replaceReference: (reference: string) => string,
): string {
  let rewritten = content.replace(
    /\b(src|poster)\s*=\s*(["'])(.*?)\2/gi,
    (_match, attribute: string, quote: string, reference: string) => `${attribute}=${quote}${replaceReference(reference)}${quote}`,
  );
  rewritten = rewritten.replace(
    /\bhref\s*=\s*(["'])(.*?)\1/gi,
    (_match, quote: string, reference: string) => `href=${quote}${replaceReference(reference)}${quote}`,
  );
  rewritten = rewritten.replace(
    /\bsrcset\s*=\s*(["'])(.*?)\1/gi,
    (_match, quote: string, reference: string) => `srcset=${quote}${rewriteSrcset(reference, replaceReference)}${quote}`,
  );
  rewritten = rewritten.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_match, start: string, css: string, end: string) => `${start}${rewriteCssReferences(css, replaceReference)}${end}`,
  );
  return rewritten.replace(
    /\bstyle\s*=\s*(["'])(.*?)\1/gi,
    (_match, quote: string, css: string) => `style=${quote}${rewriteCssReferences(css, replaceReference)}${quote}`,
  );
}
