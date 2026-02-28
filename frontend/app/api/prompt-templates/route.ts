import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { PromptTemplatePayload } from "@/lib/training-generator/types";

// GET: 获取 Prompt 模板列表
// 支持 ?type=script|rubric 筛选
export async function GET(request: NextRequest) {
    try {
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();

        const url = new URL(request.url);
        const type = url.searchParams.get("type"); // 'script' | 'rubric' | null

        let query = supabase
            .from("prompt_templates")
            .select("*")
            .order("use_count", { ascending: false })
            .order("created_at", { ascending: false });

        // 类型筛选
        if (type === "script" || type === "rubric") {
            query = query.eq("type", type);
        }

        // 可见性筛选
        if (user) {
            query = query.or(`user_id.eq.${user.id},is_public.eq.true`);
        } else {
            query = query.eq("is_public", true);
        }

        const { data, error } = await query;

        if (error) {
            console.error("获取 Prompt 模板列表失败:", error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // 批量查询创建人用户名（用 admin client 绕过 RLS）
        const userIds = [...new Set((data || []).map((t: any) => t.user_id).filter(Boolean))];
        let profileMap: Record<string, string> = {};
        if (userIds.length > 0) {
            const { data: profiles } = await supabaseAdmin
                .from("profiles")
                .select("id, name, email")
                .in("id", userIds);
            if (profiles) {
                profileMap = Object.fromEntries(
                    profiles.map((p: any) => [
                        p.id,
                        p.name || (p.email ? p.email.split("@")[0] : null),
                    ])
                );
            }
        }

        const templates = (data || []).map((t: any) => ({
            ...t,
            creator_name: t.user_id ? (profileMap[t.user_id] || null) : null,
        }));

        return NextResponse.json({ templates });
    } catch (e) {
        console.error("获取 Prompt 模板列表异常:", e);
        return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
    }
}

// POST: 创建新 Prompt 模板
export async function POST(request: NextRequest) {
    try {
        const supabase = await createClient();

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            return NextResponse.json({ error: "未登录" }, { status: 401 });
        }

        const body: PromptTemplatePayload = await request.json();

        if (!body.name || !body.type || !body.prompt_template) {
            return NextResponse.json({ error: "模板名称、类型和内容不能为空" }, { status: 400 });
        }

        if (body.type !== "script" && body.type !== "rubric") {
            return NextResponse.json({ error: "模板类型必须是 script 或 rubric" }, { status: 400 });
        }

        // 检查模板中是否包含占位符
        if (!body.prompt_template.includes("{teacherDoc}")) {
            return NextResponse.json({ error: "模板内容必须包含 {teacherDoc} 占位符" }, { status: 400 });
        }

        const { data, error } = await supabase
            .from("prompt_templates")
            .insert({
                user_id: user.id,
                name: body.name,
                description: body.description || null,
                type: body.type,
                prompt_template: body.prompt_template,
                system_prompt: body.system_prompt || null,
                is_public: body.is_public || false,
                tags: body.tags || [],
            })
            .select()
            .single();

        if (error) {
            console.error("创建 Prompt 模板失败:", error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ template: data }, { status: 201 });
    } catch (e) {
        console.error("创建 Prompt 模板异常:", e);
        return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
    }
}
