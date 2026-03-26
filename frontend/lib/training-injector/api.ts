/**
 * 训练配置注入器 - polymas 平台 API 封装
 *
 * 所有请求通过 Next.js API Route (/api/training-inject/proxy) 代理转发
 */

import { PolymasCredentials, PolymasScriptStep, PolymasScriptFlow } from "./types";

const POLYMAS_BASE = "https://cloudapi.polymas.com/teacher-course/abilityTrain";
const POLYMAS_AI_BASE = "https://cloudapi.polymas.com/ai-tools";
const POLYMAS_RESOURCE_BASE = "https://cloudapi.polymas.com/basic-resource";
const POLYMAS_OPENAI_IMAGE_ENDPOINT =
    process.env.POLYMAS_OPENAI_IMAGE_ENDPOINT ||
    "https://llm-service-beta.polymas.com/api/openai/v1/images/generations";
const ARK_IMAGE_ENDPOINT = process.env.ARK_IMAGE_ENDPOINT || "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const ARK_IMAGE_MODEL = process.env.ARK_IMAGE_MODEL || "dall-e-3";
const POLYMAS_IMAGE_FALLBACK_API_KEY =
    process.env.POLYMAS_IMAGE_FALLBACK_API_KEY ||
    "sk-jqzsYB7vjZ6NEdfsP7oZ17Gti45cSMrHSCxQJzq7hz8Coq7h";

type ImageProvider = "cloudapi" | "openai";
const DEFAULT_IMAGE_PROVIDER_PRIORITY: ImageProvider[] = ["cloudapi", "openai"];

const DEFAULT_BG_IMAGE_REQUIREMENT = "专业、清晰、教学场景背景图，严格16:9横版宽屏构图，无任何文字";
const DEFAULT_COVER_STYLE_REQUIREMENT = "专业、简洁、教学场景感，16:9 横版封面，无任何文字";

const IMAGE_GENERATE_TIMEOUT_MS = 25000;
const COVER_GENERATE_TIMEOUT_MS = 60000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 30000;
const IMAGE_UPLOAD_TIMEOUT_MS = 60000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
}

function buildBackgroundFallbackPrompt(params: {
    trainName: string;
    trainDescription: string;
    stageName: string;
    stageDescription: string;
}): string {
    return [
        `训练任务：${params.trainName}`,
        `任务描述：${params.trainDescription}`,
        `阶段：${params.stageName}`,
        `阶段描述：${params.stageDescription}`,
        `要求：${DEFAULT_BG_IMAGE_REQUIREMENT}`,
    ].join("\n");
}

function buildCoverFallbackPrompt(params: {
    trainName: string;
    trainDescription: string;
    coverStylePrompt?: string;
}): string {
    return [
        `课程名称：${params.trainName}`,
        `课程简介：${params.trainDescription}`,
        `封面风格要求：${params.coverStylePrompt || DEFAULT_COVER_STYLE_REQUIREMENT}`,
    ].join("\n");
}

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

function extractImageUrlFromData(data: any): string | null {
    if (!data || typeof data !== "object") return null;
    return (
        data.ossUrl ||
        data.fileUrl ||
        data.imageUrl ||
        data.url ||
        null
    );
}

function normalizeApiKey(raw?: string): string {
    const value = String(raw || "").trim().replace(/^['"]|['"]$/g, "");
    if (!value) return "";
    return value.replace(/^Bearer\s+/i, "").trim();
}

function deriveImageEndpointFromLlmApiUrl(llmApiUrl?: string): string | undefined {
    const url = String(llmApiUrl || "").trim();
    if (!url) return undefined;
    return url.replace(/\/chat\/completions\/?$/i, "/images/generations");
}

function normalizeEndpoint(url?: string): string {
    const raw = String(url || "").trim();
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw)) return raw;
    return `https://${raw.replace(/^\/\//, "")}`;
}

function extractGeneratedImageFileUrl(result: any): string | null {
    const first = Array.isArray(result?.data) ? result.data[0] : result?.data;
    const url = first?.url || first?.imageUrl || result?.url;
    if (typeof url === "string" && url.trim()) return url.trim();

    const b64 = first?.b64_json || first?.b64 || result?.b64_json;
    if (typeof b64 === "string" && b64.trim()) {
        const trimmed = b64.trim();
        return trimmed.startsWith("data:")
            ? trimmed
            : `data:image/png;base64,${trimmed}`;
    }

    return null;
}

function parseImageProviderPriority(input?: string | ImageProvider[]): ImageProvider[] {
    if (Array.isArray(input)) {
        const normalized = input
            .map((item) => String(item || "").trim().toLowerCase())
            .map((item) => {
                if (["cloudapi", "cloud", "polymas"].includes(item)) return "cloudapi" as const;
                if (["openai", "ark", "openai-compatible"].includes(item)) return "openai" as const;
                return null;
            })
            .filter(Boolean) as ImageProvider[];
        return normalized;
    }

    const text = String(input || "").trim();
    if (!text) return [];
    const normalized = text
        .split(/[,|>\s]+/)
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
        .map((item) => {
            if (["cloudapi", "cloud", "polymas"].includes(item)) return "cloudapi" as const;
            if (["openai", "ark", "openai-compatible"].includes(item)) return "openai" as const;
            return null;
        })
        .filter(Boolean) as ImageProvider[];
    return normalized;
}

function resolveImageProviderPriority(customPriority?: string | ImageProvider[]): ImageProvider[] {
    const envPriority = parseImageProviderPriority(process.env.POLYMAS_IMAGE_PROVIDER_PRIORITY);
    const customParsed = parseImageProviderPriority(customPriority);
    const base = customParsed.length > 0 ? customParsed : (envPriority.length > 0 ? envPriority : DEFAULT_IMAGE_PROVIDER_PRIORITY);
    const merged = [...base];
    for (const provider of DEFAULT_IMAGE_PROVIDER_PRIORITY) {
        if (!merged.includes(provider)) merged.push(provider);
    }
    return merged;
}

async function generateImageViaArk(
    prompt: string,
    options?: { apiKey?: string; secondaryApiKey?: string; endpoint?: string; cookie?: string; imageModel?: string; timeoutMs?: number }
): Promise<{ fileUrl: string } | null> {
    const preferredApiKey = normalizeApiKey(options?.apiKey || process.env.ARK_API_KEY);
    const secondaryApiKey = normalizeApiKey(options?.secondaryApiKey || POLYMAS_IMAGE_FALLBACK_API_KEY);
    const apiKeys = [preferredApiKey, secondaryApiKey].filter(Boolean).filter((k, i, arr) => arr.indexOf(k) === i);

    if (apiKeys.length === 0) {
        console.warn("[ark-image] 未配置 ARK_API_KEY，跳过方舟生图兜底");
        return null;
    }

    const requestTimeoutMs = Number(options?.timeoutMs) > 0
        ? Number(options?.timeoutMs)
        : IMAGE_GENERATE_TIMEOUT_MS;

    const endpointCandidates = [
        normalizeEndpoint(options?.endpoint),
        normalizeEndpoint(POLYMAS_OPENAI_IMAGE_ENDPOINT),
        normalizeEndpoint(ARK_IMAGE_ENDPOINT),
    ]
        .filter(Boolean)
        .filter((endpoint, index, arr) => arr.indexOf(endpoint) === index);

    for (const endpoint of endpointCandidates) {
        for (const apiKey of apiKeys) {
            const authHeaderStrategies: Array<Record<string, string>> = [
                { "api-key": apiKey },
                { Authorization: `Bearer ${apiKey}` },
                { "api-key": apiKey, Authorization: `Bearer ${apiKey}` },
            ];

            const selectedModel = options?.imageModel || ARK_IMAGE_MODEL;
            const isDalleModel = /^dall-e/i.test(selectedModel);
            const requestBody = isDalleModel
                ? {
                    model: selectedModel,
                    prompt,
                    n: 1,
                    size: "1792x1024",
                    quality: "standard",
                }
                : {
                    model: selectedModel,
                    prompt,
                    watermark: true,
                };

            for (const authHeaders of authHeaderStrategies) {
            try {
                const headers: Record<string, string> = {
                    "Content-Type": "application/json",
                    ...authHeaders,
                };
                if (options?.cookie?.trim()) {
                    headers.Cookie = options.cookie.trim();
                }

                    const res = await fetchWithTimeout(endpoint, {
                        method: "POST",
                        headers,
                        body: JSON.stringify(requestBody),
                    }, requestTimeoutMs);

                    if (!res.ok) {
                        const txt = await res.text().catch(() => "");
                        console.error("[ark-image] 接口请求失败:", endpoint, res.status, txt.substring(0, 300));
                        continue;
                    }

                    const result = await res.json();
                    const fileUrl = extractGeneratedImageFileUrl(result);
                    if (fileUrl) {
                        return { fileUrl };
                    }

                    console.error("[ark-image] 返回数据缺少可用图片字段(url/b64_json):", endpoint, JSON.stringify(result).substring(0, 300));
                    continue;
            } catch (err) {
                console.error("[ark-image] 请求异常:", endpoint, err);
                continue;
            }
            }
        }
    }

    return null;
}

function inferImageFileName(imageUrl: string, mimeType: string): string {
    try {
        const url = new URL(imageUrl);
        const pathName = url.pathname || "";
        const lastSeg = pathName.split("/").filter(Boolean).pop() || "";
        if (lastSeg && /\.[a-zA-Z0-9]+$/.test(lastSeg)) return lastSeg;
    } catch {
        // ignore
    }

    const extByMime: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
    };
    const ext = extByMime[mimeType.toLowerCase()] || "png";
    return `course-cover.${ext}`;
}

/** 为训练阶段生成背景图 */
export async function generateBackgroundImage(
    params: {
        trainName: string;
        trainDescription: string;
        stageName: string;
        stageDescription: string;
        arkApiKey?: string;
        llmApiUrl?: string;
        imageModel?: string;
        imageProviderPriority?: string | ImageProvider[];
    },
    credentials: PolymasCredentials
): Promise<BgImageResult | null> {
    const targetUrl = `${POLYMAS_AI_BASE}/image/generate`;
    const preferredPrompt = buildBackgroundFallbackPrompt(params);
    const providerPriority = resolveImageProviderPriority(params.imageProviderPriority);

    try {
        for (const provider of providerPriority) {
            if (provider === "cloudapi") {
                const res = await fetchWithTimeout(targetUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json; charset=utf-8",
                        Authorization: credentials.authorization,
                        Cookie: credentials.cookie,
                        "User-Agent":
                            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
                    },
                    body: JSON.stringify({
                        trainName: params.trainName,
                        trainDescription: params.trainDescription,
                        stageName: params.stageName,
                        stageDescription: params.stageDescription,
                    }),
                }, IMAGE_GENERATE_TIMEOUT_MS);

                if (res.ok) {
                    const result = await res.json();
                    if (result.code === 200 || result.success === true) {
                        const data = result.data;
                        if (data?.fileId && data?.ossUrl) {
                            return { fileId: data.fileId, fileUrl: data.ossUrl };
                        }
                        console.log("[bg-image] cloudapi 成功但返回格式不可用:", JSON.stringify(data).substring(0, 300));
                    } else {
                        console.error("[bg-image] cloudapi 返回非成功:", JSON.stringify(result).substring(0, 300));
                    }
                } else {
                    console.error("[bg-image] cloudapi 请求失败:", res.status, res.statusText);
                }
                continue;
            }

            const preferredGenerated = await generateImageViaArk(preferredPrompt, {
                apiKey: params.arkApiKey,
                secondaryApiKey: POLYMAS_IMAGE_FALLBACK_API_KEY,
                endpoint: deriveImageEndpointFromLlmApiUrl(params.llmApiUrl),
                cookie: credentials.cookie,
                imageModel: params.imageModel,
                timeoutMs: IMAGE_GENERATE_TIMEOUT_MS,
            });

            if (preferredGenerated?.fileUrl) {
                const uploadedPreferred = await uploadCoverImageFromUrl(preferredGenerated.fileUrl, credentials);
                if (uploadedPreferred) {
                    return uploadedPreferred;
                }
                console.error("[bg-image] openai 生成成功但上传失败，继续下一个提供方");
            }
        }

        return null;
    } catch (err) {
        console.error("[bg-image] 请求异常:", err);
        return null;
    }
}

/** 为训练任务生成课程封面图源（仅获取图片URL，不直接写入任务封面） */
export async function generateCourseCoverImageSource(
    params: {
        trainName: string;
        trainDescription: string;
        coverStylePrompt?: string;
        arkApiKey?: string;
        llmApiUrl?: string;
        imageModel?: string;
        imageProviderPriority?: string | ImageProvider[];
    },
    credentials: PolymasCredentials
): Promise<{ fileUrl: string } | null> {
    const targetUrl = `${POLYMAS_AI_BASE}/image/generate`;
    const preferredPrompt = buildCoverFallbackPrompt(params);
    const providerPriority = resolveImageProviderPriority(params.imageProviderPriority);

    try {
        for (const provider of providerPriority) {
            if (provider === "cloudapi") {
                const res = await fetchWithTimeout(targetUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json; charset=utf-8",
                        Authorization: credentials.authorization,
                        Cookie: credentials.cookie,
                        "User-Agent":
                            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
                    },
                    body: JSON.stringify({
                        trainName: params.trainName,
                        trainDescription: params.trainDescription,
                        stageName: `${params.trainName} 课程封面`,
                        stageDescription: params.coverStylePrompt
                            ? `${params.trainDescription}\n封面风格要求：${params.coverStylePrompt}`
                            : params.trainDescription,
                    }),
                }, COVER_GENERATE_TIMEOUT_MS);

                if (res.ok) {
                    const result = await res.json();
                    if (result.code === 200 || result.success === true) {
                        const fileUrl = extractImageUrlFromData(result.data);
                        if (fileUrl) {
                            return { fileUrl };
                        }
                        console.error("[course-cover] cloudapi 返回成功但无可用URL:", JSON.stringify(result.data).substring(0, 300));
                    } else {
                        console.error("[course-cover] cloudapi 返回非成功:", JSON.stringify(result).substring(0, 300));
                    }
                } else {
                    console.error("[course-cover] cloudapi 请求失败:", res.status, res.statusText);
                }
                continue;
            }

            const preferredGenerated = await generateImageViaArk(preferredPrompt, {
                apiKey: params.arkApiKey,
                secondaryApiKey: POLYMAS_IMAGE_FALLBACK_API_KEY,
                endpoint: deriveImageEndpointFromLlmApiUrl(params.llmApiUrl),
                cookie: credentials.cookie,
                imageModel: params.imageModel,
                timeoutMs: COVER_GENERATE_TIMEOUT_MS,
            });

            if (preferredGenerated?.fileUrl) {
                return preferredGenerated;
            }
        }

        return null;
    } catch (err) {
        console.error("[course-cover] 生成异常:", err);
        return null;
    }
}

/** 将封面图URL下载后，通过平台上传接口上传，返回可用于 trainTaskCover 的 fileId/fileUrl */
export async function uploadCoverImageFromUrl(
    imageUrl: string,
    credentials: PolymasCredentials
): Promise<BgImageResult | null> {
    const downloadHeadersWithAuth: HeadersInit = {
        Authorization: credentials.authorization,
        Cookie: credentials.cookie,
        "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    };
    const downloadHeadersWithoutAuth: HeadersInit = {
        "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    };

    try {
        let hostname = "";
        try {
            hostname = new URL(imageUrl).hostname.toLowerCase();
        } catch {
            hostname = "";
        }

        const shouldUseAuthFirst =
            hostname.endsWith("polymas.com") ||
            hostname.includes("cloudapi");

        let imgRes = await fetchWithTimeout(imageUrl, {
            method: "GET",
            headers: shouldUseAuthFirst
                ? downloadHeadersWithAuth
                : downloadHeadersWithoutAuth,
        }, IMAGE_DOWNLOAD_TIMEOUT_MS);

        if (
            !imgRes.ok &&
            shouldUseAuthFirst &&
            [400, 401, 403].includes(imgRes.status)
        ) {
            imgRes = await fetchWithTimeout(imageUrl, {
                method: "GET",
                headers: downloadHeadersWithoutAuth,
            }, IMAGE_DOWNLOAD_TIMEOUT_MS);
        }

        if (!imgRes.ok) {
            console.error("[course-cover] 下载图片失败:", imgRes.status, imgRes.statusText);
            return null;
        }

        const mimeType = imgRes.headers.get("content-type") || "image/png";
        const arrayBuffer = await imgRes.arrayBuffer();
        const fileSize = arrayBuffer.byteLength;
        if (!fileSize) {
            console.error("[course-cover] 下载图片为空");
            return null;
        }

        const fileName = inferImageFileName(imageUrl, mimeType);
        const identifyCode = crypto.randomUUID();

        const formData = new FormData();
        formData.append("identifyCode", identifyCode);
        formData.append("name", fileName);
        formData.append("chunk", "0");
        formData.append("chunks", "1");
        formData.append("size", String(fileSize));
        formData.append("file", new Blob([arrayBuffer], { type: mimeType }), fileName);

        const uploadRes = await fetchWithTimeout(`${POLYMAS_RESOURCE_BASE}/file/upload`, {
            method: "POST",
            headers: {
                Authorization: credentials.authorization,
                Cookie: credentials.cookie,
                "User-Agent":
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
            },
            body: formData,
        }, IMAGE_UPLOAD_TIMEOUT_MS);

        if (!uploadRes.ok) {
            console.error("[course-cover] 上传失败:", uploadRes.status, uploadRes.statusText);
            return null;
        }

        const uploadJson = await uploadRes.json();
        if (!(uploadJson.code === 200 || uploadJson.success === true)) {
            console.error("[course-cover] 上传接口返回失败:", JSON.stringify(uploadJson).substring(0, 300));
            return null;
        }

        const data = uploadJson.data || {};
        const fileId = data.fileId;
        const fileUrl = data.ossUrl || data.fileUrl;
        if (!fileId || !fileUrl) {
            console.error("[course-cover] 上传成功但缺少 fileId/fileUrl:", JSON.stringify(uploadJson).substring(0, 300));
            return null;
        }

        return { fileId, fileUrl };
    } catch (err) {
        console.error("[course-cover] 上传异常:", err);
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
                modelId: stepData.modelId || "Doubao-Seed-2.0-pro",
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
                modelId: stepData.modelId || "Doubao-Seed-2.0-pro",
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
            transitionHistoryNum: -1,
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
): Promise<{ itemId: string | null; error?: string }> {
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
    if (result.success) {
        return { itemId: result.data?.itemId || "ok" };
    }
    console.error(`[createScoreItem] 失败 - ${item.itemName}:`, result.error);
    return { itemId: null, error: result.error };
}

// ─── 基础配置接口 ───────────────────────────────────────────────────

/** 修改训练任务基础配置（任务名称、描述等） */
export async function editConfiguration(
    params: {
        trainTaskId: string;
        courseId: string;
        trainTaskName: string;
        description: string;
        trainTaskCover?: BgImageResult | null;
    },
    credentials: PolymasCredentials
): Promise<boolean> {
    const payload: Record<string, unknown> = {
        trainTaskId: params.trainTaskId,
        courseId: params.courseId,
        trainTaskName: params.trainTaskName,
        description: params.description,
        trainType: "voice",
        trainTime: 10,
    };

    if (params.trainTaskCover?.fileId) {
        payload.trainTaskCover = params.trainTaskCover;
    }

    const result = await directRequest(
        "editConfiguration",
        payload,
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
        let courseId =
            url.searchParams.get("businessId") ||
            url.searchParams.get("courseId") ||
            "";
        // 从 URL 路径提取 courseId：/agent-course-full/{courseId}/
        if (!courseId) {
            const pathMatch = url.pathname.match(/\/agent-course-full\/([^/]+)/);
            if (pathMatch) courseId = pathMatch[1];
        }
        const libraryFolderId =
            url.searchParams.get("libraryId") ||
            url.searchParams.get("libraryFolderId") ||
            "";

        if (!trainTaskId) return null;
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
