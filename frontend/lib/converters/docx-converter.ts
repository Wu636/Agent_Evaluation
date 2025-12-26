/**
 * DOCX 转 Markdown 转换器
 * 使用 mammoth 库进行转换
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require("mammoth");

/**
 * 将 DOCX 文件转换为 Markdown 文本
 * @param buffer DOCX 文件的 Buffer
 * @returns Markdown 文本
 */
export async function convertDocxToMarkdown(
  buffer: Buffer
): Promise<string> {
  try {
    const result = await mammoth.convertToMarkdown({ buffer });
    console.log("✓ 已将 docx 转换为 markdown");
    return result.value;
  } catch (error) {
    throw new Error(
      `DOCX转换失败: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * 将 DOCX 文件转换为纯文本
 * @param buffer DOCX 文件的 Buffer
 * @returns 纯文本
 */
export async function convertDocxToText(buffer: Buffer): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } catch (error) {
    throw new Error(
      `DOCX文本提取失败: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
