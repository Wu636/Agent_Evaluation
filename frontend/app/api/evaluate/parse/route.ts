import { NextRequest, NextResponse } from "next/server";
import { parseTxtDialogue } from "@/lib/txt-converter";
import { convertDocxToMarkdown } from "@/lib/converters/docx-converter";
import WordExtractor from 'word-extractor';

export const maxDuration = 60; // Enough for file parsing

async function readFileInfo(file: File): Promise<{ name: string; content: string | Buffer }> {
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    if (file.name.endsWith(".docx")) {
        const markdown = await convertDocxToMarkdown(buffer);
        console.log("✓ 已将 docx 转换为 markdown");
        return { name: file.name, content: markdown };
    } else if (file.name.endsWith(".doc")) {
        // 处理旧版 .doc 格式
        const extractor = new WordExtractor();
        const extracted = await extractor.extract(buffer);
        const text = extracted.getBody();
        console.log("✓ 已从 .doc 文件提取文本");
        return { name: file.name, content: text };
    } else if (file.name.endsWith(".md") || file.name.endsWith(".txt")) {
        const text = buffer.toString("utf-8");
        return { name: file.name, content: text };
    } else {
        throw new Error(`不支持的文件格式: ${file.name}`);
    }
}

export async function POST(request: NextRequest) {
    try {
        const formData = await request.formData();
        const teacherDoc = formData.get("teacher_doc") as File;
        const dialogueRecord = formData.get("dialogue_record") as File;
        const workflowConfigFile = formData.get("workflow_config") as File | null;

        if (!teacherDoc || !dialogueRecord) {
            return NextResponse.json({ error: "缺少必需的文件" }, { status: 400 });
        }

        // 1. 解析教师文档
        const teacherDocInfo = await readFileInfo(teacherDoc);

        // 2. 解析对话记录
        const dialogueBytes = await dialogueRecord.arrayBuffer();
        const dialogueBuffer = Buffer.from(dialogueBytes);
        let dialogueData;

        if (dialogueRecord.name.endsWith(".txt")) {
            const textContent = dialogueBuffer.toString("utf-8");
            dialogueData = parseTxtDialogue(textContent);
        } else if (dialogueRecord.name.endsWith(".json")) {
            const textContent = dialogueBuffer.toString("utf-8");
            dialogueData = JSON.parse(textContent);
        } else {
            throw new Error(`不支持的对话记录格式: ${dialogueRecord.name}`);
        }

        // 3. 解析工作流配置 (可选)
        let workflowConfigContent = undefined;
        if (workflowConfigFile) {
            const workflowConfigInfo = await readFileInfo(workflowConfigFile);
            workflowConfigContent = workflowConfigInfo.content as string;
        }

        return NextResponse.json({
            teacherDoc: {
                name: teacherDocInfo.name,
                content: teacherDocInfo.content
            },
            dialogueRecord: {
                name: dialogueRecord.name,
                data: dialogueData
            },
            workflowConfig: workflowConfigContent ? {
                name: workflowConfigFile?.name,
                content: workflowConfigContent
            } : undefined
        });

    } catch (error) {
        console.error("解析文件失败:", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "解析失败" },
            { status: 500 }
        );
    }
}
