import type {
    ChunkExtractionSection,
    DocExtractionCheck,
    DocExtractionConflict,
    DocExtractionResult,
    DocExtractionSection,
    DocExtractionStats,
    ExtractionMode,
    ExtractionSectionStatus,
} from "./types";
import { EXTRACTION_MODE_LABELS, EXTRACTION_MODE_TARGETS } from "./types";

export interface SourceDocSection {
    index: number;
    title: string;
    level: number;
    path: string;
    text: string;
    startLine: number;
    endLine: number;
}

export interface DocChunk {
    index: number;
    path: string;
    text: string;
}

interface HeadingInfo {
    level: number;
    title: string;
}

const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const CHAPTER_HEADING = /^(第[一二三四五六七八九十百零〇]+[章节部分篇])\s*[:：、.．]?\s*(.*)$/;
const CHINESE_ORDER_HEADING = /^([一二三四五六七八九十百]+)[、.．]\s*(.+)$/;
const PAREN_ORDER_HEADING = /^[（(]([一二三四五六七八九十百]+|\d+)[）)]\s*(.+)$/;
const NUMBER_ORDER_HEADING = /^(\d+(?:\.\d+){0,3})[、.．]\s*(.+)$/;

const NUMERIC_TOKEN_PATTERN =
    /\d+(?:\.\d+)?\s*(?:个月|分钟|小时|秒钟|课时|学分|%|％|秒|天|周|月|年|次|轮|分|条|人|字|页|步|个|项|元|倍|段|章|节)?/g;

const SCORING_LINE_PATTERN = /(评分|权重|分值|得分|满分|占比|考核|评价标准|计分)/;
const RUBRIC_SCORE_PATTERN = /(\d+(?:\.\d+)?\s*分|得分|权重|分值|满分|评分点|评分项)/;
const ITEM_LINE_PATTERN = /^(?:[-*+•]|\d+[.、．]|[（(]\d+[）)]|[①-⑳])/;
const CONSTRAINT_LINE_PATTERN = /(必须|不得|禁止|至少|最少|最多|不超过|不少于|务必|严禁|只能|不可)/;

export function normalizeExtractionDoc(content: string): string {
    return String(content || "")
        .replace(/\r\n/g, "\n")
        .replace(/\u0000/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function detectHeading(line: string): HeadingInfo | null {
    const atx = ATX_HEADING.exec(line);
    if (atx) return { level: atx[1].length, title: atx[2].trim() };

    const chapter = CHAPTER_HEADING.exec(line);
    if (chapter) {
        const title = `${chapter[1]}${chapter[2] ? ` ${chapter[2]}` : ""}`.trim();
        return { level: 2, title };
    }

    const chinese = CHINESE_ORDER_HEADING.exec(line);
    if (chinese && chinese[2].trim().length >= 2) return { level: 2, title: line.trim() };

    const paren = PAREN_ORDER_HEADING.exec(line);
    if (paren && paren[2].trim().length >= 2) return { level: 2, title: line.trim() };

    const numbered = NUMBER_ORDER_HEADING.exec(line);
    if (numbered && numbered[2].trim().length >= 2) {
        const dots = (numbered[1].match(/\./g) || []).length;
        return { level: Math.min(4, 2 + dots), title: line.trim() };
    }

    return null;
}

function readFenceState(line: string, current: { marker: string; length: number } | null) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (!match) return current;
    const run = match[1];
    if (!current) return { marker: run[0], length: run.length };
    if (run[0] === current.marker && run.length >= current.length) return null;
    return current;
}

export function splitDocSections(markdown: string): SourceDocSection[] {
    const normalized = normalizeExtractionDoc(markdown);
    if (!normalized) return [];

    const lines = normalized.split("\n");
    const sections: SourceDocSection[] = [];
    let stack: HeadingInfo[] = [];
    let current: { title: string; level: number; path: string; startLine: number } | null = null;
    let fence: { marker: string; length: number } | null = null;

    const pushSection = (endLine: number) => {
        if (!current) return;
        const text = lines.slice(current.startLine, endLine).join("\n").trim();
        if (text) {
            sections.push({
                index: sections.length,
                title: current.title,
                level: current.level,
                path: current.path,
                text,
                startLine: current.startLine,
                endLine,
            });
        }
        current = null;
    };

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const nextFence = readFenceState(line, fence);
        const insideFence = fence !== null;
        fence = nextFence;

        if (insideFence) continue;
        const heading = detectHeading(line);
        if (!heading) continue;

        if (!current && sections.length === 0) {
            const preamble = lines.slice(0, index).join("\n").trim();
            if (preamble) {
                sections.push({
                    index: 0,
                    title: "文档开头",
                    level: 0,
                    path: "文档开头",
                    text: preamble,
                    startLine: 0,
                    endLine: index,
                });
            }
        }

        pushSection(index);
        while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
            stack.pop();
        }
        stack.push(heading);
        current = {
            title: heading.title,
            level: heading.level,
            path: stack.map((item) => item.title).join(" > "),
            startLine: index,
        };
    }

    pushSection(lines.length);

    if (sections.length === 0 && normalized) {
        return [{
            index: 0,
            title: "全文",
            level: 0,
            path: "全文",
            text: normalized,
            startLine: 0,
            endLine: lines.length,
        }];
    }

    return sections;
}

export function splitOversizedText(text: string, maxChars: number, overlap: number): { text: string; continued: boolean }[] {
    const paragraphs = text.split(/\n{2,}/);
    const pieces: string[] = [];
    let current = "";

    const flush = () => {
        const trimmed = current.trim();
        if (trimmed) pieces.push(trimmed);
        current = "";
    };

    for (const paragraph of paragraphs) {
        if (paragraph.length <= maxChars) {
            if (current && current.length + 2 + paragraph.length > maxChars) flush();
            current = current ? `${current}\n\n${paragraph}` : paragraph;
            continue;
        }

        flush();
        let rest = paragraph;
        while (rest.length > maxChars) {
            let cut = rest.lastIndexOf("\n", maxChars);
            if (cut < Math.floor(maxChars * 0.5)) cut = maxChars;
            pieces.push(rest.slice(0, cut).trim());
            rest = rest.slice(Math.max(0, cut - overlap)).trimStart();
        }
        if (rest.trim()) current = rest.trim();
    }

    flush();
    return pieces.map((piece, index) => ({ text: piece, continued: index > 0 }));
}

export function splitDocIntoChunks(
    markdown: string,
    options: { maxChars?: number; overlap?: number } = {},
): DocChunk[] {
    const maxChars = Math.max(1_500, options.maxChars ?? 6_000);
    const overlap = Math.max(0, Math.min(options.overlap ?? 200, Math.floor(maxChars / 5)));
    const normalized = normalizeExtractionDoc(markdown);
    if (!normalized) return [];
    if (normalized.length <= maxChars) {
        return [{ index: 0, path: "全文", text: normalized }];
    }

    const sections = splitDocSections(normalized);
    const chunks: DocChunk[] = [];
    let buffer = "";
    let bufferPath = "";

    const flush = () => {
        const text = buffer.trim();
        if (text) chunks.push({ index: chunks.length, path: bufferPath || "全文", text });
        buffer = "";
        bufferPath = "";
    };

    for (const section of sections) {
        if (section.text.length > maxChars) {
            flush();
            const pieces = splitOversizedText(section.text, maxChars, overlap);
            pieces.forEach((piece) => {
                chunks.push({
                    index: chunks.length,
                    path: piece.continued ? `${section.path}（续）` : section.path,
                    text: piece.text,
                });
            });
            continue;
        }

        if (buffer && buffer.length + 2 + section.text.length > maxChars) flush();
        if (!buffer) bufferPath = section.path;
        buffer = buffer ? `${buffer}\n\n${section.text}` : section.text;
    }

    flush();
    return chunks;
}

function normalizeTitle(value: string): string {
    return String(value || "")
        .replace(/[#*`>\s]/g, "")
        .replace(/[，。；：、！？,.!?;:]/g, "")
        .toLowerCase();
}

function normalizeForSearch(value: string): string {
    return String(value || "")
        .replace(/\s+/g, "")
        .replace(/[，。；：、！？,.!?;:（）()【】\[\]"'“”‘’—\-]/g, "")
        .toLowerCase();
}

export function normalizeExtractionStatus(value: unknown): ExtractionSectionStatus {
    const raw = String(value || "").trim().toLowerCase();
    if (raw === "merged" || raw === "合并") return "merged";
    if (raw === "omitted" || raw === "omission" || raw === "省略" || raw === "删除") return "omitted";
    return "kept";
}

export function aggregateChunkSections(
    chunkSections: ChunkExtractionSection[],
    sourceSections: SourceDocSection[],
): { sections: DocExtractionSection[]; conflicts: DocExtractionConflict[] } {
    const sourceByTitle = new Map<string, SourceDocSection>();
    sourceSections.forEach((section) => {
        const key = normalizeTitle(section.title);
        if (!sourceByTitle.has(key)) sourceByTitle.set(key, section);
    });

    const merged = new Map<string, DocExtractionSection>();
    const order: string[] = [];
    const conflicts: DocExtractionConflict[] = [];

    for (const raw of chunkSections) {
        const title = String(raw.title || "").trim() || "未命名片段";
        const key = normalizeTitle(title);
        const source = sourceByTitle.get(key);
        const status = normalizeExtractionStatus(raw.status);
        const markdown = status === "omitted" ? "" : String(raw.markdown || "").trim();
        const excerpt = String(raw.excerpt || "").trim();
        const reason = String(raw.reason || "").trim();
        const level = Math.max(1, Math.min(6, Number(raw.level) || 2));
        const path = String(raw.path || "").trim() || title;

        const existing = merged.get(key);
        if (existing) {
            if (existing.status !== status) {
                conflicts.push({
                    type: "section-status",
                    detail: `章节「${title}」在不同分块中被标注为不同处理状态（${existing.status} / ${status}）。`,
                    sourcePaths: [existing.path, path],
                });
                if (status === "kept") existing.status = "kept";
            }
            if (markdown) {
                existing.markdown = existing.markdown ? `${existing.markdown}\n\n${markdown}` : markdown;
            }
            if (excerpt && !existing.excerpt.includes(excerpt)) {
                existing.excerpt = existing.excerpt ? `${existing.excerpt}\n${excerpt}` : excerpt;
            }
            if (!existing.reason && reason) existing.reason = reason;
            if (!existing.mergedInto && raw.mergedInto) existing.mergedInto = raw.mergedInto;
            existing.keptChars = existing.markdown.length;
            continue;
        }

        const section: DocExtractionSection = {
            id: `sec_${order.length + 1}`,
            title,
            level,
            path,
            status,
            mergedInto: raw.mergedInto ? String(raw.mergedInto).trim() : undefined,
            excerpt,
            reason,
            markdown,
            originalChars: source?.text.length ?? 0,
            keptChars: markdown.length,
        };
        merged.set(key, section);
        order.push(key);
    }

    return { sections: order.map((key) => merged.get(key) as DocExtractionSection), conflicts };
}

export function buildExtractionMarkdown(sections: DocExtractionSection[]): string {
    const blocks = sections
        .filter((section) => (section.status === "kept" || section.status === "merged") && section.markdown.trim())
        .map((section) => {
            const markdown = section.markdown.trim();
            const firstLine = markdown.split("\n").find((line) => line.trim()) || "";
            if (/^#{1,6}\s/.test(firstLine)) return markdown;
            const level = Math.max(1, Math.min(6, section.level || 2));
            return `${"#".repeat(level)} ${section.title}\n\n${markdown}`;
        })
        .filter(Boolean);

    return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripLineMarkers(line: string): string {
    return String(line || "")
        .replace(/^\s*#{1,6}\s*/, "")
        .replace(/^\s*第[一二三四五六七八九十百零〇]+[章节部分篇]\s*/, "")
        .replace(/^\s*[一二三四五六七八九十百]+[、.．]\s*/, "")
        .replace(/^\s*[（(](?:[一二三四五六七八九十百]+|\d+)[）)]\s*/, "")
        .replace(/^\s*\d+(?:\.\d+){0,3}[、.．]\s*/, "")
        .replace(/^\s*(?:[-*+•])\s*/, "")
        .trim();
}

function addToken(map: Map<string, number>, token: string) {
    const normalized = token.replace(/\s+/g, "").replace(/％/g, "%");
    if (!normalized) return;
    map.set(normalized, (map.get(normalized) || 0) + 1);
}

export function extractNumericTokens(text: string): Map<string, number> {
    const result = new Map<string, number>();
    for (const line of String(text || "").split("\n")) {
        const cleaned = stripLineMarkers(line);
        if (!cleaned) continue;
        const matches = cleaned.match(NUMERIC_TOKEN_PATTERN) || [];
        matches.forEach((token) => addToken(result, token));
    }
    return result;
}

function isScoringLine(raw: string): boolean {
    const trimmed = raw.trim();
    const cleaned = stripLineMarkers(trimmed);
    if (!cleaned) return false;
    if (SCORING_LINE_PATTERN.test(cleaned)) return true;
    return ITEM_LINE_PATTERN.test(trimmed) && RUBRIC_SCORE_PATTERN.test(cleaned);
}

function extractScoringNumericTokens(text: string): Map<string, number> {
    const result = new Map<string, number>();
    for (const line of String(text || "").split("\n")) {
        if (!isScoringLine(line)) continue;
        const cleaned = stripLineMarkers(line);
        const matches = cleaned.match(NUMERIC_TOKEN_PATTERN) || [];
        matches.forEach((token) => addToken(result, token));
    }
    return result;
}

function sumTokenMap(map: Map<string, number>): number {
    let total = 0;
    map.forEach((count) => { total += count; });
    return total;
}

function countCoveredTokens(source: Map<string, number>, target: Map<string, number>): number {
    let kept = 0;
    source.forEach((count, token) => {
        kept += Math.min(count, target.get(token) || 0);
    });
    return kept;
}

export function countRubricItems(text: string): number {
    let count = 0;
    for (const line of String(text || "").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const stripped = stripLineMarkers(trimmed);
        if (!stripped) continue;
        const isItem = /^(?:[-*+•]|\d+[.、．]|[（(]\d+[）)]|[①-⑳])/.test(trimmed) || /^#{2,6}\s/.test(trimmed);
        const hasScore = /(\d+(?:\.\d+)?\s*分|得分|权重|分值|满分|评分点|评分项)/.test(stripped);
        if (isItem && hasScore) count += 1;
    }
    return count;
}

function collectConstraintLines(text: string): string[] {
    return String(text || "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length >= 6 && CONSTRAINT_LINE_PATTERN.test(line));
}

export function computeStats(
    originalContent: string,
    extractedMarkdown: string,
    sections: DocExtractionSection[],
): DocExtractionStats {
    const originalChars = originalContent.length;
    const extractedChars = extractedMarkdown.length;
    const sourceNumbers = extractNumericTokens(originalContent);
    const keptNumbers = extractNumericTokens(extractedMarkdown);
    const rubricTotal = countRubricItems(originalContent);
    const rubricKept = countRubricItems(extractedMarkdown);

    return {
        originalChars,
        extractedChars,
        compressionRatio: originalChars > 0 ? extractedChars / originalChars : 0,
        keptSections: sections.filter((section) => section.status === "kept").length,
        mergedSections: sections.filter((section) => section.status === "merged").length,
        omittedSections: sections.filter((section) => section.status === "omitted").length,
        numberTotal: sumTokenMap(sourceNumbers),
        numberKept: countCoveredTokens(sourceNumbers, keptNumbers),
        rubricTotal,
        rubricKept: rubricTotal > 0 ? Math.min(rubricTotal, rubricKept) : rubricKept,
    };
}

export function runDeterministicChecks(
    originalContent: string,
    extractedMarkdown: string,
    sections: DocExtractionSection[],
    mode: ExtractionMode,
    options: { edited?: boolean } = {},
): DocExtractionCheck[] {
    const checks: DocExtractionCheck[] = [];
    const extracted = String(extractedMarkdown || "").trim();

    if (!extracted) {
        checks.push({ level: "error", code: "empty-extraction", message: "提取结果为空，无法用于生成。" });
        return checks;
    }
    if (sections.length === 0) {
        checks.push({ level: "error", code: "missing-sections", message: "提取结果缺少章节记录，无法核对覆盖情况。" });
    }

    const sourceSections = splitDocSections(originalContent).filter((section) => section.level > 0);
    const coveredTitles = new Set(sections.map((section) => normalizeTitle(section.title)));
    const missingSections = sourceSections.filter((section) => !coveredTitles.has(normalizeTitle(section.title)));
    if (missingSections.length > 0) {
        const preview = missingSections.slice(0, 5).map((section) => `「${section.title}」`).join("、");
        checks.push({
            level: "warning",
            code: "coverage-gap",
            message: `${missingSections.length} 个原文章节没有出现在覆盖表中：${preview}${missingSections.length > 5 ? " 等" : ""}。请确认这些内容是否已被合并到其他章节。`,
        });
    }

    const sourceScoringNumbers = extractScoringNumericTokens(originalContent);
    const extractedNumbers = extractNumericTokens(extracted);
    const missingScoring: string[] = [];
    sourceScoringNumbers.forEach((count, token) => {
        if (count > (extractedNumbers.get(token) || 0)) missingScoring.push(token);
    });
    if (missingScoring.length > 0) {
        checks.push({
            level: "error",
            code: "missing-scoring-number",
            message: `评分/权重相关数字在提取结果中缺失：${missingScoring.slice(0, 10).join("、")}。可核对后补回评分项，或直接采纳。`,
        });
    }

    const sourceNumbers = extractNumericTokens(originalContent);
    const missingNumbers: string[] = [];
    sourceNumbers.forEach((count, token) => {
        if (!sourceScoringNumbers.has(token) && count > (extractedNumbers.get(token) || 0)) missingNumbers.push(token);
    });
    if (missingNumbers.length > 0) {
        checks.push({
            level: "warning",
            code: "missing-number",
            message: `有 ${missingNumbers.length} 个原文数字未出现在提取结果中：${missingNumbers.slice(0, 8).join("、")}${missingNumbers.length > 8 ? " 等" : ""}。如属背景信息可忽略。`,
        });
    }

    const rubricTotal = countRubricItems(originalContent);
    const rubricKept = countRubricItems(extracted);
    if (rubricTotal > 0 && rubricKept < rubricTotal) {
        checks.push({
            level: "error",
            code: "rubric-count",
            message: `评分项数量从 ${rubricTotal} 个减少到 ${rubricKept} 个。提取不得合并不同评分项。`,
        });
    }

    const extractedForSearch = normalizeForSearch(extracted);
    const missingConstraints: string[] = [];
    collectConstraintLines(originalContent).forEach((line) => {
        const keyword = CONSTRAINT_LINE_PATTERN.exec(line);
        const start = keyword?.index ?? 0;
        const signature = normalizeForSearch(line.slice(start)).slice(0, 16);
        if (signature.length < 4) return;
        if (!extractedForSearch.includes(signature)) missingConstraints.push(line.slice(0, 40));
    });
    if (missingConstraints.length > 0) {
        checks.push({
            level: "warning",
            code: "constraint-missing",
            message: `有 ${missingConstraints.length} 条硬性约束可能未保留：${missingConstraints.slice(0, 5).join("；")}${missingConstraints.length > 5 ? " 等" : ""}。`,
        });
    }

    const modeTarget = EXTRACTION_MODE_TARGETS[mode];
    const modeLabel = EXTRACTION_MODE_LABELS[mode];
    const ratio = originalContent.length > 0 ? extracted.length / originalContent.length : 0;
    if (extracted.length > modeTarget.hardMax) {
        checks.push({
            level: "warning",
            code: "extraction-too-long",
            message: `提取结果 ${extracted.length} 字，超过${modeLabel}档建议上限 ${modeTarget.hardMax} 字，规划与生成仍可能超时。`,
        });
    }
    if (originalContent.length > modeTarget.max && extracted.length < Math.round(modeTarget.min * 0.75)) {
        checks.push({
            level: "warning",
            code: "extraction-too-short",
            message: `提取结果 ${extracted.length} 字，明显低于${modeLabel}档 ${modeTarget.min}–${modeTarget.max} 字目标，可能遗漏较多重点。`,
        });
    }
    if (ratio > 0 && ratio < 0.03) {
        checks.push({
            level: "warning",
            code: "over-compressed",
            message: `提取结果不足原文的 3%，请确认关键流程与评分点是否完整。`,
        });
    }
    if (extracted.length > originalContent.length && originalContent.length > 0) {
        checks.push({
            level: "warning",
            code: "longer-than-source",
            message: "提取结果比原文更长，可能新增了原文没有的内容，请重点核对。",
        });
    }

    if (options.edited) {
        checks.push({
            level: "warning",
            code: "manual-edit",
            message: "提取结果经过手动编辑，覆盖表仍对应原始提取过程；建议重新提取以获得完整审计。",
        });
    }

    return checks;
}

export function buildRationale(
    mode: ExtractionMode,
    sections: DocExtractionSection[],
    stats: DocExtractionStats,
    conflicts: DocExtractionConflict[],
): string {
    const modeLabel = EXTRACTION_MODE_LABELS[mode];
    const modeTarget = EXTRACTION_MODE_TARGETS[mode];
    const target = `${Math.round(modeTarget.min / 1000)}k–${Math.round(modeTarget.max / 1000)}k 字`;
    const keptTitles = sections.filter((section) => section.status === "kept").slice(0, 8).map((section) => section.title);
    const omitted = sections.filter((section) => section.status === "omitted").slice(0, 5);
    const lines = [
        `提取档位：${modeLabel}（目标 ${target}，上限 ${Math.round(modeTarget.hardMax / 1000)}k 字）`,
        `字数变化：${stats.originalChars} 字 → ${stats.extractedChars} 字（${Math.round(stats.compressionRatio * 100)}%）`,
        `章节处理：保留 ${stats.keptSections} 个、合并 ${stats.mergedSections} 个、省略 ${stats.omittedSections} 个`,
        "保留优先级：任务目标与对象 → 角色设定 → 流程与阶段 → 评分项、子得分点与权重 → 硬性约束 → 示例与附录",
    ];
    if (keptTitles.length > 0) {
        lines.push(`重点保留：${keptTitles.map((title) => `「${title}」`).join("、")}${stats.keptSections > keptTitles.length ? " 等" : ""}`);
    }
    if (omitted.length > 0) {
        lines.push(`主要省略：${omitted.map((section) => `「${section.title}」（${section.reason || "低优先级内容"}）`).join("、")}`);
    }
    if (conflicts.length > 0) {
        lines.push(`待确认冲突：${conflicts.map((conflict) => conflict.detail).join("；")}`);
    }
    lines.push("保真规则：只做删减与归并，不新增要求，不改写数字、分值与权重。");
    return lines.join("\n");
}

export function buildExtractionOutline(result: DocExtractionResult): string {
    const statusLabel: Record<ExtractionSectionStatus, string> = {
        kept: "保留",
        merged: "合并",
        omitted: "省略",
    };
    return result.sections
        .map((section) => `${statusLabel[section.status]}｜${section.path || section.title}｜${section.reason || "无说明"}`)
        .join("\n")
        .slice(0, 4_000);
}

export function createExtractionResult(params: {
    originalContent: string;
    extractedMarkdown: string;
    sections: DocExtractionSection[];
    conflicts?: DocExtractionConflict[];
    mode: ExtractionMode;
    docFingerprint: string;
    promptVersion: string;
    feedback?: string;
    edited?: boolean;
    createdAt?: string;
}): DocExtractionResult {
    const originalContent = params.originalContent;
    const extractedMarkdown = params.extractedMarkdown.trim();
    const stats = computeStats(originalContent, extractedMarkdown, params.sections);
    const conflicts = params.conflicts || [];
    const checks = runDeterministicChecks(originalContent, extractedMarkdown, params.sections, params.mode, {
        edited: params.edited,
    });
    const createdAt = params.createdAt || new Date().toISOString();

    return {
        id: `${params.docFingerprint.slice(0, 12)}-${Date.now().toString(36)}`,
        docFingerprint: params.docFingerprint,
        promptVersion: params.promptVersion,
        mode: params.mode,
        edited: Boolean(params.edited),
        originalContent,
        originalChars: originalContent.length,
        extractedChars: extractedMarkdown.length,
        extractedMarkdown,
        rationale: buildRationale(params.mode, params.sections, stats, conflicts),
        sections: params.sections,
        conflicts,
        checks,
        stats,
        feedback: params.feedback,
        createdAt,
    };
}

export function reauditExtractionResult(result: DocExtractionResult, extractedMarkdown: string): DocExtractionResult {
    const trimmed = extractedMarkdown.trim();
    return {
        ...result,
        edited: true,
        extractedMarkdown: trimmed,
        extractedChars: trimmed.length,
        checks: runDeterministicChecks(result.originalContent, trimmed, result.sections, result.mode, { edited: true }),
        stats: computeStats(result.originalContent, trimmed, result.sections),
    };
}

function hashContent(value: string): string {
    let hash = 5381;
    for (let index = 0; index < value.length; index++) {
        hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
    }
    return hash.toString(36);
}

export function buildDocFingerprint(input: {
    content?: string;
    fileName?: string;
    fileSize?: number;
    fileLastModified?: number;
}): string {
    if (input.fileName) {
        return `file:${input.fileName}:${input.fileSize ?? 0}:${input.fileLastModified ?? 0}`;
    }
    const content = String(input.content || "");
    return `text:${content.length}:${hashContent(content)}`;
}
