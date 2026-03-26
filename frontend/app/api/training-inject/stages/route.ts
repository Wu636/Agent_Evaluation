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
                stepSnapshot: {
                    stepName: step.stepDetailDTO?.stepName || "",
                    description: step.stepDetailDTO?.description || "",
                    prologue: step.stepDetailDTO?.prologue || "",
                    modelId: step.stepDetailDTO?.modelId || "",
                    llmPrompt: step.stepDetailDTO?.llmPrompt || "",
                    trainerName: step.stepDetailDTO?.trainerName || "",
                    interactiveRounds: Number(step.stepDetailDTO?.interactiveRounds) || 0,
                    agentId: step.stepDetailDTO?.agentId || "",
                    avatarNid: step.stepDetailDTO?.avatarNid || "",
                    position: {
                        x: Number(step.positionDTO?.x) || 100,
                        y: Number(step.positionDTO?.y) || 300,
                    },
                },
            }));

        return NextResponse.json({ success: true, stages });
    } catch (error) {
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : "查询阶段失败" },
            { status: 500 }
        );
    }
}
