import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";

const PROJECT_ROOT = path.resolve(process.cwd(), "..");
const HOMEWORK_REVIEW_DIR = path.join(PROJECT_ROOT, "homework_review");
const OUTPUTS_DIR = path.join(HOMEWORK_REVIEW_DIR, "runtime", "outputs");

function getMimeType(fileName: string) {
  if (fileName.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (fileName.endsWith(".json")) return "application/json";
  if (fileName.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get("jobId") || "";
    const file = searchParams.get("file") || "";

    if (!jobId || !file) {
      return NextResponse.json({ error: "缺少 jobId 或 file 参数" }, { status: 400 });
    }

    const jobRoot = path.join(OUTPUTS_DIR, jobId);
    const resolvedPath = path.resolve(jobRoot, file);

    if (!resolvedPath.startsWith(path.resolve(jobRoot))) {
      return NextResponse.json({ error: "非法路径" }, { status: 400 });
    }

    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) {
      return NextResponse.json({ error: "文件不存在" }, { status: 404 });
    }

    const data = await fs.readFile(resolvedPath);
    return new NextResponse(data, {
      headers: {
        "Content-Type": getMimeType(file),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
      },
    });
  } catch (error) {
    console.error("下载文件失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "下载文件失败" },
      { status: 500 }
    );
  }
}
