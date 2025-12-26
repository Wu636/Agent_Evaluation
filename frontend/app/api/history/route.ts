/**
 * GET /api/history
 * 获取所有评测历史记录（摘要）
 */

import { NextResponse } from "next/server";
import { getAllHistory } from "@/lib/history-manager";

export async function GET() {
  try {
    const history = await getAllHistory();
    return NextResponse.json({ history });
  } catch (error) {
    console.error("获取历史记录失败:", error);
    return NextResponse.json(
      { error: "获取历史记录失败" },
      { status: 500 }
    );
  }
}
