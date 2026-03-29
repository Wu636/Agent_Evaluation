import { NextRequest, NextResponse } from "next/server";
import { probeCloudapiImageGeneration } from "@/lib/training-injector/api";
import { PolymasCredentials } from "@/lib/training-injector/types";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { credentials } = body as {
            credentials: PolymasCredentials;
        };

        if (!credentials?.authorization || !credentials?.cookie) {
            return NextResponse.json(
                { success: false, error: "缺少平台凭证：Authorization 或 Cookie" },
                { status: 400 }
            );
        }

        const result = await probeCloudapiImageGeneration(credentials);
        if (!result.ok) {
            return NextResponse.json(
                {
                    success: false,
                    provider: "cloudapi",
                    error: result.error || "cloudapi 生图测试失败",
                },
                { status: 200 }
            );
        }

        return NextResponse.json({
            success: true,
            provider: "cloudapi",
            message: "cloudapi 生图测试通过",
            fileId: result.fileId,
            fileUrl: result.fileUrl,
        });
    } catch (error) {
        return NextResponse.json(
            {
                success: false,
                provider: "cloudapi",
                error: error instanceof Error ? error.message : "cloudapi 生图测试失败",
            },
            { status: 500 }
        );
    }
}
