import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { isIgnoredProjectPath, isHtmlFile } from "@/lib/html-project-publisher";
import { normalizeProjectPath, PROJECT_PUBLISH_LIMITS } from "@/lib/project-publish-online";
import { getPublishUser, publishAdmin } from "@/lib/project-publish-server";

export const runtime = "nodejs";
export const maxDuration = 15;

interface IncomingFile {
  path?: unknown;
  size?: unknown;
  type?: unknown;
  sha256?: unknown;
}

export async function POST(request: NextRequest) {
  const user = await getPublishUser();
  if (!user) return NextResponse.json({ error: "请先登录后使用在线项目预检。" }, { status: 401 });
  if (!publishAdmin) return NextResponse.json({ error: "在线预检服务尚未配置，请联系管理员。" }, { status: 503 });

  try {
    const body = await request.json() as { entryPath?: unknown; files?: unknown };
    const entryPath = typeof body.entryPath === "string" ? normalizeProjectPath(body.entryPath) : null;
    if (!entryPath || !isHtmlFile(entryPath) || !Array.isArray(body.files) || !body.files.length) {
      return NextResponse.json({ error: "请提供 HTML 入口和项目文件清单。" }, { status: 400 });
    }
    if (body.files.length > PROJECT_PUBLISH_LIMITS.maxFiles) {
      return NextResponse.json({ error: `项目最多支持 ${PROJECT_PUBLISH_LIMITS.maxFiles} 个文件。` }, { status: 413 });
    }

    const paths = new Set<string>();
    let totalBytes = 0;
    const files = [] as Array<{ path: string; size: number; type: string; sha256: string; storagePath: string }>;
    for (const raw of body.files as IncomingFile[]) {
      const path = typeof raw.path === "string" ? normalizeProjectPath(raw.path) : null;
      const size = typeof raw.size === "number" ? raw.size : Number.NaN;
      const submittedType = typeof raw.type === "string" ? raw.type.slice(0, 160) : "";
      const type = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(submittedType) ? submittedType : "application/octet-stream";
      const sha256 = typeof raw.sha256 === "string" ? raw.sha256.toLowerCase() : "";
      if (!path || isIgnoredProjectPath(path) || paths.has(path)
        || !Number.isSafeInteger(size) || size < 0 || size > PROJECT_PUBLISH_LIMITS.maxFileBytes
        || !/^[a-f0-9]{64}$/.test(sha256)) {
        return NextResponse.json({ error: `文件清单有重复路径或无效文件：${String(raw.path || "(空路径)")}` }, { status: 400 });
      }
      paths.add(path);
      totalBytes += size;
      files.push({ path, size, type, sha256, storagePath: "" });
    }
    if (totalBytes > PROJECT_PUBLISH_LIMITS.maxProjectBytes) {
      return NextResponse.json({ error: `项目总大小超过 ${Math.round(PROJECT_PUBLISH_LIMITS.maxProjectBytes / 1024 / 1024)} MB 限额。` }, { status: 413 });
    }
    if (!paths.has(entryPath)) return NextResponse.json({ error: "入口 HTML 不在项目文件清单中。" }, { status: 400 });

    const { data: activeJobs, error: activeJobsError } = await publishAdmin.from("project_publish_jobs")
      .select("id").eq("owner_id", user.id).in("status", ["uploading", "queued", "processing", "needs_repair", "needs_attention", "passed", "confirmed"])
      .gt("expires_at", new Date().toISOString());
    if (activeJobsError) throw activeJobsError;
    if ((activeJobs || []).length >= 3) {
      return NextResponse.json({ error: "当前账号已有 3 个未过期项目任务，请先完成或删除一个任务。" }, { status: 429 });
    }

    const jobId = randomUUID();
    const revisionId = randomUUID();
    const expiresAt = new Date(Date.now() + PROJECT_PUBLISH_LIMITS.retentionHours * 60 * 60 * 1000).toISOString();
    for (const file of files) file.storagePath = `jobs/${jobId}/revisions/${revisionId}/source/${file.path}`;

    const { error: jobError } = await publishAdmin.from("project_publish_jobs").insert({
      id: jobId, owner_id: user.id, status: "uploading", current_revision_id: revisionId,
      expires_at: expiresAt, progress: { phase: "upload", completed: 0, total: files.length },
    });
    if (jobError) throw jobError;
    const { error: revisionError } = await publishAdmin.from("project_publish_revisions").insert({
      id: revisionId, job_id: jobId, parent_revision_id: null, entry_path: entryPath,
      manifest: files, status: "uploading", fingerprint: null, preflight_report: null,
      browser_audit: null, repair_suggestions: [], warnings: [], error: null,
    });
    if (revisionError) {
      await publishAdmin.from("project_publish_jobs").delete().eq("id", jobId).eq("owner_id", user.id);
      throw revisionError;
    }
    return NextResponse.json({ jobId, revisionId, expiresAt, fileCount: files.length, totalBytes });
  } catch (error) {
    console.error("[project-publish] create job failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: error instanceof Error ? error.message : "创建在线预检任务失败。" }, { status: 500 });
  }
}

export async function GET() {
  const user = await getPublishUser();
  if (!user) return NextResponse.json({ error: "请先登录。" }, { status: 401 });
  if (!publishAdmin) return NextResponse.json({ error: "在线预检服务尚未配置。" }, { status: 503 });
  const { data, error } = await publishAdmin.from("project_publish_jobs")
    .select("id,status,current_revision_id,expires_at,progress,created_at")
    .eq("owner_id", user.id).gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false }).limit(10);
  if (error) return NextResponse.json({ error: "读取项目任务列表失败。" }, { status: 500 });
  return NextResponse.json({ jobs: data || [] });
}
