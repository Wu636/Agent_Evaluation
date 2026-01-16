import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { cookies } from "next/headers";
import type { TemplatePayload } from "@/lib/templates";

// GET: 获取单个模板详情
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const supabase = await createClient();
        const { id: templateId } = await params;

        const { data, error } = await supabase
            .from("evaluation_templates")
            .select("*")
            .eq("id", templateId)
            .single();

        if (error) {
            console.error("获取模板详情失败:", error);
            return NextResponse.json({ error: "模板不存在" }, { status: 404 });
        }

        return NextResponse.json({ template: data });
    } catch (e) {
        console.error("获取模板详情异常:", e);
        return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
    }
}

// PUT: 更新模板
export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const supabase = await createClient();
        const { id: templateId } = await params;

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            return NextResponse.json({ error: "未登录" }, { status: 401 });
        }

        const body: TemplatePayload = await request.json();

        // 验证用户是否拥有该模板
        const { data: existing } = await supabase
            .from("evaluation_templates")
            .select("user_id")
            .eq("id", templateId)
            .single();

        if (!existing || existing.user_id !== user.id) {
            return NextResponse.json({ error: "无权修改该模板" }, { status: 403 });
        }

        const { data, error } = await supabase
            .from("evaluation_templates")
            .update({
                name: body.name,
                description: body.description,
                is_public: body.is_public,
                dimensions: body.dimensions
            })
            .eq("id", templateId)
            .select()
            .single();

        if (error) {
            console.error("更新模板失败:", error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ template: data });
    } catch (e) {
        console.error("更新模板异常:", e);
        return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
    }
}

// DELETE: 删除模板
export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const supabase = await createClient();
        const { id: templateId } = await params;

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            return NextResponse.json({ error: "未登录" }, { status: 401 });
        }

        // 验证用户是否拥有该模板
        const { data: existing } = await supabase
            .from("evaluation_templates")
            .select("user_id, is_default")
            .eq("id", templateId)
            .single();

        if (!existing) {
            return NextResponse.json({ error: "模板不存在" }, { status: 404 });
        }

        if (existing.is_default) {
            return NextResponse.json({ error: "无法删除系统默认模板" }, { status: 403 });
        }

        if (existing.user_id !== user.id) {
            return NextResponse.json({ error: "无权删除该模板" }, { status: 403 });
        }

        const { error } = await supabase
            .from("evaluation_templates")
            .delete()
            .eq("id", templateId);

        if (error) {
            console.error("删除模板失败:", error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true });
    } catch (e) {
        console.error("删除模板异常:", e);
        return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
    }
}
