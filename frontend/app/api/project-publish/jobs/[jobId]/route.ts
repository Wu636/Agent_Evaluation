import { NextRequest, NextResponse } from "next/server";
import { PROJECT_PUBLISH_BUCKET } from "@/lib/project-publish-online";
import { getOwnedPublishJob, getPublishUser, publishAdmin } from "@/lib/project-publish-server";

export const runtime = "nodejs";
export const maxDuration = 15;

type Context = { params: Promise<{ jobId: string }> };

export async function GET(_request: NextRequest, context: Context) {
  const user = await getPublishUser();
  if (!user) return NextResponse.json({ error: "请先登录。" }, { status: 401 });
  try {
    const { jobId } = await context.params;
    const found = await getOwnedPublishJob(jobId, user.id);
    if (!found) return NextResponse.json({ error: "在线预检任务不存在。" }, { status: 404 });
    if (new Date(found.job.expires_at).getTime() <= Date.now()) return NextResponse.json({ error: "该项目任务已过期。" }, { status: 410 });
    return NextResponse.json({
      job: {
        id: found.job.id,
        status: found.job.status,
        expiresAt: found.job.expires_at,
        progress: found.job.progress,
        releaseUrl: found.job.release_url,
        releaseResult: found.job.release_result,
        revision: {
          id: found.revision.id,
          entryPath: found.revision.entry_path,
          status: found.revision.status,
          manifest: found.revision.manifest,
          fingerprint: found.revision.fingerprint,
          preflightReport: found.revision.preflight_report,
          browserAudit: found.revision.browser_audit,
          repairs: found.revision.repair_suggestions || [],
          warnings: found.revision.warnings || [],
          error: found.revision.error,
        },
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取任务失败。" }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, context: Context) {
  const user = await getPublishUser();
  if (!user) return NextResponse.json({ error: "请先登录。" }, { status: 401 });
  if (!publishAdmin) return NextResponse.json({ error: "在线预检服务未配置。" }, { status: 503 });
  try {
    const { jobId } = await context.params;
    const found = await getOwnedPublishJob(jobId, user.id);
    if (!found) return NextResponse.json({ error: "在线预检任务不存在。" }, { status: 404 });
    const { data: revisions, error: revisionsError } = await publishAdmin.from("project_publish_revisions")
      .select("manifest").eq("job_id", jobId);
    if (revisionsError) throw revisionsError;
    const objects = [...new Set((revisions || []).flatMap((row) => Array.isArray(row.manifest)
      ? row.manifest.map((item: { storagePath?: unknown }) => typeof item.storagePath === "string" ? item.storagePath : "")
      : []).filter(Boolean))];
    const { data: canceled, error: cancelError } = await publishAdmin.from("project_publish_jobs").update({
      status: "failed", error: "user_deleted", work_type: null, work_payload: {},
      lease_owner: null, lease_until: null, updated_at: new Date().toISOString(),
    }).eq("id", jobId).eq("owner_id", user.id)
      .in("status", ["uploading", "needs_repair", "needs_attention", "passed", "confirmed", "published", "failed"])
      .select("id").maybeSingle();
    if (cancelError) throw cancelError;
    if (!canceled) return NextResponse.json({ error: "后台正在处理任务，等它完成后再删除。" }, { status: 409 });
    for (let index = 0; index < objects.length; index += 100) {
      const { error } = await publishAdmin.storage.from(PROJECT_PUBLISH_BUCKET).remove(objects.slice(index, index + 100));
      if (error) throw error;
    }
    const { error } = await publishAdmin.from("project_publish_jobs").delete().eq("id", jobId).eq("owner_id", user.id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "删除任务失败。" }, { status: 500 });
  }
}
