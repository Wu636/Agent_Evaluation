import { NextRequest, NextResponse } from "next/server";
import { getOwnedPublishJob, getPublishUser, publishAdmin } from "@/lib/project-publish-server";

export const runtime = "nodejs";
export const maxDuration = 15;
type Context = { params: Promise<{ jobId: string }> };

function allowedOssUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (url.hostname === "prod-polymas-oss.polymas.com" || /(?:^|\.)oss-cn-hangzhou\.aliyuncs\.com$/i.test(url.hostname)) return url.href;
  } catch { /* reject invalid URLs */ }
  return null;
}

export async function POST(request: NextRequest, context: Context) {
  const user = await getPublishUser();
  if (!user) return NextResponse.json({ error: "请先登录。" }, { status: 401 });
  if (!publishAdmin) return NextResponse.json({ error: "在线预检服务尚未配置。" }, { status: 503 });
  try {
    const { jobId } = await context.params;
    const found = await getOwnedPublishJob(jobId, user.id);
    if (!found) return NextResponse.json({ error: "在线预检任务不存在。" }, { status: 404 });
    const body = await request.json() as { entryUrl?: unknown; entryPath?: unknown; assetCount?: unknown; replacementCount?: unknown };
    const entryUrl = allowedOssUrl(body.entryUrl);
    if (!entryUrl || body.entryPath !== found.revision.entry_path) {
      return NextResponse.json({ error: "发布链接不属于允许的平台 OSS 域名或不是本次入口文件。" }, { status: 400 });
    }
    if (found.job.status === "published" && found.job.release_url === entryUrl) return NextResponse.json({ ok: true, entryUrl });
    if (found.job.status !== "confirmed" || found.revision.status !== "passed") {
      return NextResponse.json({ error: "请先确认已通过复检的项目版本。" }, { status: 409 });
    }
    if (new Date(found.job.expires_at).getTime() <= Date.now()) return NextResponse.json({ error: "确认已过期，请重新预检。" }, { status: 410 });
    const assetCount = Number(body.assetCount);
    const replacementCount = Number(body.replacementCount);
    if (!Number.isSafeInteger(assetCount) || assetCount < 1 || assetCount > 500
      || !Number.isSafeInteger(replacementCount) || replacementCount < 0) {
      return NextResponse.json({ error: "发布结果统计无效。" }, { status: 400 });
    }
    const probe = await fetch(entryUrl, {
      method: "GET", headers: { Range: "bytes=0-511" }, redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const contentType = probe.headers.get("content-type") || "";
    const reader = probe.body?.getReader();
    const first = await reader?.read();
    await reader?.cancel().catch(() => undefined);
    const prefix = first?.value ? new TextDecoder().decode(first.value.slice(0, 512)) : "";
    if (!probe.ok || !/^(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)
      || /^\s*(?:<\?xml[^>]*>\s*)?<Error[\s>]/i.test(prefix)) {
      return NextResponse.json({ error: "入口 OSS 链接尚未通过服务端网页可访问性复核。" }, { status: 502 });
    }
    const { error } = await publishAdmin.from("project_publish_jobs").update({
      status: "published", release_url: entryUrl,
      release_result: { assetCount, replacementCount, revisionId: found.revision.id, releasedAt: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    }).eq("id", jobId).eq("owner_id", user.id).eq("status", "confirmed");
    if (error) throw error;
    return NextResponse.json({ ok: true, entryUrl });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "登记发布结果失败。" }, { status: 500 });
  }
}
