import { NextRequest, NextResponse } from "next/server";
import { normalizeProjectPath, PROJECT_PUBLISH_BUCKET } from "@/lib/project-publish-online";
import { getOwnedPublishJob, getPublishUser, publishAdmin } from "@/lib/project-publish-server";

export const runtime = "nodejs";
export const maxDuration = 15;
type Context = { params: Promise<{ jobId: string }> };

export async function POST(request: NextRequest, context: Context) {
  const user = await getPublishUser();
  if (!user) return NextResponse.json({ error: "请先登录。" }, { status: 401 });
  if (!publishAdmin) return NextResponse.json({ error: "在线预检服务尚未配置。" }, { status: 503 });
  try {
    const { jobId } = await context.params;
    const found = await getOwnedPublishJob(jobId, user.id);
    if (!found) return NextResponse.json({ error: "在线预检任务不存在。" }, { status: 404 });
    if (found.job.status !== "uploading" || new Date(found.job.expires_at).getTime() <= Date.now()) {
      return NextResponse.json({ error: "当前任务已冻结或过期。" }, { status: 409 });
    }
    const body = await request.json() as { paths?: unknown };
    if (!Array.isArray(body.paths) || body.paths.length < 1 || body.paths.length > 50
      || body.paths.some((item) => typeof item !== "string")) {
      return NextResponse.json({ error: "每批上传许可最多申请 50 个文件。" }, { status: 400 });
    }
    const requested = [...new Set((body.paths as string[]).map(normalizeProjectPath))];
    if (requested.some((item) => !item)) return NextResponse.json({ error: "文件路径无效。" }, { status: 400 });
    const manifest = found.revision.manifest as Array<{ path: string; storagePath: string }>;
    const records = requested.map((logicalPath) => manifest.find((item) => item.path === logicalPath));
    if (records.some((item) => !item)) return NextResponse.json({ error: "上传许可包含不属于当前版本的文件。" }, { status: 400 });

    const tickets: Record<string, { uploaded: boolean; token?: string; bucket: string; path: string }> = {};
    for (let start = 0; start < records.length; start += 8) {
      await Promise.all(records.slice(start, start + 8).map(async (record) => {
        const file = record!;
        if (file.storagePath !== `jobs/${jobId}/revisions/${found.revision.id}/source/${file.path}`) {
          throw new Error("暂存文件路径与当前版本清单不一致。");
        }
        const segments = file.storagePath.split("/");
        const filename = segments.pop()!;
        const { data: existing, error: listError } = await publishAdmin!.storage.from(PROJECT_PUBLISH_BUCKET)
          .list(segments.join("/"), { limit: 1000, search: filename });
        if (listError) throw new Error(`检查已暂存文件失败：${listError.message}`);
        if ((existing || []).some((item) => item.name === filename && item.id)) {
          tickets[file.path] = { uploaded: true, bucket: PROJECT_PUBLISH_BUCKET, path: file.storagePath };
          return;
        }
        const { data, error } = await publishAdmin!.storage.from(PROJECT_PUBLISH_BUCKET).createSignedUploadUrl(file.storagePath);
        if (error || !data?.token) throw new Error(`生成文件上传许可失败：${file.path}`);
        tickets[file.path] = { uploaded: false, token: data.token, bucket: PROJECT_PUBLISH_BUCKET, path: file.storagePath };
      }));
    }
    return NextResponse.json({ tickets });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "生成上传许可失败。" }, { status: 500 });
  }
}
