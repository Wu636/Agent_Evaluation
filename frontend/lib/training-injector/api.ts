/**
 * 训练配置注入器 - polymas 平台 API 封装
 *
 * 所有请求通过 Next.js API Route (/api/training-inject/proxy) 代理转发
 */

import { PolymasCredentials, PolymasScriptStep, PolymasScriptFlow } from "./types";

const POLYMAS_BASE = "https://cloudapi.polymas.com/teacher-course/abilityTrain";
const POLYMAS_AI_BASE = "https://cloudapi.polymas.com/ai-tools";
const POLYMAS_RESOURCE_BASE = "https://cloudapi.polymas.com/basic-resource";
const POLYMAS_COMPAT_IMAGE_ENDPOINT =
    process.env.POLYMAS_COMPAT_IMAGE_ENDPOINT ||
    process.env.POLYMAS_OPENAI_IMAGE_ENDPOINT ||
    "https://llm-service-beta.polymas.com/api/openai/v1/images/generations";
const POLYMAS_DALLE_IMAGE_ENDPOINT =
    process.env.POLYMAS_DALLE_IMAGE_ENDPOINT ||
    "https://llm-service.polymas.com/api/openai/v1/images/generations";
const ARK_IMAGE_ENDPOINT = process.env.ARK_IMAGE_ENDPOINT || "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const ARK_IMAGE_MODEL = process.env.ARK_IMAGE_MODEL || "doubao-seedream-4-0-250828";
const POLYMAS_IMAGE_FALLBACK_API_KEY =
    process.env.POLYMAS_IMAGE_FALLBACK_API_KEY ||
    "sk-jqzsYB7vjZ6NEdfsP7oZ17Gti45cSMrHSCxQJzq7hz8Coq7h";

type ImageProvider = "cloudapi" | "openai";
const DEFAULT_IMAGE_PROVIDER_PRIORITY: ImageProvider[] = ["cloudapi", "openai"];

const DEFAULT_BG_IMAGE_REQUIREMENT = "专业写实教学场景背景图，严格16:9横版宽屏构图，单一完整场景，画面干净稳定，适合作为课程阶段背景；禁止拼贴、多宫格、海报排版、极端透视、鱼眼、抽象艺术、卡通漫画；无任何文字、英文单词、logo、字幕、水印，中国视觉风格优先";
const DEFAULT_COVER_STYLE_REQUIREMENT = "专业、简洁、写实的课程封面图，严格16:9横版宽屏构图，主体明确、构图完整、画面克制；禁止拼贴、多宫格、海报排版、卡通漫画、抽象风格；无任何文字、英文单词、logo、水印，中国风格优先";
const DEFAULT_SEEDREAM_4_IMAGE_SIZE = "1792x1024";
const CLOUDAPI_PROBE_PAYLOAD = {
    trainName: "生图连通性测试",
    trainDescription: "用于检测当前平台凭证下 cloudapi 生图接口是否可用",
    stageName: "接口预检查",
    stageDescription: "生成一张专业、简洁、16:9 横版教学场景背景图，无任何文字和英文单词",
};

const IMAGE_GENERATE_TIMEOUT_MS = 25000;
const COVER_GENERATE_TIMEOUT_MS = 60000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 90000;
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
    backgroundStylePrompt?: string;
}): string {
    return [
        `训练任务：${params.trainName}`,
        `任务描述：${params.trainDescription}`,
        `阶段：${params.stageName}`,
        `阶段描述：${params.stageDescription}`,
        ...(params.backgroundStylePrompt ? [`背景风格要求：${params.backgroundStylePrompt}`] : []),
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

export interface ProviderProbeResult {
    ok: boolean;
    error?: string;
    fileId?: string;
    fileUrl?: string;
}

async function requestCloudapiImageGeneration(
    payload: {
        trainName: string;
        trainDescription: string;
        stageName: string;
        stageDescription: string;
    },
    credentials: PolymasCredentials,
    timeoutMs: number
): Promise<ProviderProbeResult> {
    try {
        const res = await fetchWithTimeout(`${POLYMAS_AI_BASE}/image/generate`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                Authorization: credentials.authorization,
                Cookie: credentials.cookie,
                "User-Agent":
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
            },
            body: JSON.stringify(payload),
        }, timeoutMs);

        if (!res.ok) {
            const rawText = await res.text().catch(() => "");
            return {
                ok: false,
                error: `cloudapi 请求失败: ${res.status} ${res.statusText}${rawText ? ` - ${rawText.substring(0, 160)}` : ""}`,
            };
        }

        const result = await res.json();
        if (result.code === 200 || result.success === true) {
            const fileUrl = extractImageUrlFromData(result.data);
            const fileId = typeof result?.data?.fileId === "string" ? result.data.fileId : "";
            if (fileUrl) {
                return {
                    ok: true,
                    fileId: fileId || undefined,
                    fileUrl,
                };
            }
            return {
                ok: false,
                error: "cloudapi 返回成功，但缺少可用图片地址",
            };
        }

        return {
            ok: false,
            error: String(result?.msg || result?.message || result?.error || "cloudapi 生图失败"),
        };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : "cloudapi 生图探测失败",
        };
    }
}

export async function probeCloudapiImageGeneration(credentials: PolymasCredentials): Promise<ProviderProbeResult> {
    return requestCloudapiImageGeneration(CLOUDAPI_PROBE_PAYLOAD, credentials, IMAGE_GENERATE_TIMEOUT_MS);
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

function isDalleImageModel(model?: string): boolean {
    return /^dall-e/i.test(String(model || "").trim());
}

function isSeedream4ImageModel(model?: string): boolean {
    return /^doubao-seedream-4/i.test(String(model || "").trim());
}

function buildImageEndpointCandidates(selectedModel: string, preferredEndpoint?: string): string[] {
    const preferred = normalizeEndpoint(preferredEndpoint);
    const candidates = isDalleImageModel(selectedModel)
        ? [
            preferred,
            normalizeEndpoint(POLYMAS_DALLE_IMAGE_ENDPOINT),
        ]
        : [
            preferred,
            normalizeEndpoint(POLYMAS_COMPAT_IMAGE_ENDPOINT),
            normalizeEndpoint(ARK_IMAGE_ENDPOINT),
        ];

    return candidates
        .filter(Boolean)
        .filter((endpoint, index, arr) => arr.indexOf(endpoint) === index);
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
    if (customParsed.length > 0) {
        return customParsed;
    }
    if (envPriority.length > 0) {
        return envPriority;
    }
    return DEFAULT_IMAGE_PROVIDER_PRIORITY;
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

    const selectedModel = options?.imageModel || ARK_IMAGE_MODEL;
    const endpointCandidates = buildImageEndpointCandidates(selectedModel, options?.endpoint);

    for (const endpoint of endpointCandidates) {
        for (const apiKey of apiKeys) {
            const authHeaderStrategies: Array<Record<string, string>> = [
                { "api-key": apiKey },
                { Authorization: `Bearer ${apiKey}` },
                { "api-key": apiKey, Authorization: `Bearer ${apiKey}` },
            ];

            const isDalleModel = isDalleImageModel(selectedModel);
            const isSeedream4Model = isSeedream4ImageModel(selectedModel);
            const requestBody = isDalleModel
                ? {
                    model: selectedModel,
                    prompt,
                    n: 1,
                    size: "1792x1024",
                    quality: "standard",
                }
                : isSeedream4Model
                    ? {
                        model: selectedModel,
                        prompt,
                        size: DEFAULT_SEEDREAM_4_IMAGE_SIZE,
                        response_format: "url",
                        sequential_image_generation: "disabled",
                        watermark: true,
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
        backgroundStylePrompt?: string;
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
                        stageDescription: params.backgroundStylePrompt
                            ? `${params.stageDescription}\n背景风格要求：${params.backgroundStylePrompt}`
                            : params.stageDescription,
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
): Promise<{ fileUrl: string; fileId?: string } | null> {
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
                        const fileId = result?.data?.fileId;
                        if (fileUrl) {
                            return {
                                fileUrl,
                                fileId: typeof fileId === "string" && fileId.trim() ? fileId : undefined,
                            };
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
