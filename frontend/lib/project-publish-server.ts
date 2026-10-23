import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export const publishAdmin = supabaseUrl && serviceKey
  ? createSupabaseClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

export async function getPublishUser(): Promise<{ id: string } | null> {
  const client = await createClient();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id };
}

export async function getOwnedPublishJob(jobId: string, ownerId: string) {
  if (!publishAdmin) throw new Error("在线预检服务尚未配置 Supabase 服务端密钥。");
  const { data, error } = await publishAdmin.from("project_publish_jobs")
    .select("*").eq("id", jobId).eq("owner_id", ownerId).maybeSingle();
  if (error) throw new Error(`读取在线预检任务失败：${error.message}`);
  if (!data) return null;
  const { data: revision, error: revisionError } = await publishAdmin.from("project_publish_revisions")
    .select("*").eq("id", data.current_revision_id).eq("job_id", data.id).maybeSingle();
  if (revisionError) throw new Error(`读取项目版本失败：${revisionError.message}`);
  if (!revision) throw new Error("在线预检项目版本不存在。");
  return { job: data, revision };
}

export async function queuePublishJob(
  jobId: string,
  ownerId: string,
  workType: "scan" | "repair",
  workPayload: Record<string, unknown> = {},
  expectedStatuses: string[] = ["needs_repair", "needs_attention", "failed"],
) {
  if (!publishAdmin) throw new Error("在线预检服务尚未配置 Supabase 服务端密钥。");
  const { data, error } = await publishAdmin.rpc("enqueue_project_publish_job", {
    p_job_id: jobId,
    p_owner_id: ownerId,
    p_work_type: workType,
    p_work_payload: workPayload,
    p_expected_statuses: expectedStatuses,
  });
  if (error) throw new Error(`提交在线预检任务失败：${error.message}`);
  if (data !== true) throw new Error("在线预检任务状态已变化或已过期，请刷新后重试。");
}
