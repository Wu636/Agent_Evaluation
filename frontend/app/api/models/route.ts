/**
 * GET /api/models
 * 返回实时模型目录（带去重、分类和失败回退）
 */

import { NextResponse } from "next/server";
import { getModelCatalog } from "@/lib/model-catalog";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const apiUrl =
    request.headers.get("x-llm-api-url") ||
    new URL(request.url).searchParams.get("apiUrl") ||
    undefined;
  const apiKey = request.headers.get("x-llm-api-key") || undefined;
  const catalog = await getModelCatalog({
    apiUrl,
    apiKey,
  });
  return NextResponse.json(catalog, {
    headers: {
      "Cache-Control": "s-maxage=600, stale-while-revalidate=3600",
    },
  });
}
