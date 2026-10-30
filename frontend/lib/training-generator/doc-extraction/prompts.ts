import type { ExtractionMode } from "./types";

export const DOC_EXTRACTION_SYSTEM_PROMPT = `你是教师实训文档的结构化提取专家。你的任务是把长文档压缩成可直接用于训练剧本规划和配置生成的“重点提取版”，同时保证信息保真。

硬性规则：
1. 只能删减、归并、压缩表达，不得新增原文没有的要求、角色、流程、评分项或词汇。
2. 所有数字、百分比、分值、权重、数量、时长必须与原文完全一致，禁止改写、换算或四舍五入。
3. 不得把不同评分项合并为一个，也不得改变评分项之间的权重关系。
4. 保留原文的章节标题和层级；合并内容时，必须在 mergedInto 中写明去向，且合并后的内容必须真实出现在目标章节的 markdown 中。
5. 示例、逐字稿、参考文献、重复说明、背景铺陈属于低优先级，可在不影响理解时省略；但若示例是评分依据或任务必做内容，必须保留。
6. 每个分块内的每个标题都必须出现在输出中，不允许静默丢弃。
7. 只输出合法 JSON，不要输出解释、前言或 JSON 以外的文字。`;

const MODE_INSTRUCTION: Record<ExtractionMode, string> = {
    light: "轻度档：目标输出 8000–10000 字，最多不超过 12000 字，保留大多数重点。完整保留任务目标、角色、流程阶段、评分项与权重、硬性约束，示例、逐字稿和背景说明仅在明显重复或与评分无关时压缩。",
    balanced: "均衡档：目标输出 6000–8000 字，完整保留任务目标、角色、流程阶段、评分项与权重、硬性约束，删除重复背景与冗长示例。",
    strict: "严格档：目标输出 4000–6000 字，只保留模块规划与剧本生成必需的信息：任务目标、角色、阶段流程、评分项与权重、硬性约束；示例、附录和背景说明原则上省略。",
};

export function buildChunkExtractionPrompt(params: {
    chunkText: string;
    chunkPath: string;
    mode: ExtractionMode;
    /** 本分块的建议输出字数；用于把整篇目标分摊到各分块。 */
    targetChars?: number;
    feedback?: string;
    previousOutline?: string;
}): string {
    const segments = [
        "请提取下方教师文档分块中的重点内容，输出结构化 JSON。",
        "",
        `<chunk_path>${params.chunkPath}</chunk_path>`,
        "",
        `<extraction_mode>${params.mode}</extraction_mode>`,
        MODE_INSTRUCTION[params.mode],
        "",
        "<priority>保留优先级：任务名称与训练对象 → 角色与身份设定 → 流程与阶段 → 评分项、子得分点与权重 → 硬性约束（必须/不得/至少/不超过）→ 示例与附录（低优先级）。</priority>",
    ];

    if (params.targetChars) {
        segments.push(
            "",
            `<chunk_target>本分块建议输出约 ${params.targetChars} 字，可上下浮动 20%；输出超长比遗漏重点更危险。</chunk_target>`,
        );
    }

    if (params.previousOutline) {
        segments.push(
            "",
            "<previous_extraction_outline>",
            params.previousOutline,
            "</previous_extraction_outline>",
            "上一版提取结果存在用户不满意之处，请对照修改。",
        );
    }

    if (params.feedback) {
        segments.push("", "<user_feedback>", params.feedback, "</user_feedback>", "用户反馈必须优先满足；若与保真规则冲突，以保真规则为准。");
    }

    segments.push(
        "",
        "<document_chunk>",
        params.chunkText,
        "</document_chunk>",
        "",
        "输出 JSON 结构：",
        `{"sections":[{"title":"章节标题","level":2,"path":"一级标题 > 二级标题","status":"kept","mergedInto":"","markdown":"压缩后的章节正文，必须从原章节标题行开始","excerpt":"","reason":"处理原因"}]}`,
        "",
        "字段要求：",
        "- title/level/path 与原文标题保持一致；分块内没有标题时，用 chunk_path 作为 title，level 用 2。",
        "- status 只能是 kept、merged、omitted。",
        "- kept：markdown 为压缩后的完整章节内容，必须以原章节标题行开头（例如“## 2.3 问诊阶段”），不得新增原文没有的信息。",
        "- merged：该章节内容已并入其他章节，markdown 输出空字符串，mergedInto 写目标章节标题。",
        "- omitted：markdown 输出空字符串，excerpt 摘录不超过 200 字的原文片段，reason 说明为什么可以省略。",
        "- excerpt 仅在 merged/omitted 时填写；reason 用一句话说明。",
        "- 每个分块至少输出一个 section；不得输出原文中不存在的章节。",
    );

    return segments.join("\n");
}
