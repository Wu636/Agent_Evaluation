import type { TeacherDocSource } from "../types";

export type { TeacherDocSource };

export type ExtractionMode = "light" | "balanced" | "strict";
export type ExtractionSectionStatus = "kept" | "merged" | "omitted";
export type ExtractionStage = "parse" | "chunk" | "merge" | "audit";

export const EXTRACTION_MODE_LABELS: Record<ExtractionMode, string> = {
    light: "轻度",
    balanced: "均衡",
    strict: "严格",
};

/** 各档位的目标字数；轻度档直接对齐主流模型可稳定承载的 8k–12k 规划长度。 */
export const EXTRACTION_MODE_TARGETS: Record<ExtractionMode, { min: number; max: number; hardMax: number }> = {
    light: { min: 8_000, max: 10_000, hardMax: 12_000 },
    balanced: { min: 6_000, max: 8_000, hardMax: 10_000 },
    strict: { min: 4_000, max: 6_000, hardMax: 8_000 },
};

export const DOC_EXTRACTION_PROMPT_VERSION = "doc-extract-v1";
export const DOC_EXTRACTION_MIN_CHARS = 8_000;
export const DOC_EXTRACTION_STRONG_HINT_CHARS = 20_000;
export const DOC_EXTRACTION_MAX_CHARS = 150_000;
export const DOC_EXTRACTION_MAX_CHUNKS = 24;
export const DOC_EXTRACTION_CHUNK_CHARS = 6_000;
export const DOC_EXTRACTION_CHUNK_OVERLAP = 200;
export const DOC_EXTRACTION_BUDGET_MS = 240_000;

export interface DocExtractionProgress {
    stage: ExtractionStage;
    current: number;
    total: number;
    message: string;
}

export interface DocExtractionSection {
    id: string;
    title: string;
    level: number;
    path: string;
    status: ExtractionSectionStatus;
    mergedInto?: string;
    /** 合并/省略时保留的原文片段，用于审阅。 */
    excerpt: string;
    reason: string;
    /** 保留或合并后的正文；省略时为空。 */
    markdown: string;
    originalChars: number;
    keptChars: number;
}

export interface DocExtractionConflict {
    type: string;
    detail: string;
    sourcePaths: string[];
}

export type DocExtractionCheckLevel = "error" | "warning" | "info";

export interface DocExtractionCheck {
    level: DocExtractionCheckLevel;
    code: string;
    message: string;
}

export interface DocExtractionStats {
    originalChars: number;
    extractedChars: number;
    compressionRatio: number;
    keptSections: number;
    mergedSections: number;
    omittedSections: number;
    numberTotal: number;
    numberKept: number;
    rubricTotal: number;
    rubricKept: number;
}

export interface DocExtractionResult {
    id: string;
    docFingerprint: string;
    promptVersion: string;
    mode: ExtractionMode;
    edited: boolean;
    originalContent: string;
    originalChars: number;
    extractedChars: number;
    extractedMarkdown: string;
    rationale: string;
    sections: DocExtractionSection[];
    conflicts: DocExtractionConflict[];
    checks: DocExtractionCheck[];
    stats: DocExtractionStats;
    feedback?: string;
    createdAt: string;
}

export interface ChunkExtractionSection {
    title: string;
    level: number;
    path: string;
    status: ExtractionSectionStatus;
    mergedInto?: string;
    markdown: string;
    excerpt: string;
    reason: string;
}

export interface ChunkExtractionResult {
    sections: ChunkExtractionSection[];
}

export type DocExtractionEvent =
    | { type: "progress"; stage: ExtractionStage; current: number; total: number; message: string }
    | { type: "skip"; originalChars: number; message: string }
    | { type: "result"; result: DocExtractionResult }
    | { type: "error"; message: string };

export interface DocExtractionRequestOptions {
    mode: ExtractionMode;
    feedback?: string;
    docFingerprint?: string;
    teacherDocName?: string;
}
