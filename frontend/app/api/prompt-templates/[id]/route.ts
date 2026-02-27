import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { PromptTemplatePayload } from "@/lib/training-generator/types";

// GET: 获取单个 Prompt 模板详情
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const supabase = await createClient();
        const { id: templateId } = await params;

        const { data, error } = await supabase
            .from("prompt_templates")
            .select("*")
            .eq("id", templateId)
            .single();

        if (error) {
            console.error("获取 Prompt 模板详情失败:", error);
            return NextResponse.json({ error: "模板不存在" }, { status: 404 });
        }

        return NextResponse.json({ template: data });
    } catch (e) {
        console.error("获取 Prompt 模板详情异常:", e);
        return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
    }
}

// PUT: 更新 Prompt 模板
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

        const body: PromptTemplatePayload = await request.json();

        // 验证所有权
        const { data: existing } = await supabase
            .from("prompt_templates")
            .select("user_id")
            .eq("id", templateId)
            .single();

        if (!existing || existing.user_id !== user.id) {
            return NextResponse.json({ error: "无权修改该模板" }, { status: 403 });
        }

        // 检查占位符
        if (body.prompt_template && !body.prompt_template.includes("{teacherDoc}")) {
            return NextResponse.json({ error: "模板内容必须包含 {teacherDoc} 占位符" }, { status: 400 });
        }

        const updateData: Record<string, unknown> = {};
        if (body.name !== undefined) updateData.name = body.name;
        if (body.description !== undefined) updateData.description = body.description;
        if (body.prompt_template !== undefined) updateData.prompt_template = body.prompt_template;
        if (body.system_prompt !== undefined) updateData.system_prompt = body.system_prompt;
        if (body.is_public !== undefined) updateData.is_public = body.is_public;
        if (body.tags !== undefined) updateData.tags = body.tags;

        const { data, error } = await supabase
            .from("prompt_templates")
            .update(updateData)
            .eq("id", templateId)
            .select()
            .single();

        if (error) {
            console.error("更新 Prompt 模板失败:", error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ template: data });
    } catch (e) {
        console.error("更新 Prompt 模板异常:", e);
        return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
    }
}

// DELETE: 删除 Prompt 模板
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

        // 验证所有权和是否为系统默认
        const { data: existing } = await supabase
            .from("prompt_templates")
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
            .from("prompt_templates")
            .delete()
            .eq("id", templateId);

        if (error) {
            console.error("删除 Prompt 模板失败:", error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true });
    } catch (e) {
        console.error("删除 Prompt 模板异常:", e);
        return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
    }
}
