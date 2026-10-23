import { parse, type Node } from "acorn";

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
  if (paths.length === 0) return false;
  const roots = new Set(paths.map((path) => path.split("/")[0]));
  return roots.size === 1 && paths.every((path) => path.includes("/"));
}

const IGNORED_PROJECT_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "__MACOSX",
  "node_modules",
]);

export function isIgnoredProjectPath(path: string): boolean {
  return path.split("/").some((part) =>
    IGNORED_PROJECT_DIRECTORIES.has(part)
    || part === ".DS_Store"
    || part === ".polymas-publish-audit.json"
    || part === "polymas-publish-audit.json"
    || part === "Thumbs.db"
    || /^\.env(?:\.|$)/i.test(part)
    || /\.(?:pem|key|p12|pfx)$/i.test(part)
    || part.startsWith("._"),
  );
}

/** Creates project-relative paths from files selected through a folder input. */
export function collectProjectAssets(files: File[]): { assets: ProjectAsset[]; duplicates: string[] } {
  const records = files.map((file) => ({
    file,
    path: normalizePath(file.webkitRelativePath || file.name),
  })).filter(({ path }) => !isIgnoredProjectPath(path));
  const rawPaths = records.map((record) => record.path);
  const removeRoot = isRootFolderPath(rawPaths);
  const assets: ProjectAsset[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const rawPath = rawPaths[index];
    const path = removeRoot ? rawPath.split("/").slice(1).join("/") : rawPath;
    if (!path) continue;
    const key = path;
    if (seen.has(key)) {
      duplicates.push(path);
      continue;
    }
    seen.add(key);
    assets.push({ file: records[index].file, path });
  }

  assets.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
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

export function isJavaScriptFile(path: string): boolean {
  return /\.(?:cjs|mjs|js)$/i.test(path);
}

export function isSvgFile(path: string): boolean {
  return /\.svg$/i.test(path);
}

/** Image/video/audio types the platform accepts even without a static reference. */
export function isWebMediaFile(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|webm|ogv|mov|m4v|mp3|wav|ogg|m4a|aac|flac)$/i.test(path);
}

/** Returns quoted string literals seen in JavaScript source, using the same rules as rewriteJavaScriptReferences. */
export function findJavaScriptReferences(content: string): string[] {
  const references = new Set<string>();
  rewriteJavaScriptReferences(content, (reference) => {
    references.add(reference.trim());
    return reference;
  });
  return [...references].filter(Boolean);
}

function splitReference(reference: string): { pathname: string; suffix: string } {
  const match = reference.match(/^([^?#]*)([?#][\s\S]*)?$/);
  return { pathname: match ? match[1] : reference, suffix: match?.[2] || "" };
}

function isExternalReference(pathname: string): boolean {
  return !pathname
    || pathname.startsWith("#")
    || pathname.startsWith("//")
    || /^[a-z][a-z0-9+.-]*:/i.test(pathname);
}

export function isLocalProjectReference(reference: string): boolean {
  const { pathname } = splitReference(reference.trim());
  if (isExternalReference(pathname)) return false;
  // Template expressions cannot be resolved until runtime.
  return !/[{}]|\$\{/.test(pathname);
}

/** A bare filename in JavaScript may be appended to a directory at runtime. */
export function isBareRuntimeAssetFilename(reference: string): boolean {
  const { pathname } = splitReference(reference.trim());
  return /^[^.\\/][^\\/]*\.[^\\/]+$/.test(pathname)
    && (isWebMediaFile(pathname) || isCssFile(pathname) || isJavaScriptFile(pathname));
}

/** Resolves a relative HTML/CSS reference to a selected project file path. */
export function resolveProjectReference(
  reference: string,
  sourcePath: string,
  index: ProjectFileIndex,
): { path: string; suffix: string; caseMismatch?: boolean } | null {
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

  if (path) return { path, suffix, caseMismatch: path !== candidate && path !== decodedCandidate };

  // Some exported HTML projects use paths relative to a virtual web root,
  // while the selected folder contains one or more additional parent levels.
  // Fall back only when the suffix match is unique, avoiding an arbitrary file.
  const pathnameOnly = normalizePath(pathname.replace(/^\/+/, ""));
  const decodedPathname = (() => {
    try {
      return decodeURIComponent(pathnameOnly);
    } catch {
      return pathnameOnly;
    }
  })();
  const suffixes = new Set([
    candidate.toLowerCase(),
    decodedCandidate.toLowerCase(),
    pathnameOnly.toLowerCase(),
    decodedPathname.toLowerCase(),
  ].filter(Boolean));
  const fallbackMatches = [...index.byPath.keys()].filter((assetPath) => {
    const lowerAssetPath = assetPath.toLowerCase();
    return [...suffixes].some((suffix) =>
      lowerAssetPath === suffix
      || lowerAssetPath.endsWith(`/${suffix}`)
      || suffix.endsWith(`/${lowerAssetPath}`),
    );
  });

  if (fallbackMatches.length !== 1) return null;
  const match = fallbackMatches[0];
  const exactSuffixes = [candidate, decodedCandidate, pathnameOnly, decodedPathname].filter(Boolean);
  const caseMismatch = !exactSuffixes.some((suffix) => match === suffix || match.endsWith(`/${suffix}`) || suffix.endsWith(`/${match}`));
  return { path: match, suffix, caseMismatch };
}

interface CssUrlToken {
  value: string;
  valueStart: number;
  valueEnd: number;
}

function scanCssUrlTokens(content: string): CssUrlToken[] {
  const tokens: CssUrlToken[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const match = /\burl\s*\(/gi.exec(content.slice(cursor));
    if (!match) break;
    const functionStart = cursor + match.index;
    let position = functionStart + match[0].length;
    while (/\s/.test(content[position] || "")) position += 1;
    const quote = content[position] === '"' || content[position] === "'" ? content[position] : "";

    if (quote) {
      const valueStart = position + 1;
      position = valueStart;
      while (position < content.length) {
        if (content[position] === "\\") {
          position += 2;
          continue;
        }
        if (content[position] === quote) break;
        position += 1;
      }
      if (position >= content.length) break;
      const valueEnd = position;
      position += 1;
      while (/\s/.test(content[position] || "")) position += 1;
      if (content[position] !== ")") {
        cursor = functionStart + match[0].length;
        continue;
      }
      tokens.push({ value: content.slice(valueStart, valueEnd), valueStart, valueEnd });
      cursor = position + 1;
      continue;
    }

    const rawStart = position;
    while (position < content.length && content[position] !== ")") {
      position += content[position] === "\\" ? 2 : 1;
    }
    if (position >= content.length) break;
    const raw = content.slice(rawStart, position);
    const leadingWhitespace = raw.length - raw.trimStart().length;
    const trailingWhitespace = raw.length - raw.trimEnd().length;
    const valueStart = rawStart + leadingWhitespace;
    const valueEnd = position - trailingWhitespace;
    tokens.push({ value: content.slice(valueStart, valueEnd), valueStart, valueEnd });
    cursor = position + 1;
  }
  return tokens;
}

export function findCssReferences(content: string): string[] {
  const found = new Set(scanCssUrlTokens(content).map((token) => token.value.trim()));
  const importPattern = /@import\s+(["'])([^'"\n]+)\1/gi;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(content))) found.add(match[2].trim());
  return [...found].filter(Boolean);
}

/** Rewrites resources referenced by SVG href and xlink:href attributes. */
export function rewriteSvgReferences(
  content: string,
  replaceReference: (reference: string) => string,
): string {
  return rewriteCssReferences(content.replace(
    /\b((?:xlink:)?href)\s*=\s*(["'])(.*?)\2/gi,
    (_match, attribute: string, quote: string, reference: string) =>
      `${attribute}=${quote}${replaceReference(reference)}${quote}`,
  ), replaceReference);
}

export function findSvgReferences(content: string): string[] {
  const found = new Set<string>();
  rewriteSvgReferences(content, (reference) => {
    found.add(reference.trim());
    return reference;
  });
  return [...found].filter(Boolean);
}

export function rewriteCssReferences(
  content: string,
  replaceReference: (reference: string) => string,
): string {
  let withUrls = content;
  for (const token of scanCssUrlTokens(content).reverse()) {
    const rewritten = replaceReference(token.value);
    withUrls = `${withUrls.slice(0, token.valueStart)}${rewritten}${withUrls.slice(token.valueEnd)}`;
  }
  return withUrls.replace(
    /(@import\s+)(["'])([^'"\n]+)\2/gi,
    (_match, prefix: string, quote: string, reference: string) => `${prefix}${quote}${replaceReference(reference)}${quote}`,
  );
}

/** Rewrites complete static path strings in JavaScript/JSON source blocks. */
export function rewriteJavaScriptReferences(
  content: string,
  replaceReference: (reference: string) => string,
): string {
  // 语法树区分资源值、对象键、映射查询、比较常量和来源元数据，避免把路径形状等同于加载依赖。
  type AstNode = Node & Record<string, unknown>;
  let tree: Node;
  let offset = 0;
  const options = { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true } as const;
  try {
    tree = parse(content, options);
  } catch {
    try {
      tree = parse(`(${content})`, options);
      offset = 1;
    } catch {
      throw new Error("JavaScript/JSON 语法无法解析，不能安全扫描或改写资源引用。");
    }
  }
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const propertyName = (node: AstNode | undefined) => node?.type === "Identifier" ? node.name : node?.value;
  const visit = (node: AstNode, parent?: AstNode, field = "", provenance = false) => {
    const metadata = provenance || (parent?.type === "Property" && field === "value"
      && ["sourceRecovery", "provenance", "buildInfo"].includes(String(propertyName(parent.key as AstNode))));
    const isMetadataValue = metadata && parent?.type === "Property" && field === "value"
      && ["sourcePath", "sourceBanner", "sourceSha256"].includes(String(propertyName(parent.key as AstNode)));
    const isKey = parent?.type === "Property" && field === "key";
    const isLookup = parent?.type === "MemberExpression" && field === "property";
    const isComparison = parent?.type === "BinaryExpression" && ["===", "!==", "==", "!="].includes(String(parent.operator));
    let value: string | undefined;
    if (node.type === "Literal" && typeof node.value === "string") value = node.value;
    if (node.type === "TemplateLiteral" && (node.expressions as unknown[]).length === 0) {
      value = ((node.quasis as AstNode[])[0].value as { cooked?: string }).cooked;
    }
    if (value !== undefined && !isKey && !isLookup && !isComparison && !isMetadataValue) {
      const rewritten = replaceReference(value);
      if (rewritten !== value) {
        const start = node.start - offset;
        const quote = content[start];
        let escaped = JSON.stringify(rewritten).slice(1, -1).replace(/</g, "\\u003c");
        if (quote === "'") escaped = escaped.replace(/'/g, "\\'");
        if (quote === "`") escaped = escaped.replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
        replacements.push({ start, end: node.end - offset, text: `${quote}${escaped}${quote}` });
      }
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "start" || key === "end" || key === "loc") continue;
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item === "object" && typeof item.type === "string") visit(item as AstNode, node, key, metadata);
      } else if (child && typeof child === "object" && typeof (child as Node).type === "string") {
        visit(child as AstNode, node, key, metadata);
      }
    }
  };
  visit(tree as AstNode);
  let result = content;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  }
  return result;
}

/** Routes JavaScript-driven page navigation through the injected manifest. */
export function rewriteJavaScriptNavigationReferences(content: string): string {
  let rewritten = content.replace(
    /((?:(?:window\.)?location)\.href\s*=\s*)(["'])([^"'\n]+)\2/g,
    (_match, prefix: string, quote: string, reference: string) =>
      `${prefix}window.__polymasAssetUrl(${quote}${reference}${quote})`,
  );
  // Template-built paths still need the runtime manifest after files are flattened.
  rewritten = rewritten.replace(
    /((?:(?:window\.)?location)\.href\s*=\s*)(`(?:\\[\s\S]|[^`])*`)/g,
    (_match, prefix: string, expression: string) => `${prefix}window.__polymasAssetUrl(${expression})`,
  );
  rewritten = rewritten.replace(
    /((?:(?:window\.)?location)\.(?:assign|replace)\s*\(\s*)(["'])([^"'\n]+)\2/g,
    (_match, prefix: string, quote: string, reference: string) =>
      `${prefix}window.__polymasAssetUrl(${quote}${reference}${quote})`,
  );
  rewritten = rewritten.replace(
    /((?:(?:window\.)?location)\.(?:assign|replace)\s*\(\s*)(`(?:\\[\s\S]|[^`])*`)/g,
    (_match, prefix: string, expression: string) => `${prefix}window.__polymasAssetUrl(${expression})`,
  );
  rewritten = rewritten.replace(
    /(window\.open\s*\(\s*)(`(?:\\[\s\S]|[^`])*`)/g,
    (_match, prefix: string, expression: string) => `${prefix}window.__polymasAssetUrl(${expression})`,
  );
  return rewritten.replace(
    /(window\.open\s*\(\s*)(["'])([^"'\n]+)\2/g,
    (_match, prefix: string, quote: string, reference: string) =>
      `${prefix}window.__polymasAssetUrl(${quote}${reference}${quote})`,
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

function rewriteHtmlAttributeReferences(
  content: string,
  replaceReference: (reference: string) => string,
): string {
  return content.replace(
    /\b(src|poster|href|data-src|data-original|data-background|background|data)\s*=\s*(?:(["'])(.*?)\2|([^\s"'=<>`]+))/gi,
    (_match, attribute: string, quote: string | undefined, quotedValue: string | undefined, unquotedValue: string | undefined) => {
      const reference = quotedValue ?? unquotedValue ?? "";
      const rewritten = replaceReference(reference);
      return quote ? `${attribute}=${quote}${rewritten}${quote}` : `${attribute}=${rewritten}`;
    },
  );
}

function rewriteHtmlMarkupReferences(
  content: string,
  replaceReference: (reference: string) => string,
): string {
  let rewritten = rewriteHtmlAttributeReferences(content, replaceReference);
  rewritten = rewritten.replace(/\b(on[a-z]+)\s*=\s*(["'])([\s\S]*?)\2/gi,
    (_match, attribute: string, quote: string, handler: string) => `${attribute}=${quote}${rewriteJavaScriptNavigationReferences(handler)}${quote}`);
  rewritten = rewritten.replace(
    /\bsrcset\s*=\s*(?:(["'])(.*?)\1|([^\s"'=<>`]+))/gi,
    (_match, quote: string | undefined, quotedValue: string | undefined, unquotedValue: string | undefined) => {
      const value = quotedValue ?? unquotedValue ?? "";
      const updated = rewriteSrcset(value, replaceReference);
      return quote ? `srcset=${quote}${updated}${quote}` : `srcset=${updated}`;
    },
  );
  return rewritten.replace(
    /\bstyle\s*=\s*(["'])(.*?)\1/gi,
    (_match, quote: string, css: string) => `style=${quote}${rewriteCssReferences(css, replaceReference)}${quote}`,
  );
}

export interface HtmlReferenceOptions {
  /** Include complete quoted strings inside inline scripts. Defaults to true. */
  includeScriptStrings?: boolean;
  /** Leave bare asset filenames in inline scripts for runtime path assembly. */
  preserveBareScriptAssetNames?: boolean;
}

/** Rewrites static asset paths in ordinary HTML documents. */
export function rewriteHtmlReferences(
  content: string,
  replaceReference: (reference: string) => string,
  options: HtmlReferenceOptions = {},
): string {
  const blockPattern = /(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi;
  let cursor = 0;
  let rewritten = "";
  let match: RegExpExecArray | null;

  while ((match = blockPattern.exec(content))) {
    rewritten += rewriteHtmlMarkupReferences(content.slice(cursor, match.index), replaceReference);
    const openingTag = rewriteHtmlMarkupReferences(match[1], replaceReference);
    const body = match[2].toLowerCase() === "style"
      ? rewriteCssReferences(match[3], replaceReference)
      : options.includeScriptStrings === false
        ? match[3]
        : rewriteJavaScriptNavigationReferences(rewriteJavaScriptReferences(match[3], (reference) =>
          options.preserveBareScriptAssetNames && isBareRuntimeAssetFilename(reference)
            ? reference
            : replaceReference(reference),
        ));
    rewritten += `${openingTag}${body}${match[4]}`;
    cursor = blockPattern.lastIndex;
  }

  return rewritten + rewriteHtmlMarkupReferences(content.slice(cursor), replaceReference);
}

/** Returns every static reference seen by the same rules used for rewriting. */
export function findHtmlReferences(
  content: string,
  options: HtmlReferenceOptions = {},
): string[] {
  const references = new Set<string>();
  rewriteHtmlReferences(content, (reference) => {
    references.add(reference.trim());
    return reference;
  }, options);
  return [...references].filter(Boolean);
}

/**
 * Injects a tiny runtime resolver for paths assembled by JavaScript after the
 * static rewrite step (for example: `"assets/" + fileName`).
 */
export function injectRuntimeAssetResolver(
  content: string,
  publicUrls: Map<string, string>,
  entryPath: string,
  projectKey?: string,
): string {
  const manifest = Object.fromEntries(publicUrls);
  const safeManifest = JSON.stringify(manifest).replace(/</g, "\\u003c");
  const safeEntryPath = JSON.stringify(entryPath).replace(/</g, "\\u003c");
  const bootstrap = `<script data-polymas-asset-resolver>(function(){
var manifest=${safeManifest};
var entry=${safeEntryPath};
var manifestKey='__POLYMAS_PROJECT_MANIFEST__:'+(${JSON.stringify(projectKey || "").replace(/</g, "\\u003c")}||(Object.keys(manifest).length?manifest[Object.keys(manifest)[0]]:entry));
try{var storedManifest=JSON.parse(sessionStorage.getItem(manifestKey)||'{}');Object.keys(storedManifest).forEach(function(key){if(!manifest[key])manifest[key]=storedManifest[key];});}catch(_storageError){}
manifest[entry]=location.href.split(/[?#]/)[0];
try{sessionStorage.setItem(manifestKey,JSON.stringify(manifest));}catch(_storageError){}
var entryDir=entry.indexOf('/')>=0?entry.slice(0,entry.lastIndexOf('/')):'';
function normalize(value){var out=[];String(value||'').replace(/\\\\/g,'/').split('/').forEach(function(part){if(!part||part==='.')return;if(part==='..'){out.pop();return;}out.push(part);});return out.join('/');}
function resolve(value){
  if(typeof value!=='string'||!value)return value;
  var text=value.trim();
  if(!text||text.charAt(0)==='#'||text.indexOf('//')===0||/^(?:data|blob|javascript|mailto|tel):/i.test(text))return value;
  if(/^[a-z][a-z0-9+.-]*:/i.test(text))return value;
  var suffixIndex=text.search(/[?#]/);var pathname=suffixIndex>=0?text.slice(0,suffixIndex):text;var suffix=suffixIndex>=0?text.slice(suffixIndex):'';
  try{pathname=decodeURIComponent(pathname);}catch(_error){}
  var candidate=normalize(pathname.charAt(0)==='/'?pathname.slice(1):(entryDir?entryDir+'/':'')+pathname);
  var direct=manifest[candidate]||manifest[normalize(pathname.replace(/^\\/+/,''))];
  if(direct)return direct+suffix;
  var matches=Object.keys(manifest).filter(function(key){return key===candidate||key.slice(-(candidate.length+1))==='/'+candidate||candidate.slice(-(key.length+1))==='/'+key;});
  return matches.length===1?manifest[matches[0]]+suffix:value;
}
window.__POLYMAS_ASSET_MANIFEST__=manifest;
window.__POLYMAS_PROJECT_PATH__=entry;
window.__polymasAssetUrl=resolve;
var nativeSetAttribute=Element.prototype.setAttribute;
var assetAttrs={src:1,href:1,poster:1,'data-src':1,'data-original':1,'data-background':1,background:1,data:1};
Element.prototype.setAttribute=function(name,value){var key=String(name).toLowerCase();return nativeSetAttribute.call(this,name,assetAttrs[key]?resolve(String(value)):value);};
function patchProperty(ctor,name){if(!ctor||!ctor.prototype)return;var descriptor=Object.getOwnPropertyDescriptor(ctor.prototype,name);if(!descriptor||!descriptor.get||!descriptor.set||descriptor.configurable===false)return;Object.defineProperty(ctor.prototype,name,{configurable:descriptor.configurable,enumerable:descriptor.enumerable,get:descriptor.get,set:function(value){descriptor.set.call(this,resolve(String(value)));}});}
patchProperty(window.HTMLImageElement,'src');patchProperty(window.HTMLMediaElement,'src');patchProperty(window.HTMLSourceElement,'src');patchProperty(window.HTMLScriptElement,'src');patchProperty(window.HTMLLinkElement,'href');patchProperty(window.HTMLIFrameElement,'src');patchProperty(window.HTMLEmbedElement,'src');patchProperty(window.HTMLObjectElement,'data');
if(window.Audio){var NativeAudio=window.Audio;var ResolvedAudio=function(source){return arguments.length?new NativeAudio(resolve(String(source))):new NativeAudio();};ResolvedAudio.prototype=NativeAudio.prototype;try{Object.setPrototypeOf(ResolvedAudio,NativeAudio);}catch(_audioPrototypeError){}window.Audio=ResolvedAudio;}
var nativeFetch=window.fetch;if(nativeFetch)window.fetch=function(input,init){return nativeFetch.call(this,typeof input==='string'?resolve(input):input,init);};
if(window.XMLHttpRequest){var nativeOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url){var args=Array.prototype.slice.call(arguments);args[1]=resolve(String(url));return nativeOpen.apply(this,args);};}
function rewriteSrcset(value){return String(value||'').split(',').map(function(item){var match=item.match(/^(\\s*)(\\S+)([\\s\\S]*)$/);return match?match[1]+resolve(match[2])+match[3]:item;}).join(',');}
function rewriteStyle(value){return String(value||'').replace(/url\\(\\s*(["']?)([^'"\\)]+)\\1\\s*\\)/gi,function(_match,quote,url){return 'url('+quote+resolve(url)+quote+')';});}
function rewriteElement(element){if(!element||element.nodeType!==1)return;Object.keys(assetAttrs).forEach(function(name){if(!element.hasAttribute(name))return;var oldValue=element.getAttribute(name);var newValue=resolve(oldValue);if(newValue!==oldValue)nativeSetAttribute.call(element,name,newValue);});if(element.hasAttribute('srcset')){var oldSrcset=element.getAttribute('srcset');var newSrcset=rewriteSrcset(oldSrcset);if(newSrcset!==oldSrcset)nativeSetAttribute.call(element,'srcset',newSrcset);}if(element.hasAttribute('style')){var oldStyle=element.getAttribute('style');var newStyle=rewriteStyle(oldStyle);if(newStyle!==oldStyle)nativeSetAttribute.call(element,'style',newStyle);}}
function scan(root){if(!root)return;if(root.nodeType===1)rewriteElement(root);if(root.querySelectorAll)Array.prototype.forEach.call(root.querySelectorAll('[src],[href],[poster],[data-src],[data-original],[data-background],[background],[data],[srcset],[style]'),rewriteElement);}
var observer=new MutationObserver(function(records){records.forEach(function(record){if(record.type==='attributes')rewriteElement(record.target);Array.prototype.forEach.call(record.addedNodes||[],scan);});});
function start(){scan(document.documentElement);observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['src','href','poster','data-src','data-original','data-background','background','data','srcset','style']});}
if(document.documentElement)start();else document.addEventListener('DOMContentLoaded',start,{once:true});
})();</script>`;

  if (/<head\b[^>]*>/i.test(content)) {
    return content.replace(/<head\b[^>]*>/i, (match) => `${match}${bootstrap}`);
  }
  if (/<html\b[^>]*>/i.test(content)) {
    return content.replace(/<html\b[^>]*>/i, (match) => `${match}<head>${bootstrap}</head>`);
  }
  return `${bootstrap}${content}`;
}
