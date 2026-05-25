import { NextRequest, NextResponse } from "next/server";
import { editScriptStepDetailDTO, parsePolymasUrl, queryScriptSteps } from "@/lib/training-injector/api";
import { PolymasCredentials } from "@/lib/training-injector/types";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const {
            trainTaskId,
            courseId,
            libraryFolderId,
            stepId,
            prologue,
            credentials,
        } = body as {
            trainTaskId: string;
            courseId?: string;
            libraryFolderId?: string;
            stepId: string;
            prologue: string;
            credentials: PolymasCredentials;
        };

        if (!trainTaskId || !stepId || !credentials?.authorization || !credentials?.cookie) {
            return NextResponse.json(
                { success: false, error: "缺少参数：trainTaskId、stepId 或平台凭证" },
                { status: 400 }
            );
        }

        const nextPrologue = String(prologue ?? "");
        if (!nextPrologue.trim()) {
            return NextResponse.json(
                { success: false, error: "开场白内容不能为空" },
                { status: 400 }
            );
        }

        let finalTrainTaskId = trainTaskId;
        let finalCourseId = String(courseId || "").trim();
        let finalLibraryFolderId = String(libraryFolderId || "").trim();

        if (trainTaskId.includes("http") || trainTaskId.includes("?")) {
            const parsed = parsePolymasUrl(trainTaskId);
            if (parsed?.trainTaskId) {
                finalTrainTaskId = parsed.trainTaskId;
                finalCourseId = finalCourseId || parsed.courseId;
                finalLibraryFolderId = finalLibraryFolderId || parsed.libraryFolderId;
            }
        }

        if (!finalCourseId) {
            return NextResponse.json(
                { success: false, error: "更新开场白需要 courseId，请粘贴完整任务链接或确认已解析出业务 ID" },
                { status: 400 }
            );
        }

        const steps = await queryScriptSteps(finalTrainTaskId, credentials);
        const targetStep = steps.find((step) => step.stepId === stepId);
        const stepDetail = targetStep?.stepDetailDTO;

        if (!targetStep || !stepDetail || stepDetail.nodeType !== "SCRIPT_NODE") {
            return NextResponse.json(
                { success: false, error: "未找到目标阶段卡片，请重新加载阶段列表后再试" },
                { status: 404 }
            );
        }

        const position = {
            x: Number(targetStep.positionDTO?.x) || 100,
            y: Number(targetStep.positionDTO?.y) || 300,
        };
        const nextStepDetailDTO = {
            ...(stepDetail as Record<string, unknown>),
            nodeType: "SCRIPT_NODE",
            prologue: nextPrologue,
        };

        const ok = await editScriptStepDetailDTO(
            finalTrainTaskId,
            stepId,
            nextStepDetailDTO,
            finalCourseId,
            finalLibraryFolderId,
            position,
            credentials
        );

        if (!ok) {
            return NextResponse.json(
                { success: false, error: "开场白写入失败（editScriptStep 返回错误）" },
                { status: 500 }
            );
        }

        return NextResponse.json({
            success: true,
            stage: {
                stepId,
                stepName: stepDetail.stepName || "未命名阶段",
                prologue: nextPrologue,
            },
        });
    } catch (error) {
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : "更新开场白失败" },
            { status: 500 }
        );
    }
}
