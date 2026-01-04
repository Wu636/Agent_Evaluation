/**
 * POST /api/evaluate
 * 上传文件并执行评测
 */

import { NextRequest, NextResponse } from "next/server";
import { evaluate } from "@/lib/llm/evaluator";
import { saveEvaluation } from "@/lib/history-manager";
import { parseTxtDialogue } from "@/lib/txt-converter";
import { convertDocxToMarkdown } from "@/lib/converters/docx-converter";
import { EvaluationLevel } from "@/lib/llm/types";

export const maxDuration = 300; // 5分钟超时

async function readFileInfo(file: File): Promise<{ name: string; content: string | Buffer }> {
  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);

  if (file.name.endsWith(".docx")) {
    // 转换 DOCX 为 Markdown
    const markdown = await convertDocxToMarkdown(buffer);
    return { name: file.name, content: markdown };
  } else if (file.name.endsWith(".md") || file.name.endsWith(".txt")) {
    // 直接读取文本
    const text = buffer.toString("utf-8");
    return { name: file.name, content: text };
  } else {
    throw new Error(`不支持的文件格式: ${file.name}`);
  }
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();

    const teacherDoc = formData.get("teacher_doc") as File;
    const dialogueRecord = formData.get("dialogue_record") as File;
    const apiKey = formData.get("api_key") as string | null;
    const apiUrl = formData.get("api_url") as string | null;
    const model = formData.get("model") as string | null;

    if (!teacherDoc || !dialogueRecord) {
      return NextResponse.json(
        { error: "缺少必需的文件" },
        { status: 400 }
      );
    }

    console.log(`✓ 收到文件: ${teacherDoc.name}, ${dialogueRecord.name}`);

    // 读取教师文档
    const teacherDocInfo = await readFileInfo(teacherDoc);
    console.log(`✓ 已加载教师文档: ${(teacherDocInfo.content as string).length} 字符`);

    // 读取对话记录
    const dialogueBytes = await dialogueRecord.arrayBuffer();
    const dialogueBuffer = Buffer.from(dialogueBytes);

    let dialogueData;

    if (dialogueRecord.name.endsWith(".txt")) {
      // TXT 文件需要转换
      const textContent = dialogueBuffer.toString("utf-8");
      dialogueData = parseTxtDialogue(textContent);
      console.log(`✓ 已将 TXT 对话记录转换为 JSON`);
    } else if (dialogueRecord.name.endsWith(".json")) {
      // JSON 文件直接解析
      const textContent = dialogueBuffer.toString("utf-8");
      dialogueData = JSON.parse(textContent);
    } else {
      throw new Error(`不支持的对话记录格式: ${dialogueRecord.name}`);
    }

    console.log(`✓ 已加载对话记录: ${dialogueData.metadata.total_rounds} 轮`);

    // 构建配置
    const apiConfig = {
      apiKey: apiKey || process.env.LLM_API_KEY || "",
      baseUrl: apiUrl || process.env.LLM_BASE_URL || "",
      model: model || process.env.LLM_MODEL || "gpt-4o",
    };

    if (!apiConfig.apiKey) {
      return NextResponse.json(
        { error: "未配置 LLM API 密钥。请在设置中配置或设置环境变量 LLM_API_KEY" },
        { status: 400 }
      );
    }

    if (!apiConfig.baseUrl) {
      return NextResponse.json(
        { error: "未配置 LLM API 地址。请在设置中配置或设置环境变量 LLM_BASE_URL" },
        { status: 400 }
      );
    }

    console.log(`✓ LLM配置: ${apiConfig.baseUrl} / ${apiConfig.model}`);

    // 执行评测
    const report = await evaluate(
      teacherDocInfo.content as string,
      dialogueData,
      apiConfig
    );

    // 转换为前端期望的格式
    const frontendResult: {
      total_score: number;
      dimensions: Record<string, { score: number; comment: string }>;
      analysis: string;
      issues: string[];
      suggestions: string[];
      final_level: EvaluationLevel;
      pass_criteria_met: boolean;
      veto_reasons: string[];
      history_id: string;
    } = {
      total_score: report.totalScore,
      dimensions: report.dimensions.reduce(
        (acc, dim) => {
          const key = Object.keys(
            require("@/lib/config").DIMENSIONS
          ).find(
            (k) =>
              (require("@/lib/config").DIMENSIONS as any)[k].name ===
              dim.dimension
          ) || dim.dimension;

          acc[key] = {
            score: dim.score,
            comment: dim.analysis,
          };
          return acc;
        },
        {} as Record<string, { score: number; comment: string }>
      ),
      analysis: report.executiveSummary,
      issues: report.criticalIssues,
      suggestions: report.actionableSuggestions,
      final_level: report.finalLevel,
      pass_criteria_met: report.passCriteriaMet,
      veto_reasons: report.vetoReasons,
      history_id: "",
    };

    // 保存到历史记录（失败不影响结果返回）
    try {
      const evalId = await saveEvaluation(
        {
          total_score: report.totalScore,
          final_level: report.finalLevel,
          dimensions: report.dimensions.map((d) => ({
            dimension: d.dimension,
            score: d.score,
            weight: d.weight,
            level: d.level,
            analysis: d.analysis,
            evidence: d.evidence,
            issues: d.issues,
            suggestions: d.suggestions,
          })),
          executive_summary: report.executiveSummary,
          critical_issues: report.criticalIssues,
          actionable_suggestions: report.actionableSuggestions,
          pass_criteria_met: report.passCriteriaMet,
          veto_reasons: report.vetoReasons,
        },
        teacherDoc.name,
        dialogueRecord.name,
        apiConfig.model
      );
      frontendResult.history_id = evalId;
    } catch (historyError) {
      console.warn("保存历史记录失败，但评估已完成:", historyError);
      // 历史保存失败不影响返回结果
    }

    return NextResponse.json(frontendResult);
  } catch (error) {
    console.error("评测失败:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "评测失败",
      },
      { status: 500 }
    );
  }
}
