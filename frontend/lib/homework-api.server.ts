import "server-only";

const PRIMARY_ENV_NAME = "HOMEWORK_API_URL";
const LEGACY_ENV_NAME = "NEXT_PUBLIC_HOMEWORK_API_URL";

/**
 * Return the server-side homework service base URL.
 *
 * NEXT_PUBLIC_HOMEWORK_API_URL remains as a temporary fallback so the first
 * deployment of this migration works before the Vercel environment variable
 * is renamed. Client code must never import this module.
 */
export function getHomeworkApiUrl(): string {
  const raw = (
    process.env[PRIMARY_ENV_NAME] ||
    process.env[LEGACY_ENV_NAME] ||
    ""
  ).trim();

  if (!raw) return "";

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${PRIMARY_ENV_NAME} 必须是有效的 HTTP(S) URL`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${PRIMARY_ENV_NAME} 仅支持 HTTP(S) URL`);
  }

  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

export function getHomeworkApiEndpoint(pathname: string): string {
  const baseUrl = getHomeworkApiUrl();
  if (!baseUrl) return "";
  return `${baseUrl}/${pathname.replace(/^\/+/, "")}`;
}

export function isRemoteHomeworkPath(filePath: string): boolean {
  // Python 返回其所在机器的绝对临时路径。Linux/Railway 通常是 /tmp，
  // macOS 本地开发则通常是 /var/folders/.../T。配置后端服务时，生成和
  // 批阅均由该服务执行，因此它返回的绝对路径统一交给后端读取。
  return filePath.startsWith("/") && Boolean(getHomeworkApiUrl());
}
