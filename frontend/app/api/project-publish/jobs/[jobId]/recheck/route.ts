import { NextResponse } from "next/server";
import { getOwnedPublishJob, getPublishUser, queuePublishJob } from "@/lib/project-publish-server";

export const runtime = "nodejs";
export const maxDuration = 15;
type Context = { params: Promise<{ jobId: string }> };

export async function POST(_request: Request, context: Context) {
  const user = await getPublishUser();
  if (!user) return NextResponse.json({ error: "请先登录。" }, { status: 401 });
  try {
    const { jobId } = await context.params;
    const found = await getOwnedPublishJob(jobId, user.id);
    if (!found) return NextResponse.json({ error: "在线预检任务不存在。" }, { status: 404 });
    if (!["needs_attention", "failed"].includes(found.job.status)) {
      return NextResponse.json({ error: "当前任务状态不支持重新预检。" }, { status: 409 });
    }
    await queuePublishJob(jobId, user.id, "scan");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "提交重新预检失败。" }, { status: 500 });
  }
}
