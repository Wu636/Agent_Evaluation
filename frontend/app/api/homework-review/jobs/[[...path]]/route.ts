import { NextRequest, NextResponse } from "next/server";
import { getHomeworkApiEndpoint } from "@/lib/homework-api.server";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ path?: string[] }>;
};

function errorResponse(message: string, status: number) {
  return NextResponse.json({ detail: message }, { status });
}

async function buildUpstreamUrl(request: NextRequest, context: RouteContext) {
  const { path = [] } = await context.params;
  const suffix = path.length > 0 ? `/${path.map(encodeURIComponent).join("/")}` : "";
  const endpoint = getHomeworkApiEndpoint(`/api/review/jobs${suffix}`);
  if (!endpoint) return "";

  const url = new URL(endpoint);
  request.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.append(key, value);
  });
  return url.toString();
}

async function proxyRequest(request: NextRequest, context: RouteContext) {
  const upstreamUrl = await buildUpstreamUrl(request, context);
  if (!upstreamUrl) {
    return errorResponse("未配置 HOMEWORK_API_URL，请在 Vercel 项目环境变量中配置 Railway 服务地址", 503);
  }

  try {
    const headers = new Headers();
    const contentType = request.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);

    const body = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      signal: request.signal,
    });

    const responseHeaders = new Headers();
    const upstreamContentType = upstream.headers.get("content-type");
    if (upstreamContentType) responseHeaders.set("content-type", upstreamContentType);
    responseHeaders.set("cache-control", "no-store");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return errorResponse(`连接批阅后端失败：${message}`, 502);
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxyRequest(request, context);
}
