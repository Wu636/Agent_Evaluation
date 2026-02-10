import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import mammoth from "mammoth";

export const runtime = "nodejs";

/**
 * GET /api/homework-review/preview?path=<absolute_server_path>
 *
 * 读取服务器上的 .docx 文件，用 mammoth 转换为 HTML 返回给前端预览。
 * 仅允许访问 homework_review/runtime 目录下的文件。
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get("path") || "";
    const isDownload = searchParams.get("download") === "1";

    if (!filePath) {
      return NextResponse.json({ error: "缺少 path 参数" }, { status: 400 });
    }

    // 安全检查：只允许访问 homework_review/runtime 目录
    const PROJECT_ROOT = path.resolve(process.cwd(), "..");
    const ALLOWED_ROOT = path.join(PROJECT_ROOT, "homework_review", "runtime");
    const resolvedPath = path.resolve(filePath);

    if (!resolvedPath.startsWith(path.resolve(ALLOWED_ROOT))) {
      return NextResponse.json({ error: "非法路径：只能预览 runtime 目录下的文件" }, { status: 403 });
    }

    // 检查文件是否存在
    try {
      const stat = await fs.stat(resolvedPath);
      if (!stat.isFile()) {
        return NextResponse.json({ error: "路径不是文件" }, { status: 404 });
      }
    } catch {
      return NextResponse.json({ error: "文件不存在" }, { status: 404 });
    }

    // 检查文件扩展名
    const ext = path.extname(resolvedPath).toLowerCase();
    if (ext !== ".docx" && ext !== ".doc") {
      return NextResponse.json(
        { error: "仅支持预览 .docx / .doc 文件" },
        { status: 400 }
      );
    }

    // 下载模式：直接返回原始文件
    if (isDownload) {
      const data = await fs.readFile(resolvedPath);
      return new NextResponse(data, {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(resolvedPath))}`,
        },
      });
    }

    // 预览模式：用 mammoth 将 docx 转为 HTML
    const buffer = await fs.readFile(resolvedPath);
    const result = await mammoth.convertToHtml(
      { buffer },
      {
        styleMap: [
          // 保留一些基本样式映射
          "p[style-name='Title'] => h1:fresh",
          "p[style-name='Heading 1'] => h2:fresh",
          "p[style-name='Heading 2'] => h3:fresh",
        ],
      }
    );

    const html = result.value;
    const warnings = result.messages
      .filter((m) => m.type === "warning")
      .map((m) => m.message);

    return NextResponse.json({
      html,
      fileName: path.basename(resolvedPath),
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  } catch (error) {
    console.error("预览文件失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "预览文件失败" },
      { status: 500 }
    );
  }
}
