/** Training identity only; platform options are preserved, never generated or overridden. */
export type TrainingType = "ability" | "oral";
export function parseTrainingType(value: unknown): TrainingType {
    return value === "oral" ? "oral" : "ability";
}
export function withOralTrainingContext(document: string, trainingType?: TrainingType): string {
    if (trainingType !== "oral") return document;
    return `${document}\n\n【口语训练生成要求】\n本任务为场景化口语训练，沿用基础版训练剧本的 Markdown 字段和阶段结构。口语训练暂不生成、修改评分标准，评分沿用平台默认配置。\n对话语言与难度依据教师文档中的教学目标和学生水平确定；文档未明确时遵循教学场景，不输出平台语言代码、难度代码或辅助与评价功能开关。平台基础选项保留目标训练原有设置。\n逐阶段检查教师文档是否指定重点词汇或明确列出本阶段要练习的词汇、短语。每个阶段必须在开场白之前独立输出「**重点词汇**:」字段，紧跟 JSON 代码块，结构为 [{"vocabulary":"词汇或短语","explanation":"文档中的释义（没有则留空）","exampleSentence":"例句","source":"教师文档中的对应原文短句"}]；例句优先沿用教师文档；没有例句时可生成贴合本阶段场景的简短例句，但不能将生成例句当作文档依据。该词汇清单是独立配置，不能只埋在提示词里。有明确依据才列出，不得凭空补充，不得把其他阶段词汇串入本阶段；没有依据输出 []，并在阶段描述注明“教师文档未指定本阶段重点词汇”。局部重生成和优化也必须保留或按教师新要求更新本字段。\n设计真实的口语交际任务，以目标语言编写角色开场白、示例表达和对话内容；说明与配置字段名保留中文。提示词明确语言、难度、纠错与引导方式，避免代替学生回答。\n评分要求与任务目标一致；发音、语音等评价仅在有相应音频证据时判定，不得仅凭文字臆测发音表现。\n`;
}
