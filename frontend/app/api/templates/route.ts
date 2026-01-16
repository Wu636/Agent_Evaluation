import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { cookies } from "next/headers";
import type { TemplatePayload } from "@/lib/templates";

// GET: 获取用户的模板列表
export async function GET() {
    try {
        const supabase = await createClient();

        const { data: { user } } = await supabase.auth.getUser();

        // 获取用户自己的模板 + 系统默认模板
        let query = supabase
            .from("evaluation_templates")
            .select("*")
            .order("created_at", { ascending: false });

        if (user) {
            // 用户可以看到：自己的模板 OR 公开的模板 (包含系统默认模板)
            query = query.or(`user_id.eq.${user.id},is_public.eq.true`);
        } else {
            // 未登录用户可以看到：所有公开的模板
            query = query.eq("is_public", true);
        }

        const { data, error } = await query;

        if (error) {
            console.error("获取模板列表失败:", error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ templates: data || [] });
    } catch (e) {
        console.error("获取模板列表异常:", e);
        return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
    }
}

// POST: 创建新模板
export async function POST(request: NextRequest) {
    try {
        const supabase = await createClient();

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            return NextResponse.json({ error: "未登录" }, { status: 401 });
        }

        const body: TemplatePayload = await request.json();

        if (!body.name || !body.dimensions) {
            return NextResponse.json({ error: "模板名称和维度配置不能为空" }, { status: 400 });
        }

        const { data, error } = await supabase
            .from("evaluation_templates")
            .insert({
                user_id: user.id,
                name: body.name,
                description: body.description || null,
                is_public: body.is_public || false,
                dimensions: body.dimensions
            })
            .select()
            .single();

        if (error) {
            console.error("创建模板失败:", error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ template: data }, { status: 201 });
    } catch (e) {
        console.error("创建模板异常:", e);
        return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
    }
}
