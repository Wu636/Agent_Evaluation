/**
 * POST /api/training-generate/plan
 * 训练剧本模块规划 API
 */

import { NextRequest, NextResponse } from "next/server";
import { MODEL_NAME_MAPPING } from "@/lib/config";
import { ApiConfig } from "@/lib/llm/types";
import { planTrainingScriptModules, validateTrainingScriptPlan } from "@/lib/training-generator/generator";
import { convertDocxToText } from "@/lib/converters/docx-converter";
import WordExtractor from "word-extractor";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(request: NextRequest) {
    try {
        let teacherDocContent = "";
        let teacherDocName = "文档";
        let apiKey = "";
        let apiUrl = "";
        let model = "";
        let planningFeedback = "";
        let usePreviousPlan = false;
        let currentPlan = undefined;
        let previousPlan = undefined;

        const contentType = request.headers.get("content-type") || "";

        if (contentType.includes("multipart/form-data")) {
            const formData = await request.formData();
            const file = formData.get("file") as File | null;
            teacherDocName = formData.get("teacherDocName") as string || "文档";
            planningFeedback = formData.get("planningFeedback") as string || "";
            usePreviousPlan = formData.get("usePreviousPlan") === "true";
            currentPlan = (() => {
                const raw = formData.get("currentPlan") as string || "";
                return raw ? JSON.parse(raw) : undefined;
            })();
            previousPlan = (() => {
                const raw = formData.get("previousPlan") as string || "";
                return raw ? JSON.parse(raw) : undefined;
            })();
            apiKey = formData.get("apiKey") as string || "";
            apiUrl = formData.get("apiUrl") as string || "";
            model = formData.get("model") as string || "";

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
                planningFeedback = "",
                usePreviousPlan = false,
                currentPlan = undefined,
                previousPlan = undefined,
                apiKey = "",
                apiUrl = "",
                model = "",
            } = payload);
        }

        if (!teacherDocContent.trim()) {
            return NextResponse.json({ error: "文档内容为空，请检查文件格式" }, { status: 400 });
        }

        const apiConfig: ApiConfig & { model: string } = {
            apiKey: apiKey || process.env.LLM_API_KEY || "",
            baseUrl: apiUrl || process.env.LLM_BASE_URL || "",
            model: MODEL_NAME_MAPPING[model || ""] || model || process.env.LLM_MODEL || "gpt-4o",
        };

        if (!apiConfig.baseUrl) {
            return NextResponse.json({ error: "未配置 LLM API" }, { status: 400 });
        }

        const result = await planTrainingScriptModules(teacherDocContent, apiConfig, {
            planningFeedback,
            usePreviousPlan,
            currentPlan,
            previousPlan,
        });
        const validation = validateTrainingScriptPlan(result.plan);

        return NextResponse.json({
            teacherDocName,
            plan: result.plan,
            validation,
            autofillApplied: result.autofillApplied,
            autofillFields: result.autofillFields,
            autofillTaskFields: result.autofillTaskFields,
            autofillModuleFields: result.autofillModuleFields,
        });
    } catch (error) {
        console.error("[training-generate/plan] 规划失败:", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "规划失败" },
            { status: 500 }
        );
    }
}
