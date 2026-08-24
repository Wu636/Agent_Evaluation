import { NextRequest, NextResponse } from "next/server";

import {
  parsePolymasUrl,
  queryTrainingTaskConfiguration,
} from "@/lib/training-injector/api";
import type {
  PolymasCredentials,
  PolymasScriptFlow,
  PolymasScriptStep,
} from "@/lib/training-injector/types";
import {
  buildTrainingGraphSnapshot,
  generateTrainingRefinementPlan,
  validateRefinementPlan,
} from "@/lib/training-refiner/engine";
import {
  buildRefinementDryRun,
  injectRefinedTraining,
  queryTrainingScoreItems,
} from "@/lib/training-refiner/injector";
import type {
  TrainingRefinementPlan,
  TrainingRefineLlmSettings,
} from "@/lib/training-refiner/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const POLYMAS_BASE = "https://cloudapi.polymas.com/teacher-course/abilityTrain";

type Action = "extract" | "optimize" | "dry-run" | "import";

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
  confirmImport?: boolean;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAction(value: unknown): Action {
  if (
    value === "extract" ||
    value === "optimize" ||
    value === "dry-run" ||
    value === "import"
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
  const targetCover =
    sourceConfiguration.trainTaskCover ||
    targetRaw.trainTaskCover ||
    targetConfiguration?.trainTaskCover;
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
  await fetchPolymasData<boolean>(
    "editConfiguration",
    payload,
    params.credentials,
  );
  return "已完整克隆源训练基础配置，并应用优化后的名称与描述。";
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as RequestBody;
    const action = normalizeAction(body.action);
    const credentials = requireCredentials(body.credentials);
    const source = parseTrainingUrl(body.sourceUrl, "源训练链接");
    const sourceGraph = await fetchSourceGraph(source, credentials);

    if (action === "extract") {
      return NextResponse.json({
        ok: true,
        action,
        source: sourceGraph.snapshot,
      });
    }

    if (action === "optimize") {
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
      });
      return NextResponse.json({
        ok: true,
        action,
        source: sourceGraph.snapshot,
        plan: result.plan,
        validation: result.validation,
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
    });

    const baseConfigurationMessage =
      injectScript && injectMode === "replace"
        ? await updateTargetBaseConfiguration({
            target,
            plan: body.plan,
            sourceConfiguration: sourceGraph.rawConfiguration,
            credentials,
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
      { status: 400 },
    );
  }
}
