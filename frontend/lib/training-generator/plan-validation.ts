import { ScriptModulePlan, ScriptPlanValidationIssue } from "./types";

const MULTI_ROLE_SIGNAL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /同时扮演/, label: "同时扮演" },
    { pattern: /分别扮演/, label: "分别扮演" },
    { pattern: /一人分饰/, label: "一人分饰" },
    { pattern: /多角色/, label: "多角色" },
    { pattern: /多个角色/, label: "多个角色" },
    { pattern: /双重角色/, label: "双重角色" },
    { pattern: /双角色/, label: "双角色" },
    { pattern: /先扮演[\s\S]{0,24}再扮演/, label: "先扮演…再扮演…" },
    { pattern: /既扮演[\s\S]{0,24}又扮演/, label: "既扮演…又扮演…" },
    { pattern: /轮流扮演/, label: "轮流扮演" },
    { pattern: /切换(?:为)?(?:不同)?角色/, label: "切换角色" },
];

function buildExcerpt(text: string, matchText: string, matchIndex: number): string {
    const start = Math.max(0, matchIndex - 8);
    const end = Math.min(text.length, matchIndex + matchText.length + 12);
    return text.slice(start, end).trim();
}

export function detectMultiRoleTextSignal(text: string): { label: string; excerpt: string } | null {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return null;

    for (const { pattern, label } of MULTI_ROLE_SIGNAL_PATTERNS) {
        const match = normalized.match(pattern);
        if (!match || !match[0]) continue;
        const matchIndex = typeof match.index === "number"
            ? match.index
            : normalized.indexOf(match[0]);
        return {
            label,
            excerpt: buildExcerpt(normalized, match[0], Math.max(0, matchIndex)),
        };
    }

    return null;
}

export function findMultiRoleModuleIssue(module: ScriptModulePlan, moduleIndex: number): ScriptPlanValidationIssue | null {
    const fields: Array<{ field: keyof ScriptModulePlan; label: string; text: string }> = [
        { field: "title", label: "模块标题", text: module.title },
        { field: "objective", label: "训练目的", text: module.objective },
        { field: "description", label: "模块说明", text: module.description },
        { field: "interactionStyle", label: "互动方式", text: module.interactionStyle },
    ];

    for (const candidate of fields) {
        const signal = detectMultiRoleTextSignal(candidate.text);
        if (!signal) continue;

        return {
            level: "error",
            message: `模块 ${moduleIndex + 1} 的${candidate.label}出现“${signal.label}”等多角色信号（${signal.excerpt}）。同一模块只允许一个智能体角色；如需不同角色，请拆分为不同模块。`,
            moduleId: module.id,
            field: candidate.field,
        };
    }

    return null;
}
