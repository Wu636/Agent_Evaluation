import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET: 获取当前用户的个人资料
export async function GET() {
    try {
        const supabase = await createClient();

        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: "未登录" }, { status: 401 });
        }

        // 从 profiles 表获取用户信息
        const { data: profile, error } = await supabase
            .from("profiles")
            .select("*")
            .eq("id", user.id)
            .single();

        if (error && error.code !== 'PGRST116') { // PGRST116 = not found
            console.error("获取个人资料失败:", error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ profile: profile || null });
    } catch (e) {
        console.error("获取个人资料异常:", e);
        return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
    }
}

// PATCH: 更新当前用户的个人资料
export async function PATCH(request: NextRequest) {
    try {
        const supabase = await createClient();

        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: "未登录" }, { status: 401 });
        }

        const body = await request.json();
        const { name } = body;

        if (!name || !name.trim()) {
            return NextResponse.json({ error: "名字不能为空" }, { status: 400 });
        }

        // 先检查 profile 是否存在
        const { data: existingProfile } = await supabase
            .from("profiles")
            .select("id")
            .eq("id", user.id)
            .single();

        let result;
        if (existingProfile) {
            // 更新现有记录
            result = await supabase
                .from("profiles")
                .update({ name: name.trim() })
                .eq("id", user.id)
                .select()
                .single();
        } else {
            // 创建新记录
            result = await supabase
                .from("profiles")
                .insert({
                    id: user.id,
                    name: name.trim(),
                    email: user.email
                })
                .select()
                .single();
        }

        if (result.error) {
            console.error("更新个人资料失败:", result.error);
            return NextResponse.json({ error: result.error.message }, { status: 500 });
        }

        return NextResponse.json({ profile: result.data });
    } catch (e) {
        console.error("更新个人资料异常:", e);
        return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
    }
}
