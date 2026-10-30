/** Internal vocabulary format; platform payload is adapted separately. */
export interface StageVocabulary {
    term: string;
    meaning: string;
    source: string;
    exampleSentence?: string;
}
export function parseStageVocabularies(value: unknown): StageVocabulary[] {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) throw new Error("阶段重点词汇必须是 JSON 数组");
    return parsed.map((item, index) => {
        const term = item?.term ?? item?.vocabulary;
        if (typeof term !== "string" || !term.trim()) throw new Error(`第 ${index + 1} 条重点词汇缺少词汇内容`);
        return { term: term.trim(), meaning: String(item.meaning ?? item.explanation ?? "").trim(), source: String(item.source || "").trim(),
            ...(item.exampleSentence !== undefined ? { exampleSentence: String(item.exampleSentence || "").trim() } : {}) };

    });
}

export interface PlatformVocabulary {
    id: string;
    vocabulary: string;
    explanation: string;
    exampleSentence: string;
}
let lastVocabularyId = 0;
export function toPlatformVocabularies(value: unknown): PlatformVocabulary[] {
    return parseStageVocabularies(value).map(item => {
        lastVocabularyId = Math.max(Date.now(), lastVocabularyId + 1);
        return { id: String(lastVocabularyId), vocabulary: item.term, explanation: item.meaning, exampleSentence: item.exampleSentence || "" };
    });
}
