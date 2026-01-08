import { NextRequest, NextResponse } from "next/server";
import { saveEvaluation } from "@/lib/history-manager";

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { report, teacherDocName, dialogueRecordName, modelName } = body;

        if (!report || !teacherDocName || !dialogueRecordName) {
            return NextResponse.json({ error: "缺少参数" }, { status: 400 });
        }

        // 调用现有的保存逻辑
        const evalId = await saveEvaluation(
            report,
            teacherDocName,
            dialogueRecordName,
            modelName || "unknown"
        );

        return NextResponse.json({ history_id: evalId });

    } catch (error) {
        console.error("保存历史记录失败:", error);
        // 保存失败不应是致命错误，但前端需要知道
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "保存失败" },
            { status: 500 }
        );
    }
}
