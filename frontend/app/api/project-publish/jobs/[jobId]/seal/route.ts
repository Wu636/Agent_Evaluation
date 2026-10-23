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
    if (found.job.status !== "uploading") return NextResponse.json({ error: "该任务已提交或已冻结。" }, { status: 409 });
    await queuePublishJob(jobId, user.id, "scan", {}, ["uploading"]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "提交预检失败。" }, { status: 500 });
  }
}
