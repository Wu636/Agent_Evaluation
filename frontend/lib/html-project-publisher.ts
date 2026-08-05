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

export function isLocalProjectReference(reference: string): boolean {
  const { pathname } = splitReference(reference.trim());
  if (isExternalReference(pathname)) return false;
  // Template expressions cannot be resolved until runtime.
  return !/[{}]|\$\{/.test(pathname);
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

  if (path) return { path, suffix };

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

  return fallbackMatches.length === 1 ? { path: fallbackMatches[0], suffix } : null;
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

/** Rewrites complete static path strings in JavaScript/JSON source blocks. */
export function rewriteJavaScriptReferences(
  content: string,
  replaceReference: (reference: string) => string,
): string {
  const quoted = content.replace(
    /(["'])(.*?)\1/g,
    (match, quote: string, value: string) => {
      if (!value || value.includes("\\")) return match;
      const rewritten = replaceReference(value);
      return rewritten === value ? match : `${quote}${rewritten}${quote}`;
    },
  );
  return quoted.replace(
    /`([^`]*)`/g,
    (match, value: string) => {
      if (!value || value.includes("${") || value.includes("\\")) return match;
      const rewritten = replaceReference(value);
      return rewritten === value ? match : `\`${rewritten}\``;
    },
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

/** Rewrites static asset paths in ordinary HTML documents. */
export function rewriteHtmlReferences(
  content: string,
  replaceReference: (reference: string) => string,
): string {
  let rewritten = rewriteHtmlAttributeReferences(content, replaceReference);
  rewritten = rewritten.replace(
    /\bsrcset\s*=\s*(?:(["'])(.*?)\1|([^\s"'=<>`]+))/gi,
    (_match, quote: string | undefined, quotedValue: string | undefined, unquotedValue: string | undefined) => {
      const value = quotedValue ?? unquotedValue ?? "";
      const updated = rewriteSrcset(value, replaceReference);
      return quote ? `srcset=${quote}${updated}${quote}` : `srcset=${updated}`;
    },
  );
  rewritten = rewritten.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_match, start: string, css: string, end: string) => `${start}${rewriteCssReferences(css, replaceReference)}${end}`,
  );
  rewritten = rewritten.replace(
    /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_match, start: string, source: string, end: string) => `${start}${rewriteJavaScriptReferences(source, replaceReference)}${end}`,
  );
  return rewritten.replace(
    /\bstyle\s*=\s*(["'])(.*?)\1/gi,
    (_match, quote: string, css: string) => `style=${quote}${rewriteCssReferences(css, replaceReference)}${quote}`,
  );
}

/** Returns every static reference seen by the same rules used for rewriting. */
export function findHtmlReferences(content: string): string[] {
  const references = new Set<string>();
  rewriteHtmlReferences(content, (reference) => {
    references.add(reference.trim());
    return reference;
  });
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
): string {
  if (publicUrls.size === 0) return content;

  const manifest = Object.fromEntries(publicUrls);
  const safeManifest = JSON.stringify(manifest).replace(/</g, "\\u003c");
  const safeEntryPath = JSON.stringify(entryPath).replace(/</g, "\\u003c");
  const bootstrap = `<script data-polymas-asset-resolver>(function(){
var manifest=${safeManifest};
var entry=${safeEntryPath};
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
window.__polymasAssetUrl=resolve;
var nativeSetAttribute=Element.prototype.setAttribute;
var assetAttrs={src:1,href:1,poster:1,'data-src':1,'data-original':1,'data-background':1,background:1,data:1};
Element.prototype.setAttribute=function(name,value){var key=String(name).toLowerCase();return nativeSetAttribute.call(this,name,assetAttrs[key]?resolve(String(value)):value);};
function patchProperty(ctor,name){if(!ctor||!ctor.prototype)return;var descriptor=Object.getOwnPropertyDescriptor(ctor.prototype,name);if(!descriptor||!descriptor.get||!descriptor.set||descriptor.configurable===false)return;Object.defineProperty(ctor.prototype,name,{configurable:descriptor.configurable,enumerable:descriptor.enumerable,get:descriptor.get,set:function(value){descriptor.set.call(this,resolve(String(value)));}});}
patchProperty(window.HTMLImageElement,'src');patchProperty(window.HTMLMediaElement,'src');patchProperty(window.HTMLSourceElement,'src');patchProperty(window.HTMLScriptElement,'src');patchProperty(window.HTMLLinkElement,'href');patchProperty(window.HTMLIFrameElement,'src');patchProperty(window.HTMLEmbedElement,'src');patchProperty(window.HTMLObjectElement,'data');
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
