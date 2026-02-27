import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// POST: 递增模板使用计数
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const supabase = await createClient();
        const { id: templateId } = await params;

        const { error } = await supabase.rpc("increment_prompt_template_use_count", {
            template_id: templateId,
        });

        if (error) {
            console.error("递增使用计数失败:", error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true });
    } catch (e) {
        console.error("递增使用计数异常:", e);
        return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
    }
}
