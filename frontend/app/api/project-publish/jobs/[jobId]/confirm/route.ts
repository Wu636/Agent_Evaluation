import { NextResponse } from "next/server";
import { PROJECT_PUBLISH_BUCKET } from "@/lib/project-publish-online";
import { getOwnedPublishJob, getPublishUser, publishAdmin } from "@/lib/project-publish-server";

export const runtime = "nodejs";
export const maxDuration = 15;
type Context = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, context: Context) {
  const user = await getPublishUser();
  if (!user) return NextResponse.json({ error: "请先登录。" }, { status: 401 });
  if (!publishAdmin) return NextResponse.json({ error: "在线预检服务尚未配置。" }, { status: 503 });
  try {
    const { jobId } = await context.params;
    const found = await getOwnedPublishJob(jobId, user.id);
    if (!found) return NextResponse.json({ error: "在线预检任务不存在。" }, { status: 404 });
    if (new Date(found.job.expires_at).getTime() <= Date.now()) return NextResponse.json({ error: "该项目预检结果已过期，请重新预检。" }, { status: 410 });
    if (!["passed", "confirmed"].includes(found.job.status) || found.revision.status !== "passed"
      || !found.revision.fingerprint || !found.revision.preflight_report || !found.revision.browser_audit) {
      return NextResponse.json({ error: "当前项目版本尚未通过完整复检。" }, { status: 409 });
    }
    const body = await request.json().catch(() => ({})) as { acknowledgeLimitations?: unknown };
    const warnings = Array.isArray(found.revision.warnings) ? found.revision.warnings : [];
    const flows = Array.isArray(found.revision.browser_audit.flows) ? found.revision.browser_audit.flows : [];
    if ((warnings.length > 0 || flows.length === 0) && body.acknowledgeLimitations !== true) {
      return NextResponse.json({ error: "请先确认已阅读预检提示和覆盖范围。" }, { status: 400 });
    }
    const manifest = found.revision.manifest as Array<{ path: string; size: number; type: string; sha256: string; storagePath: string }>;
    const signedFiles: Array<{ path: string; size: number; type: string; sha256: string; url: string }> = [];
    for (let offset = 0; offset < manifest.length; offset += 100) {
      const batch = manifest.slice(offset, offset + 100);
      const { data, error } = await publishAdmin.storage.from(PROJECT_PUBLISH_BUCKET)
        .createSignedUrls(batch.map((item) => item.storagePath), 600);
      if (error || !data) throw new Error(`生成发布版本下载许可失败：${error?.message || "缺少签名"}`);
      batch.forEach((file, index) => {
        const signed = data[index];
        if (signed?.error || !signed?.signedUrl) throw new Error(`无法读取复检版本文件：${file.path}`);
        signedFiles.push({ path: file.path, size: file.size, type: file.type, sha256: file.sha256, url: signed.signedUrl });
      });
    }
    if (found.job.status === "passed") {
      const { data: confirmed, error } = await publishAdmin.from("project_publish_jobs").update({
        status: "confirmed", updated_at: new Date().toISOString(),
      }).eq("id", jobId).eq("owner_id", user.id).eq("status", "passed").select("id").maybeSingle();
      if (error) throw error;
      if (!confirmed) return NextResponse.json({ error: "项目任务状态已变化，请刷新后确认。" }, { status: 409 });
    }
    return NextResponse.json({
      jobId, revisionId: found.revision.id, entryPath: found.revision.entry_path,
      fingerprint: found.revision.fingerprint, files: signedFiles,
      preflightReport: found.revision.preflight_report, browserAudit: found.revision.browser_audit,
      warnings: found.revision.warnings || [], expiresAt: found.job.expires_at,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "确认发布失败。" }, { status: 500 });
  }
}
