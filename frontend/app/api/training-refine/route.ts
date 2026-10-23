import { NextRequest, NextResponse } from "next/server";

import {
  generateBackgroundImage,
  generateCourseCoverImageSource,
  parsePolymasUrl,
  queryTrainingTaskConfiguration,
  uploadCoverImageFromUrl,
} from "@/lib/training-injector/api";
import type {
  PolymasCredentials,
  PolymasScriptFlow,
  PolymasScriptStep,
} from "@/lib/training-injector/types";
import {
  buildTrainingGraphSnapshot,
  generateTrainingRefinementPlan,
  RefinerRequestError,
  validateRefinementPlan,
} from "@/lib/training-refiner/engine";
import {
  diagnoseTemplateRewrite,
  rewriteTrainingByTemplate,
} from "@/lib/training-refiner/template-rewriter";
import {
  buildRefinementDryRun,
  injectRefinedTraining,
  queryTrainingScoreItems,
} from "@/lib/training-refiner/injector";
import type {
  TrainingRefineApiResponse,
  TrainingRefineImageAsset,
  TrainingRefineImageAssets,
  TrainingRefineImageOptions,
  TrainingRefineStrategy,
  TrainingTemplateDiagnosis,
  TrainingRefinementPlan,
  TrainingRefineLlmSettings,
} from "@/lib/training-refiner/types";
import { refinementImageContextKey } from "@/lib/training-refiner/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const POLYMAS_BASE = "https://cloudapi.polymas.com/teacher-course/abilityTrain";
const OPTIMIZATION_BUDGET_MS = 285_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

type OptimizationEvent =
  | { type: "progress"; message: string }
  | { type: "result"; result: TrainingRefineApiResponse }
  | { type: "error"; message: string };

type Action =
  | "extract"
  | "optimize"
  | "analyze-template"
  | "rewrite-template"
  | "dry-run"
  | "import"
  | "generate-image";

interface RequestBody {
  action?: Action;
  sourceUrl?: string;
  targetUrl?: string;
  teacherFeedback?: string;
  supplementalContext?: string;
  selectedNodeIds?: string[];
  optimizeScoring?: boolean;
  injectScript?: boolean;
  injectRubric?: boolean;
  injectMode?: "replace" | "append";
  credentials?: PolymasCredentials;
  llmSettings?: TrainingRefineLlmSettings;
  plan?: TrainingRefinementPlan;
  strategy?: TrainingRefineStrategy;
  templateMode?: "auto" | "general" | "sequential" | "roleplay" | "summary";
  templateDiagnosis?: TrainingTemplateDiagnosis;
  templateModulePlan?: import("@/lib/training-generator/types").TrainingScriptPlan;
  rewriteScoring?: boolean;
  confirmImport?: boolean;
  imageOptions?: TrainingRefineImageOptions;
  imageAssets?: TrainingRefineImageAssets;
  imageKind?: "cover" | "background";
  nodeId?: string;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAction(value: unknown): Action {
  if (
    value === "extract" ||
    value === "optimize" ||
    value === "analyze-template" ||
    value === "rewrite-template" ||
    value === "dry-run" ||
    value === "import" ||
    value === "generate-image"
  ) {
    return value;
  }
  return "extract";
}

function requireCredentials(
  credentials?: PolymasCredentials,
): PolymasCredentials {
  const authorization = cleanText(credentials?.authorization);
  const cookie = cleanText(credentials?.cookie);
  if (!authorization || !cookie) {
    throw new Error("请填写平台 Authorization 和 Cookie。");
  }
  return {
    authorization,
    cookie,
    userNid: cleanText(credentials?.userNid) || undefined,
    apiOrigin: cleanText(credentials?.apiOrigin) || undefined,
  };
}

function parseTrainingUrl(value: unknown, label: string) {
  const raw = cleanText(value);
  const parsed = parsePolymasUrl(raw);
  if (!parsed?.trainTaskId) {
    throw new Error(`${label}不是有效的能力训练页面 URL。`);
  }
  return { ...parsed, raw };
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      Boolean(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function isImageSourceUrl(value: unknown): value is string {
  return isHttpUrl(value) ||
    (typeof value === "string" && /^data:image\/[a-z0-9.+-]+;base64,/i.test(value));
}

function imageAsset(
  value: unknown,
  expectedContextKey: string,
): TrainingRefineImageAsset | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<TrainingRefineImageAsset>;
  const fileId = cleanText(raw.fileId);
  const fileUrl = cleanText(raw.fileUrl);
  const contextKey = cleanText(raw.contextKey);
  if (!fileId || !isHttpUrl(fileUrl) || contextKey !== expectedContextKey) {
    return null;
  }
  return { fileId, fileUrl, contextKey };
}

function requireImageOptions(body: RequestBody): TrainingRefineImageOptions {
  const options = body.imageOptions;
  if (!options || typeof options !== "object") {
    throw new Error("图片生成设置缺失，请重新打开注入配置后重试。");
  }
  return {
    generateCover: options.generateCover === true,
    generateBackgrounds: options.generateBackgrounds === true,
    stylePrompt: cleanText(options.stylePrompt),
  };
}

async function generateRefinementImage(
  body: RequestBody,
  credentials: PolymasCredentials,
): Promise<TrainingRefineApiResponse> {
  const plan = body.plan;
  if (!plan || typeof plan !== "object") {
    throw new Error("请先生成并确认 AI 优化方案。");
  }
  const options = requireImageOptions(body);
  const kind = body.imageKind;
  const imageModel = cleanText(body.llmSettings?.imageModel);
  if (!imageModel) {
    throw new Error("请先在 AgentEval 设置中配置图片模型。");
  }
  if (kind !== "cover" && kind !== "background") {
    throw new Error("图片类型无效，请重新点击生成图片。");
  }

  if (kind === "cover") {
    if (body.injectScript === false || body.injectMode === "append") {
      throw new Error("当前注入模式不生成新封面。");
    }
    if (!options.generateCover) {
      throw new Error("当前设置已关闭新封面生成。");
    }
    const contextKey = refinementImageContextKey(
      plan,
      "cover",
      undefined,
      options.stylePrompt,
      imageModel,
    );
    const generated = await generateCourseCoverImageSource(
      {
        trainName: plan.taskName,
        trainDescription: plan.description,
        coverStylePrompt: options.stylePrompt,
        arkApiKey: cleanText(body.llmSettings?.apiKey),
        llmApiUrl: cleanText(body.llmSettings?.apiUrl),
        imageModel,
      },
      credentials,
    );
    if (!generated?.fileUrl || !isImageSourceUrl(generated.fileUrl)) {
      throw new Error("新封面生成失败：图片服务没有返回可用地址。");
    }
    const uploaded = generated.fileId
      ? { fileId: generated.fileId, fileUrl: generated.fileUrl }
      : await uploadCoverImageFromUrl(generated.fileUrl, credentials);
    if (!uploaded?.fileId || !isHttpUrl(uploaded.fileUrl)) {
      throw new Error("新封面生成成功，但上传到平台失败。");
    }
    return {
      ok: true,
      action: "generate-image",
      imageKind: "cover",
      image: {
        fileId: cleanText(uploaded.fileId),
        fileUrl: cleanText(uploaded.fileUrl),
        contextKey,
      },
    };
  }

  if (body.injectScript === false || !options.generateBackgrounds) {
    throw new Error("当前设置未开启新背景生成。");
  }
  const nodeId = cleanText(body.nodeId);
  const node = plan.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error("未找到要生成背景的优化卡片。");
  const contextKey = refinementImageContextKey(
    plan,
    "background",
    node.id,
    options.stylePrompt,
    imageModel,
  );
  const generated = await generateBackgroundImage(
    {
      trainName: plan.taskName,
      trainDescription: plan.description,
      stageName: node.stepName,
      stageDescription: node.description,
      backgroundStylePrompt: options.stylePrompt,
      arkApiKey: cleanText(body.llmSettings?.apiKey),
      llmApiUrl: cleanText(body.llmSettings?.apiUrl),
      imageModel,
    },
    credentials,
  );
  if (!generated?.fileId || !isHttpUrl(generated.fileUrl)) {
    throw new Error(`卡片“${node.stepName}”的新背景生成或上传失败。`);
  }
  return {
    ok: true,
    action: "generate-image",
    imageKind: "background",
    nodeId: node.id,
    image: {
      fileId: cleanText(generated.fileId),
      fileUrl: cleanText(generated.fileUrl),
      contextKey,
    },
  };
}

function validateImportImages(
  body: RequestBody,
  plan: TrainingRefinementPlan,
  injectScript: boolean,
  injectMode: "replace" | "append",
): {
  replaceSourceImages: boolean;
  coverImage?: TrainingRefineImageAsset;
  backgroundImages?: Record<string, TrainingRefineImageAsset>;
} {
  // 未携带 imageOptions 视为旧调用方，沿用原有的源配置继承行为。
  if (!injectScript || !body.imageOptions) {
    return { replaceSourceImages: false };
  }
  const options = requireImageOptions(body);
  const needsCover = options.generateCover && injectMode === "replace";
  const needsBackgrounds = options.generateBackgrounds;
  if (!needsCover && !needsBackgrounds) {
    return { replaceSourceImages: true, backgroundImages: {} };
  }
  const imageModel = cleanText(body.llmSettings?.imageModel);
  if (!imageModel) throw new Error("图片模型设置缺失，请刷新设置后重试。");
  const assets = body.imageAssets;
  const result: {
    replaceSourceImages: boolean;
    coverImage?: TrainingRefineImageAsset;
    backgroundImages?: Record<string, TrainingRefineImageAsset>;
  } = { replaceSourceImages: true };

  if (needsCover) {
    const contextKey = refinementImageContextKey(
      plan,
      "cover",
      undefined,
      options.stylePrompt,
      imageModel,
    );
    const cover = imageAsset(assets?.cover, contextKey);
    if (!cover) {
      throw new Error("新封面尚未生成，或与当前方案/风格/模型不匹配；请重新生成后再注入。");
    }
    result.coverImage = cover;
  }

  result.backgroundImages = {};
  if (options.generateBackgrounds) {
    for (const node of plan.nodes) {
      const contextKey = refinementImageContextKey(
        plan,
        "background",
        node.id,
        options.stylePrompt,
        imageModel,
      );
      const background = imageAsset(assets?.backgrounds?.[node.id], contextKey);
      if (!background) {
        throw new Error(
          `卡片“${node.stepName}”的新背景尚未生成，或上下文已过期；请补齐后再注入。`,
        );
      }
      result.backgroundImages[node.id] = background;
    }
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function configurationRecord(value: unknown): Record<string, unknown> {
  const root = asRecord(Array.isArray(value) ? value[0] : value);
  if (
    root.trainTaskName ||
    root.description ||
    root.trainTaskCover ||
    root.trainType
  ) {
    return root;
  }
  for (const key of [
    "trainTaskDTO",
    "trainTask",
    "configuration",
    "detail",
    "baseInfo",
  ]) {
    const candidate = asRecord(root[key]);
    if (Object.keys(candidate).length > 0) return candidate;
  }
  return root;
}

async function fetchPolymasData<T>(
  action: string,
  payload: Record<string, unknown>,
  credentials: PolymasCredentials,
): Promise<T> {
  const response = await fetch(`${POLYMAS_BASE}/${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: credentials.authorization,
      Cookie: credentials.cookie,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `平台接口 ${action} 请求失败：${response.status} ${detail.slice(0, 300)}`,
    );
  }
  const result = await response.json();
  if (!(String(result.code) === "200" || result.success === true)) {
    throw new Error(
      `平台接口 ${action} 返回失败：${JSON.stringify(result).slice(0, 500)}`,
    );
  }
  return result.data as T;
}

async function fetchSourceGraph(
  source: ReturnType<typeof parseTrainingUrl>,
  credentials: PolymasCredentials,
) {
  const [steps, flows, configuration, scoreItems] = await Promise.all([
    fetchPolymasData<PolymasScriptStep[]>(
      "queryScriptStepList",
      { trainTaskId: source.trainTaskId, trainSubType: "ability" },
      credentials,
    ),
    fetchPolymasData<PolymasScriptFlow[]>(
      "queryScriptStepFlowList",
      { trainTaskId: source.trainTaskId },
      credentials,
    ),
    queryTrainingTaskConfiguration(
      { trainTaskId: source.trainTaskId, courseId: source.courseId },
      credentials,
    ),
    queryTrainingScoreItems(source.trainTaskId, credentials),
  ]);
  const taskName = cleanText(configuration?.trainTaskName) || "现有能力训练";
  const description = cleanText(configuration?.description);
  const rawConfiguration = configurationRecord(configuration?.raw);
  const snapshot = buildTrainingGraphSnapshot({
    taskName,
    description,
    trainTaskId: source.trainTaskId,
    courseId: source.courseId || undefined,
    sourceUrl: source.raw,
    steps,
    flows,
    scoreItems,
    taskConfiguration: rawConfiguration,
  });
  if (snapshot.nodeCount === 0) {
    throw new Error("源训练中没有可优化的业务卡片。");
  }
  return {
    steps,
    flows,
    configuration,
    rawConfiguration,
    scoreItems,
    snapshot,
  };
}

async function updateTargetBaseConfiguration(params: {
  target: ReturnType<typeof parseTrainingUrl>;
  plan: TrainingRefinementPlan;
  sourceConfiguration: Record<string, unknown>;
  credentials: PolymasCredentials;
  coverImage?: TrainingRefineImageAsset;
  preserveTargetCover?: boolean;
}): Promise<string> {
  const targetConfiguration = await queryTrainingTaskConfiguration(
    {
      trainTaskId: params.target.trainTaskId,
      courseId: params.target.courseId,
    },
    params.credentials,
  );
  if (!params.target.courseId) {
    return "目标训练完整卡片、连线与评分标准已注入；基础配置缺少 courseId，保留目标原值。";
  }
  const sourceConfiguration = structuredClone(params.sourceConfiguration);
  const sourceExtConfig = asRecord(sourceConfiguration.extConfig);
  const targetRaw = configurationRecord(targetConfiguration?.raw);
  const targetExistingCover =
    targetRaw.trainTaskCover || targetConfiguration?.trainTaskCover;
  const sourceCover = sourceConfiguration.trainTaskCover;
  const targetCover = params.coverImage
    ? { fileId: params.coverImage.fileId, fileUrl: params.coverImage.fileUrl }
    : params.preserveTargetCover
      ? targetExistingCover
      : sourceCover || targetExistingCover;
  const payload: Record<string, unknown> = {
    ...targetRaw,
    ...sourceConfiguration,
    trainTaskId: params.target.trainTaskId,
    courseId: params.target.courseId,
    trainSubType: "ability",
    trainTaskName: params.plan.taskName,
    description: params.plan.description,
    extConfig: {
      ...sourceExtConfig,
      trainSubType: "ability",
      trainTaskName: params.plan.taskName,
      description: params.plan.description,
    },
  };
  for (const identityKey of [
    "id",
    "configurationId",
    "taskId",
    "trainTaskNid",
    "businessId",
  ]) {
    if (targetRaw[identityKey] !== undefined) {
      payload[identityKey] = targetRaw[identityKey];
    } else {
      delete payload[identityKey];
    }
  }
  if (targetCover) payload.trainTaskCover = targetCover;
  else delete payload.trainTaskCover;
  await fetchPolymasData<boolean>(
    "editConfiguration",
    payload,
    params.credentials,
  );
  if (params.coverImage) {
    const after = await queryTrainingTaskConfiguration(
      {
        trainTaskId: params.target.trainTaskId,
        courseId: params.target.courseId,
      },
      params.credentials,
    );
    const afterRaw = configurationRecord(after?.raw);
    const afterCover = afterRaw.trainTaskCover || after?.trainTaskCover;
    const afterCoverRecord = asRecord(afterCover);
    if (
      cleanText(afterCoverRecord.fileId) !== params.coverImage.fileId ||
      cleanText(afterCoverRecord.fileUrl) !== params.coverImage.fileUrl
    ) {
      throw new Error("目标训练封面回采校验失败，目标配置未确认写入新封面。");
    }
  }
  return params.coverImage
    ? "已完整克隆源训练基础配置，并应用优化后的名称、描述与新封面。"
    : params.preserveTargetCover
      ? "已完整克隆源训练基础配置，并保留目标训练原封面。"
      : "已完整克隆源训练基础配置，并应用优化后的名称与描述。";
}

async function runOptimization(
  request: NextRequest,
  body: RequestBody,
  abortController: AbortController,
  startedAt: number,
  onProgress?: (message: string) => void,
): Promise<TrainingRefineApiResponse> {
  const { signal } = abortController;
  const onDisconnect = () => {
    abortController.abort(new Error("客户端已断开，优化已取消。"));
  };
  const onTimeout = () => {
    abortController.abort(
      new Error(
        "优化超过 285 秒总预算（含读取源训练），已停止。请缩小优化范围后重试。",
      ),
    );
  };
  const checkActive = () => {
    if (Date.now() - startedAt >= OPTIMIZATION_BUDGET_MS) onTimeout();
    signal.throwIfAborted();
  };
  const remainingMs = OPTIMIZATION_BUDGET_MS - (Date.now() - startedAt);
  const timeoutId = setTimeout(onTimeout, Math.max(0, remainingMs));
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason || new Error("优化已取消。"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  request.signal.addEventListener("abort", onDisconnect, { once: true });
  if (request.signal.aborted) onDisconnect();
  if (remainingMs <= 0) onTimeout();

  try {
    // 同时观察两个 Promise，源接口迟到的失败不会成为未处理的拒绝。
    return await Promise.race([
      aborted,
      (async (): Promise<TrainingRefineApiResponse> => {
        checkActive();
        const source = parseTrainingUrl(body.sourceUrl, "源训练链接");
        const credentials = requireCredentials(body.credentials);
        if (source.apiOrigin && !credentials.apiOrigin) {
          credentials.apiOrigin = source.apiOrigin;
        }
        onProgress?.("正在读取源训练的完整配置、卡片、连线与评分标准……");
        checkActive();
        const sourceGraph = await fetchSourceGraph(source, credentials);
        // 部分平台读取接口不支持取消，返回后必须再次检查，不能继续调用模型。
        checkActive();
        onProgress?.("源训练读取完成，正在准备 AI 优化与图谱校验……");
        checkActive();
        const result = await generateTrainingRefinementPlan({
          sourceName: sourceGraph.snapshot.taskName,
          sourceDescription: sourceGraph.snapshot.description,
          teacherFeedback: cleanText(body.teacherFeedback),
          supplementalContext: cleanText(body.supplementalContext),
          steps: sourceGraph.steps,
          flows: sourceGraph.flows,
          scoreItems: sourceGraph.scoreItems,
          taskConfiguration: sourceGraph.rawConfiguration,
          selectedNodeIds: Array.isArray(body.selectedNodeIds)
            ? body.selectedNodeIds.map(cleanText).filter(Boolean)
            : undefined,
          optimizeScoring: body.optimizeScoring !== false,
          llmSettings: body.llmSettings || {},
          signal,
          onProgress,
        });
        checkActive();
        return {
          ok: true,
          action: "optimize",
          source: sourceGraph.snapshot,
          plan: result.plan,
          validation: result.validation,
          modelUsed: result.modelUsed,
          inputChars: result.inputChars,
        };
      })(),
    ]);
  } finally {
    clearTimeout(timeoutId);
    request.signal.removeEventListener("abort", onDisconnect);
    signal.removeEventListener("abort", onAbort);
  }
}

function streamOptimization(
  request: NextRequest,
  body: RequestBody,
  startedAt: number,
): Response {
  const abortController = new AbortController();
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeatId: ReturnType<typeof setInterval> | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  const close = () => {
    clearInterval(heartbeatId);
    if (closed) return;
    closed = true;
    try {
      streamController.close();
    } catch {
      // 客户端取消时底层流可能已经关闭。
    }
  };
  const disconnect = () => {
    abortController.abort(new Error("客户端已断开，优化已取消。"));
    close();
  };
  const write = (data: string) => {
    if (closed) return;
    if (request.signal.aborted) {
      disconnect();
      return;
    }
    try {
      streamController.enqueue(encoder.encode(data));
    } catch {
      disconnect();
    }
  };
  const send = (event: OptimizationEvent) => {
    if (!closed) write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      // 心跳仅防止连接空闲，不延长 Vercel 函数的总执行时限。
      heartbeatId = setInterval(
        () => write(": heartbeat\n\n"),
        HEARTBEAT_INTERVAL_MS,
      );
      send({ type: "progress", message: "优化请求已接收，正在开始处理……" });
      if (closed) return;
      void (async () => {
        try {
          // 先构造响应并入队首个进度，再开始读取源图。
          await Promise.resolve();
          const result = await runOptimization(
            request,
            body,
            abortController,
            startedAt,
            (message) => {
              if (!abortController.signal.aborted) {
                send({ type: "progress", message });
              }
            },
          );
          send({ type: "result", result });
        } catch (error) {
          send({
            type: "error",
            message:
              error instanceof Error ? error.message : "能力训练优化处理失败。",
          });
        } finally {
          close();
        }
      })();
    },
    cancel() {
      // cancel 回调触发时流已取消，不再尝试入队或关闭底层控制器。
      closed = true;
      disconnect();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = (await request.json()) as RequestBody;
    const action = normalizeAction(body.action);
    if (action === "optimize") {
      const acceptsStream = (request.headers.get("accept") || "")
        .split(",")
        .some(
          (value) =>
            value.split(";")[0].trim().toLowerCase() === "text/event-stream",
        );
      if (acceptsStream) return streamOptimization(request, body, startedAt);
      return NextResponse.json(
        await runOptimization(request, body, new AbortController(), startedAt),
      );
    }
    const source = parseTrainingUrl(body.sourceUrl, "源训练链接");
    const credentials = requireCredentials(body.credentials);
    if (source.apiOrigin && !credentials.apiOrigin) {
      credentials.apiOrigin = source.apiOrigin;
    }
    if (action === "generate-image") {
      return NextResponse.json(await generateRefinementImage(body, credentials));
    }
    const sourceGraph = await fetchSourceGraph(source, credentials);

    if (action === "extract") {
      return NextResponse.json({
        ok: true,
        action,
        source: sourceGraph.snapshot,
      });
    }

    if (action === "analyze-template") {
      const result = await diagnoseTemplateRewrite({
        taskName: sourceGraph.snapshot.taskName,
        description: sourceGraph.snapshot.description,
        steps: sourceGraph.steps,
        flows: sourceGraph.flows,
        scoreItems: sourceGraph.scoreItems,
        taskConfiguration: sourceGraph.rawConfiguration,
        teacherFeedback: cleanText(body.teacherFeedback),
        supplementalContext: cleanText(body.supplementalContext),
        mode: body.templateMode || "auto",
        llmSettings: body.llmSettings || {},
        signal: request.signal,
      });
      return NextResponse.json({
        ok: true,
        action,
        source: sourceGraph.snapshot,
        diagnosis: result.diagnosis,
        templateModulePlan: result.modulePlan,
        inputChars: result.inputChars,
        modelUsed: cleanText(body.llmSettings?.model),
      });
    }

    if (action === "rewrite-template") {
      const result = await rewriteTrainingByTemplate({
        taskName: sourceGraph.snapshot.taskName,
        description: sourceGraph.snapshot.description,
        steps: sourceGraph.steps,
        flows: sourceGraph.flows,
        scoreItems: sourceGraph.scoreItems,
        taskConfiguration: sourceGraph.rawConfiguration,
        teacherFeedback: cleanText(body.teacherFeedback),
        supplementalContext: cleanText(body.supplementalContext),
        mode: body.templateMode || "auto",
        rewriteScoring: body.rewriteScoring === true,
        diagnosis: body.templateDiagnosis,
        modulePlan: body.templateModulePlan,
        llmSettings: body.llmSettings || {},
        signal: request.signal,
      });
      const validation = validateRefinementPlan(
        result.plan,
        sourceGraph.steps,
        sourceGraph.flows,
        sourceGraph.scoreItems,
        {
          editableNodeIds: new Set(sourceGraph.snapshot.nodes.map((node) => node.id)),
          optimizeScoring: body.rewriteScoring !== false,
        },
      );
      if (validation.errors.length > 0) {
        throw new Error(`模板重构图谱校验失败：${validation.errors.join("；")}`);
      }
      return NextResponse.json({
        ok: true,
        action,
        source: sourceGraph.snapshot,
        diagnosis: result.diagnosis,
        templateModulePlan: result.modulePlan,
        plan: result.plan,
        validation: {
          errors: [],
          warnings: [...result.validation.warnings, ...validation.warnings],
        },
        modelUsed: result.modelUsed,
        inputChars: result.inputChars,
      });
    }

    if (!body.plan) {
      throw new Error("请先生成并确认 AI 优化方案。");
    }
    const injectScript = body.injectScript !== false;
    const injectRubric = body.injectRubric !== false;
    const injectMode = body.injectMode === "append" ? "append" : "replace";
    if (!injectScript && !injectRubric) {
      throw new Error("请至少选择训练剧本或评分标准中的一项。");
    }
    const validation = validateRefinementPlan(
      body.plan,
      sourceGraph.steps,
      sourceGraph.flows,
      sourceGraph.scoreItems,
      {
        editableNodeIds: Array.isArray(body.selectedNodeIds)
          ? new Set(body.selectedNodeIds.map(cleanText).filter(Boolean))
          : undefined,
        optimizeScoring: body.optimizeScoring !== false,
      },
    );
    if (validation.errors.length > 0) {
      throw new Error(`优化图谱校验失败：${validation.errors.join("；")}`);
    }

    const target = parseTrainingUrl(body.targetUrl, "目标训练链接");
    if (target.trainTaskId === source.trainTaskId) {
      throw new Error("目标训练必须是另一份训练，不会覆盖源训练。");
    }
    if (injectScript && !target.courseId) {
      throw new Error("注入训练剧本时，目标训练 URL 必须包含 courseId。");
    }

    const importImages =
      action === "import"
        ? validateImportImages(body, body.plan, injectScript, injectMode)
        : undefined;

    if (action === "dry-run") {
      return NextResponse.json({
        ok: true,
        action,
        source: sourceGraph.snapshot,
        plan: body.plan,
        validation,
        stdout: buildRefinementDryRun(body.plan, sourceGraph.steps, {
          injectScript,
          injectRubric,
          injectMode,
          generateCover: body.imageOptions?.generateCover,
          generateBackgrounds: body.imageOptions?.generateBackgrounds,
        }),
      });
    }

    if (!body.confirmImport) {
      throw new Error("正式注入前需要勾选“我已确认目标训练”。");
    }
    const injected = await injectRefinedTraining({
      plan: body.plan,
      sourceSteps: sourceGraph.steps,
      sourceFlows: sourceGraph.flows,
      targetTaskId: target.trainTaskId,
      targetCourseId: target.courseId || undefined,
      credentials,
      injectScript,
      injectRubric,
      injectMode,
      backgroundImages: importImages?.backgroundImages,
      replaceSourceImages: importImages?.replaceSourceImages,
    });

    const baseConfigurationMessage =
      injectScript && injectMode === "replace"
        ? await updateTargetBaseConfiguration({
            target,
            plan: body.plan,
            sourceConfiguration: sourceGraph.rawConfiguration,
            credentials,
            coverImage: importImages?.coverImage,
            preserveTargetCover:
              body.imageOptions !== undefined &&
              body.imageOptions.generateCover !== true,
          })
        : injectScript
          ? "追加模式已保留目标训练原有名称、描述、封面和基础配置。"
          : "本次未注入训练剧本，目标基础配置保持不变。";
    return NextResponse.json({
      ok: true,
      action,
      source: sourceGraph.snapshot,
      plan: body.plan,
      validation,
      stdout: [injected.logs, baseConfigurationMessage]
        .filter(Boolean)
        .join("\n"),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "能力训练优化处理失败。",
      },
      { status: error instanceof RefinerRequestError ? error.status : 400 },
    );
  }
}
