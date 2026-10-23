import type { ParsedFlowConfig, ParsedFlowEdge, ParsedStep } from "./types";

const START_ALIASES = new Set(["start", "script_start", "开始", "起点", "训练开始"]);
const END_ALIASES = new Set(["end", "script_end", "__end__", "task_complete", "结束", "训练结束", "本次实训到此结束"]);
const CHINESE_ORDINALS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

export type ResolvedFlowEndpoint = number | "START" | "END";
export interface ResolvedScriptFlowEdge {
    from: ResolvedFlowEndpoint;
    to: ResolvedFlowEndpoint;
    edge: ParsedFlowEdge;
}

function normalizeEndpoint(value: unknown): string {
    return String(value || "")
        .trim()
        .replace(/^["'“”`]+|["'“”`]+$/g, "")
        .replace(/^第\s*([0-9一二三四五六七八九十]+)\s*阶段/u, "阶段$1")
        .replace(/^stage[_\s-]*(\d+)$/i, "阶段$1")
        .replace(/^step[_\s-]*(\d+)$/i, "阶段$1")
        .replace(/^module[_\s-]*(\d+)$/i, "阶段$1")
        .replace(/\s+/g, "")
        .toLowerCase();
}

function stageKeys(step: ParsedStep, index: number): string[] {
    const number = index + 1;
    const chineseNumber = CHINESE_ORDINALS[number] || String(number);
    const name = String(step.stepName || "").trim();
    return Array.from(new Set([
        `阶段${number}`, `第${number}阶段`, `阶段${chineseNumber}`, `第${chineseNumber}阶段`,
        `stage${number}`, `step${number}`, `module${number}`, `module_${number}`,
        name,
        name.replace(/^阶段\s*[\d一二三四五六七八九十]+[：:、.\-\s]*/u, ""),
    ].map(normalizeEndpoint).filter(Boolean)));
}

function resolveEndpoint(value: unknown, steps: ParsedStep[]): ResolvedFlowEndpoint | null {
    const key = normalizeEndpoint(value);
    if (!key) return null;
    if (START_ALIASES.has(key)) return "START";
    if (END_ALIASES.has(key)) return "END";
    for (let index = 0; index < steps.length; index++) {
        if (stageKeys(steps[index], index).includes(key)) return index;
    }
    return null;
}

/** 注入前解析并核对整张图。任何边丢失都会改变分支，必须报错。 */
export function resolveScriptFlowPlan(flowConfig: ParsedFlowConfig, steps: ParsedStep[]): ResolvedScriptFlowEdge[] {
    if (flowConfig.flowType !== "graph") return [];
    if (!flowConfig.edges.length) {
        throw new Error("剧本声明为非线性流程，但没有解析到任何跳转连线；请检查“非线性跳转关系”的 JSON 区块。");
    }

    const resolved: ResolvedScriptFlowEdge[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    const seenConditions = new Set<string>();
    for (const [index, edge] of flowConfig.edges.entries()) {
        const from = resolveEndpoint(edge.from, steps);
        const to = resolveEndpoint(edge.to, steps);
        const label = `第 ${index + 1} 条（${edge.from} → ${edge.to}）`;
        if (from === null || to === null) {
            errors.push(`${label}找不到对应阶段`);
            continue;
        }
        if (from === "END" || to === "START" || from === to) {
            errors.push(`${label}起止节点无效`);
            continue;
        }
        const key = `${from}|${to}|${edge.condition}`;
        const conditionKey = `${from}|${edge.condition}`;
        if (seen.has(key)) {
            errors.push(`${label}重复`);
            continue;
        }
        if (seenConditions.has(conditionKey)) {
            errors.push(`${label}与同起点另一条连线使用相同跳转条件`);
            continue;
        }
        seen.add(key);
        seenConditions.add(conditionKey);
        resolved.push({ from, to, edge });
    }
    const bySource = new Map<ResolvedFlowEndpoint, ResolvedScriptFlowEdge[]>();
    for (const item of resolved) {
        bySource.set(item.from, [...(bySource.get(item.from) || []), item]);
    }
    for (const [from, outgoing] of bySource) {
        const explicitDefaults = outgoing.filter(({ edge }) => edge.isDefault === 1);
        if (explicitDefaults.length > 1) {
            errors.push(`${from === "START" ? "START" : from === "END" ? "END" : `阶段${from + 1}`}配置了多条默认连线`);
        }
        const fallbackDefault = explicitDefaults.length === 0
            ? outgoing.find(({ edge }) => edge.isDefault === undefined)
            : undefined;
        for (const item of outgoing) {
            item.edge = {
                ...item.edge,
                isDefault: item.edge.isDefault === undefined
                    ? (item === fallbackDefault ? 1 : 0)
                    : item.edge.isDefault,
            };
        }
    }
    if (errors.length) {
        throw new Error(`非线性连线校验失败：${errors.slice(0, 5).join("；")}${errors.length > 5 ? `；另有 ${errors.length - 5} 条` : ""}。已停止注入，避免生成错误的线性流程。`);
    }
    return resolved;
}
