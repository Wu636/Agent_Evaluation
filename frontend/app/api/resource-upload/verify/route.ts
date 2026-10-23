import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 15;

function allowedOssUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (url.hostname === "prod-polymas-oss.polymas.com"
      || /(?:^|\.)oss-cn-hangzhou\.aliyuncs\.com$/i.test(url.hostname)) return url;
  } catch {
    // Invalid URLs are rejected below.
  }
  return null;
}

export async function GET(request: NextRequest) {
  const url = allowedOssUrl(request.nextUrl.searchParams.get("url") || "");
  if (!url) return NextResponse.json({ ok: false, invalid: true, error: "仅可验证平台 OSS 链接。" }, { status: 400 });
  const sizeParam = request.nextUrl.searchParams.get("size");
  const expectedSize = sizeParam === null ? null : Number(sizeParam);
  if (expectedSize !== null && (!Number.isSafeInteger(expectedSize) || expectedSize < 0)) {
    return NextResponse.json({ ok: false, error: "文件大小无效。" }, { status: 400 });
  }
  const expectHtml = request.nextUrl.searchParams.get("html") === "1";

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-511" },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const contentType = response.headers.get("content-type") || "";
    const firstChunk = response.body?.getReader();
    const first = await firstChunk?.read();
    await firstChunk?.cancel().catch(() => undefined);
    const preview = first?.value ? new TextDecoder().decode(first.value.slice(0, 512)) : "";
    const total = response.status === 206
      ? response.headers.get("content-range")?.match(/\/(\d+)$/)?.[1]
      : response.headers.get("content-length");
    const sizeMismatch = expectedSize !== null && total != null && Number(total) !== expectedSize;
    const downloadOnly = /\battachment\b/i.test(response.headers.get("content-disposition") || "");
    const htmlMismatch = expectHtml && (downloadOnly || !/^(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType));
    const ossError = /^\s*(?:<\?xml[^>]*>\s*)?<Error[\s>]/i.test(preview);
    const invalid = [403, 404, 410].includes(response.status) || (response.ok && (sizeMismatch || htmlMismatch || ossError
      || (expectedSize !== null && expectedSize > 0 && !first?.value?.byteLength)));
    const ok = response.ok && !invalid;
    return NextResponse.json({ ok, invalid, status: response.status, contentType,
      error: htmlMismatch ? "HTML 链接无法按网页预览，请检查 OSS 响应头。" : sizeMismatch ? "上传文件大小与源文件不一致。" : undefined,
    }, { status: ok ? 200 : 502 });
  } catch {
    return NextResponse.json({ ok: false, error: "OSS 链接暂时无法验证。" }, { status: 502 });
  }
}
