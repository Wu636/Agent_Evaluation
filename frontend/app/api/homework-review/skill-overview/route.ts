import { NextRequest, NextResponse } from "next/server";
import { getHomeworkApiEndpoint } from "@/lib/homework-api.server";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const endpoint = getHomeworkApiEndpoint("/api/review/skill-overview");
  if (!endpoint) {
    return NextResponse.json(
      { detail: "未配置 HOMEWORK_API_URL，请先配置作业批阅后端地址" },
      { status: 503 },
    );
  }

  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      body: await request.formData(),
      cache: "no-store",
      signal: request.signal,
    });
    const contentType = upstream.headers.get("content-type") || "application/json";
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: {
        "content-type": contentType,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        detail: `连接批阅后端失败：${error instanceof Error ? error.message : "未知错误"}`,
      },
      { status: 502 },
    );
  }
}
