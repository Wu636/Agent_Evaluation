import { NextRequest, NextResponse } from "next/server";
import WordExtractor from "word-extractor";
import { MODEL_NAME_MAPPING } from "@/lib/config";
import { convertDocxToText } from "@/lib/converters/docx-converter";
import { ApiConfig } from "@/lib/llm/types";
import { regenerateTrainingScriptModule, validateTrainingScriptPlan } from "@/lib/training-generator/generator";
import { TrainingScriptPlan } from "@/lib/training-generator/types";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(request: NextRequest) {
    try {
        let teacherDocContent = "";
        let teacherDocName = "文档";
        let apiKey = "";
        let apiUrl = "";
        let model = "";
        let modulePlan: TrainingScriptPlan | null = null;
        let targetModuleId = "";
        let feedback = "";
        let usePreviousResult = true;
        let currentStageMarkdown = "";

        const contentType = request.headers.get("content-type") || "";

        if (contentType.includes("multipart/form-data")) {
            const formData = await request.formData();
            const file = formData.get("file") as File | null;
            teacherDocName = formData.get("teacherDocName") as string || "文档";
            apiKey = formData.get("apiKey") as string || "";
            apiUrl = formData.get("apiUrl") as string || "";
            model = formData.get("model") as string || "";
            modulePlan = JSON.parse(formData.get("modulePlan") as string || "null");
            targetModuleId = formData.get("targetModuleId") as string || "";
            feedback = formData.get("feedback") as string || "";
            usePreviousResult = formData.get("usePreviousResult") !== "false";
            currentStageMarkdown = formData.get("currentStageMarkdown") as string || "";

            if (!file) {
                return NextResponse.json({ error: "未收到文件" }, { status: 400 });
            }

            const arrayBuffer = await file.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const fileName = file.name.toLowerCase();

            if (fileName.endsWith(".docx")) {
                teacherDocContent = await convertDocxToText(buffer);
            } else if (fileName.endsWith(".doc")) {
                const extractor = new WordExtractor();
                const extracted = await extractor.extract(buffer);
                teacherDocContent = extracted.getBody();
            } else {
                teacherDocContent = buffer.toString("utf-8");
            }
        } else {
            const payload = await request.json();
            ({
                teacherDocContent = "",
                teacherDocName = "文档",
                apiKey = "",
                apiUrl = "",
                model = "",
                modulePlan = null,
                targetModuleId = "",
                feedback = "",
                usePreviousResult = true,
                currentStageMarkdown = "",
            } = payload);
        }

        if (!teacherDocContent.trim()) {
            return NextResponse.json({ error: "文档内容为空，请检查文件格式" }, { status: 400 });
        }
        if (!modulePlan) {
            return NextResponse.json({ error: "缺少模块规划，无法执行单模块重生成" }, { status: 400 });
        }
        if (!feedback.trim()) {
            return NextResponse.json({ error: "请先填写修改建议" }, { status: 400 });
        }
        if (!targetModuleId) {
            return NextResponse.json({ error: "缺少目标模块" }, { status: 400 });
        }

        const validation = validateTrainingScriptPlan(modulePlan);
        if (validation.some((item) => item.level === "error")) {
            return NextResponse.json({ error: "模块规划存在错误，请先修正后再进行局部重生成" }, { status: 400 });
        }

        const targetIndex = modulePlan.modules.findIndex((module) => module.id === targetModuleId);
        if (targetIndex < 0) {
            return NextResponse.json({ error: "未找到目标模块" }, { status: 400 });
        }

        const apiConfig: ApiConfig & { model: string } = {
            apiKey: apiKey || process.env.LLM_API_KEY || "",
            baseUrl: apiUrl || process.env.LLM_BASE_URL || "",
            model: MODEL_NAME_MAPPING[model || ""] || model || process.env.LLM_MODEL || "gpt-4o",
        };

        if (!apiConfig.baseUrl) {
            return NextResponse.json({ error: "未配置 LLM API" }, { status: 400 });
        }

        const stageMarkdown = await regenerateTrainingScriptModule(
            teacherDocContent,
            apiConfig,
            modulePlan,
            modulePlan.modules[targetIndex],
            targetIndex + 1,
            feedback,
            usePreviousResult,
            currentStageMarkdown
        );

        return NextResponse.json({
            teacherDocName,
            stageMarkdown,
            stageIndex: targetIndex,
            moduleId: targetModuleId,
        });
    } catch (error) {
        console.error("[training-generate/module-regenerate] 局部重生成失败:", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "局部重生成失败" },
            { status: 500 }
        );
    }
}
