/**
 * 教师文档章节工具：为剧本生成剥离评分标准章节。
 * 评分标准生成仍需完整文档，故这里只在调用方显式启用时使用。
 */

const MIN_REMAINING_CHARS = 800;
const MAX_REMOVAL_RATIO = 0.85;

const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const CHAPTER_HEADING = /^(第[一二三四五六七八九十百零〇]+[章节部分篇])\s*[:：、.．]?\s*(.*)$/;
const CHINESE_ORDER_HEADING = /^([一二三四五六七八九十百]+)[、.．]\s*(.+)$/;
const PAREN_ORDER_HEADING = /^[（(]([一二三四五六七八九十百]+|\d+)[）)]\s*(.+)$/;
const NUMBER_ORDER_HEADING = /^(\d+(?:\.\d+){0,3})(?:[、．]|\.(?!\d))\s*(.+)$/;
const DOTTED_NUMBER_HEADING = /^(\d+(?:\.\d+){1,3})[ \t]+(.+)$/;

const RUBRIC_TITLE_KEYWORDS = [
    "评分标准",
    "评价标准",
    "评估标准",
    "考核标准",
    "考察标准",
    "评分细则",
    "评价细则",
    "考核细则",
    "评分表",
    "评价表",
    "考核表",
    "评分量表",
    "评分办法",
    "评分方法",
    "评分规则",
    "评分说明",
    "评分体系",
    "评价体系",
    "考核体系",
    "评估体系",
    "评分维度",
    "评价维度",
    "考核维度",
    "评分指标",
    "评价指标",
    "考核指标",
    "评分方式",
    "评价方式",
    "考核方式",
    "评分方案",
    "评价方案",
    "考核方案",
    "评分依据",
    "评价依据",
    "考核依据",
    "评分项目",
    "评价项目",
    "考核项目",
    "评分要点",
    "评价要点",
    "考核要点",
    "评分内容",
    "评价内容",
    "考核内容",
    "成绩评定",
    "成绩构成",
    "成绩计算",
    "分值分布",
    "分值构成",
    "得分点",
    "扣分点",
];

const TASK_TITLE_KEYWORDS = /任务|要求|内容|流程|步骤|过程|目标|场景|角色|活动|操作/;

export interface RubricSectionRemoval {
    title: string;
    chars: number;
}

export interface RubricTrimResult {
    content: string;
    removedSections: RubricSectionRemoval[];
    removedChars: number;
}

interface HeadingInfo {
    line: number;
    level: number;
    title: string;
}

function readFenceState(line: string, current: { marker: string; length: number } | null) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (!match) return current;
    const run = match[1];
    if (!current) return { marker: run[0], length: run.length };
    if (run[0] === current.marker && run.length >= current.length) return null;
    return current;
}

function normalizeHeadingTitle(raw: string): string {
    return raw
        .replace(/^#{1,6}\s*/, "")
        .replace(/^第[一二三四五六七八九十百零〇\d]+[章节部分篇][、.．:：]?\s*/, "")
        .replace(/^[一二三四五六七八九十百]+[、.．]\s*/, "")
        .replace(/^[（(]([一二三四五六七八九十百]+|\d+)[）)]\s*/, "")
        .replace(/^\d+(?:\.\d+){0,3}[、.．]?\s*/, "")
        .replace(/[（(][^）)]*[）)]\s*$/, "")
        .replace(/[:：]\s*$/, "")
        .replace(/\s+/g, "");
}

function isRubricOnlyTitle(title: string): boolean {
    const normalized = normalizeHeadingTitle(title);
    const matchedKeywords = RUBRIC_TITLE_KEYWORDS.filter((keyword) => normalized.includes(keyword));
    if (matchedKeywords.length === 0) return false;
    // 标题里的评分词先剔除，避免“评分内容”这类标题被“内容”误判成任务章节。
    let remainder = normalized;
    for (const keyword of matchedKeywords) remainder = remainder.split(keyword).join("");
    return !TASK_TITLE_KEYWORDS.test(remainder);
}

function detectHeading(line: string): { level: number; title: string } | null {
    const atx = ATX_HEADING.exec(line);
    if (atx) return { level: atx[1].length, title: atx[2].trim() };

    const chapter = CHAPTER_HEADING.exec(line);
    if (chapter) {
        return { level: 2, title: `${chapter[1]}${chapter[2] ? ` ${chapter[2]}` : ""}`.trim() };
    }

    const chinese = CHINESE_ORDER_HEADING.exec(line);
    if (chinese && chinese[2].trim().length >= 2) return { level: 2, title: line.trim() };

    const paren = PAREN_ORDER_HEADING.exec(line);
    if (paren && paren[2].trim().length >= 2) return { level: 3, title: line.trim() };

    const numbered = NUMBER_ORDER_HEADING.exec(line);
    if (numbered && numbered[2].trim().length >= 2) {
        const dots = (numbered[1].match(/\./g) || []).length;
        return { level: Math.min(4, 2 + dots), title: line.trim() };
    }

    // “9.1 标题”这类不带分隔符的多级编号，至少 4 字才当标题，避免“1.5 倍速”误判。
    const dotted = DOTTED_NUMBER_HEADING.exec(line);
    if (dotted && dotted[2].trim().length >= 4) {
        const dots = (dotted[1].match(/\./g) || []).length;
        return { level: Math.min(4, 2 + dots), title: line.trim() };
    }

    const trimmed = line.trim();
    if (trimmed.length > 0 && trimmed.length <= 24 && !/[。；;！？!?]/.test(trimmed)) {
        const normalizedTitle = normalizeHeadingTitle(trimmed);
        if (RUBRIC_TITLE_KEYWORDS.some((keyword) => normalizedTitle === keyword)) {
            return { level: 2, title: trimmed };
        }
    }

    return null;
}

function collectHeadings(lines: string[]): HeadingInfo[] {
    const headings: HeadingInfo[] = [];
    let fence: { marker: string; length: number } | null = null;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const nextFence = readFenceState(line, fence);
        const insideFence = fence !== null;
        fence = nextFence;
        if (insideFence) continue;

        const heading = detectHeading(line);
        if (heading) headings.push({ line: index, level: heading.level, title: heading.title });
    }

    return headings;
}

function findSectionEnd(headings: HeadingInfo[], index: number, totalLines: number): number {
    const level = headings[index].level;
    for (let cursor = index + 1; cursor < headings.length; cursor++) {
        if (headings[cursor].level <= level) return headings[cursor].line;
    }
    return totalLines;
}

function emptyResult(content: string): RubricTrimResult {
    return { content, removedSections: [], removedChars: 0 };
}

/**
 * 移除文档中独立的评分标准/评分细则等章节。
 * 仅匹配标题明确、且不包含任务要求类关键词的章节；识别过度时保持原文不动。
 */
export function stripRubricSections(markdown: string): RubricTrimResult {
    const normalized = String(markdown || "").replace(/\r\n/g, "\n");
    if (!normalized.trim()) return emptyResult(normalized);

    const lines = normalized.split("\n");
    const headings = collectHeadings(lines);
    const removals: Array<{ start: number; end: number; title: string; chars: number }> = [];
    let coveredUntil = -1;

    for (let index = 0; index < headings.length; index++) {
        const heading = headings[index];
        if (heading.line < coveredUntil) continue;
        if (!isRubricOnlyTitle(heading.title)) continue;

        const end = findSectionEnd(headings, index, lines.length);
        if (end <= heading.line) continue;

        const chars = lines.slice(heading.line, end).join("\n").trim().length;
        if (chars === 0) continue;

        removals.push({ start: heading.line, end, title: heading.title.trim(), chars });
        coveredUntil = end;
    }

    if (removals.length === 0) return emptyResult(normalized);

    const keep = new Array<boolean>(lines.length).fill(true);
    for (const removal of removals) {
        for (let index = removal.start; index < removal.end; index++) keep[index] = false;
    }

    const content = lines.filter((_, index) => keep[index]).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    const removedChars = removals.reduce((sum, removal) => sum + removal.chars, 0);
    const originalChars = normalized.trim().length;

    if (content.length < MIN_REMAINING_CHARS || removedChars / originalChars > MAX_REMOVAL_RATIO) {
        return emptyResult(normalized);
    }

    return {
        content,
        removedSections: removals.map(({ title, chars }) => ({ title, chars })),
        removedChars,
    };
}
