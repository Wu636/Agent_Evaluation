/**
 * GET /api/models
 * 返回可用的模型列表
 */

import { NextResponse } from "next/server";
import { AVAILABLE_MODELS } from "@/lib/config";

export async function GET() {
  return NextResponse.json({ models: AVAILABLE_MODELS });
}
