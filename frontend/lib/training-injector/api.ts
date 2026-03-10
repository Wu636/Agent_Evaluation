/**
 * 训练配置注入器 - polymas 平台 API 封装
 *
 * 所有请求通过 Next.js API Route (/api/training-inject/proxy) 代理转发
 */

import { PolymasCredentials, PolymasScriptStep, PolymasScriptFlow } from "./types";

const POLYMAS_BASE = "https://cloudapi.polymas.com/teacher-course/abilityTrain";
const POLYMAS_AI_BASE = "https://cloudapi.polymas.com/ai-tools";

/**
 * 直接请求 polymas API（此模块仅在 Next.js 服务端 route.ts 中调用，
 * 无 CORS 问题，不需要走 /api/training-inject/proxy 代理）
 */
async function directRequest<T = unknown>(
    apiPath: string,
    payload: Record<string, unknown>,
    credentials: PolymasCredentials
): Promise<{ success: boolean; data?: T; error?: string }> {
    const targetUrl = `${POLYMAS_BASE}/${apiPath}`;

    const res = await fetch(targetUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            Authorization: credentials.authorization,
            Cookie: credentials.cookie,
            "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        },
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        return { success: false, error: `polymas API 请求失败: ${res.status} ${res.statusText}` };
    }

    const result = await res.json();
    if (result.code === 200 || result.success === true) {
        return { success: true, data: result.data };
    }
    return { success: false, error: JSON.stringify(result) };
}

// ─── AI 工具接口 ────────────────────────────────────────────────────

/** 背景图生成结果 */
export interface BgImageResult {
    fileId: string;
    fileUrl: string;
}

/** 为训练阶段生成背景图 */
export async function generateBackgroundImage(
    params: {
        trainName: string;
        trainDescription: string;
        stageName: string;
        stageDescription: string;
    },
    credentials: PolymasCredentials
): Promise<BgImageResult | null> {
    const targetUrl = `${POLYMAS_AI_BASE}/image/generate`;

    try {
        const res = await fetch(targetUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                Authorization: credentials.authorization,
                Cookie: credentials.cookie,
                "User-Agent":
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
            },
            body: JSON.stringify(params),
        });

        if (!res.ok) {
            console.error("[bg-image] API 请求失败:", res.status);
            return null;
        }

        const result = await res.json();
        console.log("[bg-image] Full API response:", JSON.stringify(result).substring(0, 500));
        if (result.code === 200 || result.success === true) {
            const data = result.data;
            if (data?.fileId && data?.ossUrl) {
                return { fileId: data.fileId, fileUrl: data.ossUrl };
            }
            console.log("[bg-image] 无法识别 data 格式:", JSON.stringify(data).substring(0, 300));
            return null;
        }
        console.error("[bg-image] API 返回非成功状态:", JSON.stringify(result).substring(0, 300));
        return null;
    } catch (err) {
        console.error("[bg-image] 请求异常:", err);
        return null;
    }
}

// ─── 查询接口 ────────────────────────────────────────────────────────

/** 查询现有脚本节点 */
export async function queryScriptSteps(
    trainTaskId: string,
    credentials: PolymasCredentials
): Promise<PolymasScriptStep[]> {
    const result = await directRequest<PolymasScriptStep[]>(
        "queryScriptStepList",
        { trainTaskId, trainSubType: "ability" },
        credentials
    );
    return result.success ? (result.data || []) : [];
}

/** 查询现有连线 */
export async function queryScriptFlows(
    trainTaskId: string,
    credentials: PolymasCredentials
): Promise<PolymasScriptFlow[]> {
    const result = await directRequest<PolymasScriptFlow[]>(
        "queryScriptStepFlowList",
        { trainTaskId },
        credentials
    );
    return result.success ? (result.data || []) : [];
}

// ─── 创建接口 ────────────────────────────────────────────────────────

/** 生成 nanoid 风格的随机 ID（21位） */
function generateId(size = 21): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    let id = "";
    const bytes = new Uint8Array(size);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < size; i++) {
        id += chars[bytes[i] % chars.length];
    }
    return id;
}

/** 创建脚本节点 */
export async function createScriptStep(
    trainTaskId: string,
    stepData: {
        stepName: string;
        description: string;
        prologue: string;
        modelId: string;
        llmPrompt: string;
        trainerName: string;
        interactiveRounds: number;
        agentId: string;
        avatarNid: string;
        scriptStepCover: Record<string, string>;
        backgroundTheme?: string | null;
    },
    position: { x: number; y: number },
    credentials: PolymasCredentials
): Promise<string | null> {
    const stepId = generateId();

    const result = await directRequest(
        "createScriptStep",
        {
            trainTaskId,
            stepId,
            stepDetailDTO: {
                nodeType: "SCRIPT_NODE",
                stepName: stepData.stepName,
                description: stepData.description,
                prologue: stepData.prologue,
                modelId: stepData.modelId || "Doubao-Seed-1.6",
                llmPrompt: stepData.llmPrompt,
                trainerName: stepData.trainerName,
                interactiveRounds: stepData.interactiveRounds,
                scriptStepCover: stepData.scriptStepCover || {},
                backgroundTheme: stepData.backgroundTheme || null,
                whiteBoardSwitch: 0,
                agentId: stepData.agentId || "Tg3LpKo28D",
                avatarNid: stepData.avatarNid || "hnuOVqMu8b",
                videoSwitch: 0,
                scriptStepResourceList: [],
                knowledgeBaseSwitch: 1,
                searchEngineSwitch: 1,
                historyRecordNum: -1,
                trainSubType: "ability",
            },
            positionDTO: position,
        },
        credentials
    );

    if (!result.success) {
        console.error("[createScriptStep] 创建节点失败:", result.error);
        console.error("[createScriptStep] stepName:", stepData.stepName, "| trainTaskId:", trainTaskId);
    }
    return result.success ? stepId : null;
}

/** 更新脚本节点（用于注入背景图等字段） */
export async function editScriptStep(
    trainTaskId: string,
    stepId: string,
    stepData: {
        stepName: string;
        description: string;
        prologue: string;
        modelId: string;
        llmPrompt: string;
        trainerName: string;
        interactiveRounds: number;
        agentId: string;
        avatarNid: string;
        scriptStepCover: Record<string, string>;
        backgroundTheme?: string | null;
    },
    courseId: string,
    libraryFolderId: string,
    position: { x: number; y: number },
    credentials: PolymasCredentials
): Promise<boolean> {
    const result = await directRequest(
        "editScriptStep",
        {
            trainTaskId,
            stepId,
            courseId,
            libraryFolderId,
            stepDetailDTO: {
                nodeType: "SCRIPT_NODE",
                stepName: stepData.stepName,
                description: stepData.description,
                prologue: stepData.prologue,
                modelId: stepData.modelId || "Doubao-Seed-1.6",
                llmPrompt: stepData.llmPrompt,
                trainerName: stepData.trainerName,
                interactiveRounds: stepData.interactiveRounds,
                scriptStepCover: stepData.scriptStepCover || {},
                backgroundTheme: stepData.backgroundTheme || null,
                whiteBoardSwitch: 0,
                agentId: stepData.agentId || "Tg3LpKo28D",
                avatarNid: stepData.avatarNid || "hnuOVqMu8b",
                videoSwitch: 0,
                scriptStepResourceList: [],
                knowledgeBaseSwitch: 1,
                searchEngineSwitch: 1,
                historyRecordNum: -1,
                trainSubType: "ability",
            },
            positionDTO: position,
        },
        credentials
    );

    if (!result.success) {
        console.error("[editScriptStep] 更新节点失败:", result.error);
    } else {
        console.log("[editScriptStep] 更新节点成功: stepId=", stepId, "backgroundTheme=", stepData.backgroundTheme);
    }
    return result.success;
}

/** 创建连线 */
export async function createScriptFlow(
    trainTaskId: string,
    startId: string,
    endId: string,
    conditionText: string,
    transitionPrompt: string,
    credentials: PolymasCredentials
): Promise<boolean> {
    const flowId = generateId();

    const result = await directRequest(
        "createScriptStepFlow",
        {
            trainTaskId,
            flowId,
            scriptStepStartId: startId,
            scriptStepStartHandle: `${startId}-source-bottom`,
            scriptStepEndId: endId,
            scriptStepEndHandle: `${endId}-target-top`,
            flowSettingType: "quick",
            flowCondition: conditionText,
            flowConfiguration: {
                relation: "and",
                conditions: [
                    {
                        text: "条件组1",
                        relation: "and",
                        conditions: [{ text: conditionText }],
                    },
                ],
            },
            transitionPrompt: transitionPrompt,
            transitionHistoryNum: 0,
            isDefault: 1,
            isError: false,
        },
        credentials
    );

    return result.success;
}

// ─── 删除接口 ────────────────────────────────────────────────────────

/** 删除连线 */
export async function deleteScriptFlow(
    trainTaskId: string,
    flowId: string,
    credentials: PolymasCredentials
): Promise<boolean> {
    const result = await directRequest(
        "delScriptStepFlow",
        { trainTaskId, flowId },
        credentials
    );
    return result.success;
}

/** 删除节点 */
export async function deleteScriptStep(
    trainTaskId: string,
    stepId: string,
    credentials: PolymasCredentials
): Promise<boolean> {
    const result = await directRequest(
        "delScriptStep",
        { trainTaskId, stepId },
        credentials
    );
    return result.success;
}

// ─── 评分项接口 ─────────────────────────────────────────────────────

/** 创建评分项 */
export async function createScoreItem(
    trainTaskId: string,
    item: {
        itemName: string;
        score: number;
        description: string;
        requireDetail: string;
    },
    credentials: PolymasCredentials
): Promise<string | null> {
    const result = await directRequest<{ itemId: string }>(
        "createScoreItem",
        {
            trainTaskId,
            itemName: item.itemName,
            score: item.score,
            description: item.description,
            requireDetail: item.requireDetail,
        },
        credentials
    );
    return result.success ? (result.data?.itemId || "ok") : null;
}

// ─── 基础配置接口 ───────────────────────────────────────────────────

/** 修改训练任务基础配置（任务名称、描述等） */
export async function editConfiguration(
    params: {
        trainTaskId: string;
        courseId: string;
        trainTaskName: string;
        description: string;
    },
    credentials: PolymasCredentials
): Promise<boolean> {
    const result = await directRequest(
        "editConfiguration",
        {
            trainTaskId: params.trainTaskId,
            courseId: params.courseId,
            trainTaskName: params.trainTaskName,
            description: params.description,
            trainType: "voice",
            trainTime: 10,
            trainTaskCover: { fileId: "", fileUrl: "" },
        },
        credentials
    );
    return result.success;
}

// ─── URL 解析 ────────────────────────────────────────────────────────

/**
 * 从智慧树平台 URL 中提取 courseId(businessId) 和 trainTaskId。
 *
 * 示例 URL:
 * https://hike-teaching-center.polymas.com/tch-hike/agent-course-full/4Axeg96mLnfj0vwenXaQ/ability-training/create?libraryId=bIFFzOAAoX&businessType=course&businessId=4Axeg96mLnfj0vwenXaQ&trainTaskId=4Axeg4PK85S4v5M17aQV
 */
export function parsePolymasUrl(urlStr: string): {
    courseId: string;
    trainTaskId: string;
    libraryFolderId: string;
} | null {
    try {
        // 支持用户只粘贴了查询参数或完整 URL
        const url = new URL(
            urlStr.startsWith("http") ? urlStr : `https://example.com?${urlStr}`
        );
        const trainTaskId =
            url.searchParams.get("trainTaskId") || "";
        const courseId =
            url.searchParams.get("businessId") ||
            url.searchParams.get("courseId") ||
            "";
        const libraryFolderId =
            url.searchParams.get("libraryId") ||
            url.searchParams.get("libraryFolderId") ||
            "";

        if (!trainTaskId || !courseId) return null;
        return { courseId, trainTaskId, libraryFolderId };
    } catch {
        return null;
    }
}

// ─── 辅助函数 ────────────────────────────────────────────────────────

/** 从节点列表中提取 START/END 节点 ID */
export function extractStartEndIds(steps: PolymasScriptStep[]): {
    startId: string | null;
    endId: string | null;
} {
    let startId: string | null = null;
    let endId: string | null = null;

    for (const step of steps) {
        const nodeType = step.stepDetailDTO?.nodeType;
        if (nodeType === "SCRIPT_START") startId = step.stepId;
        else if (nodeType === "SCRIPT_END") endId = step.stepId;
    }

    return { startId, endId };
}

/** 获取非 START/END 的脚本节点 */
export function getScriptNodes(steps: PolymasScriptStep[]): PolymasScriptStep[] {
    return steps.filter(
        (s) =>
            s.stepDetailDTO?.nodeType !== "SCRIPT_START" &&
            s.stepDetailDTO?.nodeType !== "SCRIPT_END"
    );
}
