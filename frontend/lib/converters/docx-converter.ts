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
 * @throws 如果文档包含图片则抛出错误
 */
export async function convertDocxToMarkdown(
  buffer: Buffer
): Promise<string> {
  try {
    // 先检测是否包含图片 (使用默认转换，不忽略图片)
    const checkResult = await mammoth.convertToHtml({ buffer });

    // mammoth 会在 messages 中报告警告，也会在转换结果中包含 img 标签
    const hasImages = checkResult.value.includes('<img') ||
      checkResult.messages.some((msg: { type: string; message: string }) =>
        msg.type === 'warning' && msg.message.includes('image')
      );

    if (hasImages) {
      throw new Error('DOCX_CONTAINS_IMAGES: 文档包含图片，请移除图片后重新上传。系统暂不支持处理包含图片的文档。');
    }

    // 安全转换为 markdown
    const result = await mammoth.convertToMarkdown({ buffer });
    console.log("✓ 已将 docx 转换为 markdown");
    return result.value;
  } catch (error) {
    // 如果是我们自定义的图片错误，直接抛出
    if (error instanceof Error && error.message.startsWith('DOCX_CONTAINS_IMAGES:')) {
      throw error;
    }
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
