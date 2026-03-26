import { NextRequest, NextResponse } from "next/server";
import { parsePolymasUrl, queryScriptSteps } from "@/lib/training-injector/api";
import { PolymasCredentials } from "@/lib/training-injector/types";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { trainTaskId, credentials } = body as {
            trainTaskId: string;
            credentials: PolymasCredentials;
        };

        if (!trainTaskId || !credentials?.authorization || !credentials?.cookie) {
            return NextResponse.json(
                { success: false, error: "缺少参数：trainTaskId 或平台凭证" },
                { status: 400 }
            );
        }

        let finalTrainTaskId = trainTaskId;
        if (trainTaskId.includes("http") || trainTaskId.includes("?")) {
            const parsed = parsePolymasUrl(trainTaskId);
            if (parsed?.trainTaskId) {
                finalTrainTaskId = parsed.trainTaskId;
            }
        }

        const steps = await queryScriptSteps(finalTrainTaskId, credentials);
        const stages = steps
            .filter((step) => step.stepDetailDTO?.nodeType === "SCRIPT_NODE")
            .map((step) => ({
                stepId: step.stepId,
                stepName: step.stepDetailDTO?.stepName || "未命名阶段",
            }));

        return NextResponse.json({ success: true, stages });
    } catch (error) {
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : "查询阶段失败" },
            { status: 500 }
        );
    }
}
