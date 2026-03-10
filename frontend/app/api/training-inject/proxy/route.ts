/**
 * POST /api/training-inject/proxy
 * 代理转发请求到 polymas 平台 API，绕过浏览器 CORS 限制
 */

import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { targetUrl, payload, credentials } = body as {
            targetUrl: string;
            payload: Record<string, unknown>;
            credentials: { authorization: string; cookie: string };
        };

        if (!targetUrl || !credentials?.authorization || !credentials?.cookie) {
            return NextResponse.json(
                { success: false, code: 400, message: "缺少必要参数" },
                { status: 400 }
            );
        }

        // 仅允许代理到 polymas 域名
        if (!targetUrl.startsWith("https://cloudapi.polymas.com/")) {
            return NextResponse.json(
                { success: false, code: 403, message: "不允许的目标地址" },
                { status: 403 }
            );
        }

        const res = await fetch(targetUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                Authorization: credentials.authorization,
                Cookie: credentials.cookie,
                "User-Agent":
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
            },
            body: JSON.stringify(payload),
        });

        const data = await res.json();
        return NextResponse.json(data);
    } catch (error) {
        console.error("Proxy error:", error);
        return NextResponse.json(
            {
                success: false,
                code: 500,
                message: error instanceof Error ? error.message : "代理请求失败",
            },
            { status: 500 }
        );
    }
}
