/**
 * GET /api/history/[id]
 * DELETE /api/history/[id]
 * 获取或删除指定的评测历史记录
 */

import { NextRequest, NextResponse } from "next/server";
import { getHistoryById, deleteHistoryById } from "@/lib/history-manager";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const item = await getHistoryById(id);

    if (!item) {
      return NextResponse.json(
        { error: "Evaluation not found" },
        { status: 404 }
      );
    }

    // 转换为前端期望的格式
    const rawReport = item.report as any;

    // 检查是否需要转换格式
    let frontendReport;
    if (rawReport.critical_issues || Array.isArray(rawReport.dimensions)) {
      // 旧格式，需要转换
      frontendReport = {
        total_score: rawReport.total_score || 0,
        dimensions:
          Array.isArray(rawReport.dimensions) && rawReport.dimensions.length > 0
            ? rawReport.dimensions.reduce(
                (acc: any, dim: any) => {
                  acc[dim.dimension] = {
                    score: dim.score,
                    comment: dim.analysis,
                  };
                  return acc;
                },
                {} as Record<string, { score: number; comment: string }>
              )
            : {},
        analysis: rawReport.executive_summary || "",
        issues: rawReport.critical_issues || [],
        suggestions: rawReport.actionable_suggestions || [],
        final_level: rawReport.final_level || "",
        pass_criteria_met: rawReport.pass_criteria_met ?? false,
        veto_reasons: rawReport.veto_reasons || [],
        history_id: id,
      };
    } else {
      // 已经是前端格式
      frontendReport = rawReport;
      frontendReport.history_id = id;
    }

    return NextResponse.json({ report: frontendReport });
  } catch (error) {
    console.error("获取历史记录详情失败:", error);
    return NextResponse.json(
      { error: "获取历史记录详情失败" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const success = await deleteHistoryById(id);

    if (!success) {
      return NextResponse.json(
        { error: "Evaluation not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, message: "Evaluation deleted" });
  } catch (error) {
    console.error("删除历史记录失败:", error);
    return NextResponse.json(
      { error: "删除历史记录失败" },
      { status: 500 }
    );
  }
}
