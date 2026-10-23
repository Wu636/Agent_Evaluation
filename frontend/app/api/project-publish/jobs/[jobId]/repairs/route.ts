import { NextRequest, NextResponse } from "next/server";
import { getOwnedPublishJob, getPublishUser, publishAdmin, queuePublishJob } from "@/lib/project-publish-server";

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
    if (found.job.status !== "needs_repair") return NextResponse.json({ error: "当前版本没有待确认的确定性修复。" }, { status: 409 });
    const body = await request.json() as { selectedIds?: unknown };
    const selectedIds = Array.isArray(body.selectedIds)
      ? [...new Set(body.selectedIds.filter((item): item is string => typeof item === "string" && item.length <= 2048))]
      : [];
    const suggestions = Array.isArray(found.revision.repair_suggestions) ? found.revision.repair_suggestions : [];
    const allowed = new Set(suggestions.map((item: { id?: unknown }) => item.id).filter((id: unknown): id is string => typeof id === "string"));
    if (!selectedIds.length || selectedIds.some((id) => !allowed.has(id))) {
      return NextResponse.json({ error: "修复选择已过期或不属于当前版本，请重新预检。" }, { status: 400 });
    }
    await queuePublishJob(jobId, user.id, "repair", { selectedIds });
    return NextResponse.json({ ok: true, selectedCount: selectedIds.length });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "提交路径修复失败。" }, { status: 500 });
  }
}
