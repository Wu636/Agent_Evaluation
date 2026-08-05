import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const UPLOAD_URL = "https://cloudapi.polymas.com/basic-resource/file/upload";
// Keep each proxied part safely below the common serverless request-body limit.
const MAX_PART_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

function getText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getPositiveInteger(value: string, fallback: number): number {
  const result = Number.parseInt(value, 10);
  return Number.isSafeInteger(result) && result > 0 ? result : fallback;
}

function safeFileName(name: string): string {
  const normalized = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return normalized.slice(0, 180) || "resource";
}

function getPlatformMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as Record<string, unknown>;
  return String(record.msg || record.message || record.error || fallback);
}

/**
 * Upload one resource part to Polymas. The browser sends every part through
 * this route because Authorization/Cookie cannot be set by browser fetch.
 */
export async function POST(request: NextRequest) {
  try {
    const incoming = await request.formData();
    const file = incoming.get("file");
    const authorization = getText(incoming, "authorization");
    const cookie = getText(incoming, "cookie");
    const identifyCode = getText(incoming, "identifyCode");
    const chunks = getPositiveInteger(getText(incoming, "chunks"), 1);
    const chunk = Number.parseInt(getText(incoming, "chunk"), 10);
    const declaredSize = getPositiveInteger(getText(incoming, "size"), 0);

    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "请选择要上传的文件。" }, { status: 400 });
    }
    if (!authorization || !cookie) {
      return NextResponse.json(
        { success: false, error: "请填写平台 Authorization 和 Cookie。" },
        { status: 400 },
      );
    }
    if (!identifyCode || !Number.isSafeInteger(chunk) || chunk < 0 || chunk >= chunks) {
      return NextResponse.json({ success: false, error: "上传分片参数无效。" }, { status: 400 });
    }
    if (file.size > MAX_PART_BYTES) {
      return NextResponse.json(
        { success: false, error: "单个上传分片超过 4 MB，请使用页面的自动分片上传。" },
        { status: 413 },
      );
    }
    if (declaredSize > MAX_TOTAL_BYTES) {
      return NextResponse.json(
        { success: false, error: "当前单文件超过 1 GB，暂不支持上传。" },
        { status: 413 },
      );
    }

    const name = safeFileName(getText(incoming, "name") || file.name);
    const body = new FormData();
    body.append("identifyCode", identifyCode);
    body.append("name", name);
    body.append("chunk", String(chunk));
    body.append("chunks", String(chunks));
    body.append("size", String(declaredSize || file.size));
    body.append("file", new Blob([await file.arrayBuffer()], {
      type: file.type || "application/octet-stream",
    }), name);

    const response = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: authorization,
        Cookie: cookie,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      body,
    });

    const rawText = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
    } catch {
      return NextResponse.json(
        { success: false, error: rawText || `平台上传失败（HTTP ${response.status}）。` },
        { status: response.status >= 400 ? response.status : 502 },
      );
    }

    const succeeded = response.ok && (payload.success === true || payload.code === 200);
    if (!succeeded) {
      return NextResponse.json(
        { success: false, error: getPlatformMessage(payload, `平台上传失败（HTTP ${response.status}）。`) },
        { status: response.status >= 400 ? response.status : 502 },
      );
    }

    const data = payload.data && typeof payload.data === "object"
      ? payload.data as Record<string, unknown>
      : {};
    return NextResponse.json({
      success: true,
      data: {
        fileId: typeof data.fileId === "string" ? data.fileId : "",
        ossUrl: typeof data.ossUrl === "string" ? data.ossUrl : (typeof data.fileUrl === "string" ? data.fileUrl : ""),
      },
    });
  } catch (error) {
    console.error("[resource-upload] upload failed", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { success: false, error: "上传请求处理失败，请检查文件和网络后重试。" },
      { status: 500 },
    );
  }
}
