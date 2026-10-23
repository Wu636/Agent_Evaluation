import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      Boolean(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function imageContentType(fileUrl: string, contentType: string): string {
  if (/^image\//i.test(contentType)) return contentType;
  const pathname = new URL(fileUrl).pathname.toLowerCase();
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".gif")) return "image/gif";
  return "image/png";
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      fileUrl?: string;
      credentials?: { authorization?: string; cookie?: string };
    };
    const fileUrl = text(body.fileUrl);
    if (!validHttpUrl(fileUrl)) {
      return NextResponse.json(
        { ok: false, error: "图片地址无效。" },
        { status: 400 },
      );
    }

    const authorization = text(body.credentials?.authorization);
    const cookie = text(body.credentials?.cookie);
    const userAgent =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/142 Safari/537.36";
    const headers: HeadersInit = {
      "User-Agent": userAgent,
      ...(authorization ? { Authorization: authorization } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    };
    const fetchOptions: RequestInit = {
      method: "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    };
    let response = await fetch(fileUrl, fetchOptions);
    if (!response.ok && [401, 403].includes(response.status)) {
      response = await fetch(fileUrl, {
        ...fetchOptions,
        headers: {
          "User-Agent": userAgent,
        },
      });
    }
    if (!response.ok) {
      return NextResponse.json(
        { ok: false, error: `图片服务器返回 HTTP ${response.status}。` },
        { status: 502 },
      );
    }

    const contentType = text(response.headers.get("content-type"));
    if (
      contentType &&
      !/^image\//i.test(contentType) &&
      contentType !== "application/octet-stream"
    ) {
      return NextResponse.json(
        { ok: false, error: "图片服务器返回的内容不是图片。" },
        { status: 502 },
      );
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0) {
      return NextResponse.json(
        { ok: false, error: "图片内容为空。" },
        { status: 502 },
      );
    }
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": imageContentType(fileUrl, contentType),
        "Cache-Control": "private, max-age=300",
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "图片预览读取失败。";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
