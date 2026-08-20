import type { PolymasCredentials } from "@/lib/training-injector/types";

import type {
  TrainingRefinementPlan,
  TrainingRefineInjectMode,
  TrainingScoreItem,
} from "./types";

type RawStep = {
  stepId: string;
  stepDetailDTO?: Record<string, unknown>;
  positionDTO?: { x?: number; y?: number };
};

type RawFlow = {
  flowId?: string;
  scriptStepStartId?: string;
  scriptStepEndId?: string;
  flowCondition?: string;
  flowConfiguration?: unknown;
  transitionPrompt?: string;
  transitionHistoryNum?: number;
  isDefault?: unknown;
};

const BASE_URL = "https://cloudapi.polymas.com/teacher-course/abilityTrain";
const START = "START";
const END = "END";
const EMPTY_FLOW_CONFIGURATION = {
  relation: "and",
  conditions: [
    { text: "条件组1", relation: "and", conditions: [{ text: "" }] },
  ],
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value || "").trim();
}

function isDefault(value: unknown): boolean {
  return (
    value === true ||
    value === 1 ||
    String(value).toLowerCase() === "true" ||
    String(value) === "1"
  );
}

function generateId(size = 21): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

async function platformPost<T>(
  action: string,
  payload: Record<string, unknown>,
  credentials: PolymasCredentials,
): Promise<T> {
  const response = await fetch(`${BASE_URL}/${action}`, {
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
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `平台接口 ${action} 请求失败：${response.status} ${raw.slice(0, 300)}`,
    );
  }
  let result: {
    code?: number | string;
    success?: boolean;
    data?: T;
    msg?: string;
  };
  try {
    result = JSON.parse(raw) as typeof result;
  } catch {
    throw new Error(`平台接口 ${action} 未返回 JSON。`);
  }
  if (!(String(result.code) === "200" || result.success === true)) {
    throw new Error(
      `平台接口 ${action} 返回失败：${result.msg || raw.slice(0, 500)}`,
    );
  }
  return result.data as T;
}

function nodeType(step: RawStep): string {
  return text(step.stepDetailDTO?.nodeType);
}

function businessSteps(steps: RawStep[]): RawStep[] {
  return steps.filter((step) => nodeType(step) === "SCRIPT_NODE");
}

function fileIds(detail: Record<string, unknown> | undefined): string[] {
  const resources = Array.isArray(detail?.scriptStepResourceList)
    ? (detail!.scriptStepResourceList as Array<Record<string, unknown>>)
    : [];
  return resources.map((item) => text(item.fileId)).filter(Boolean);
}

function remapResources(
  resources: Array<Record<string, unknown>>,
  targetTaskId: string,
  newStepId: string,
) {
  const groups = new Map<
    string,
    { nid: string; category: string; list: Array<Record<string, unknown>> }
  >();
  for (const resource of resources) {
    if (!text(resource.fileId)) continue;
    const nid = text(resource.resourceTypeNid || resource.nid) || "default";
    const category = text(resource.category) || "未分类";
    const key = `${nid}\u0000${category}`;
    if (!groups.has(key)) groups.set(key, { nid, category, list: [] });
    groups.get(key)!.list.push({
      type: resource.type || "resource",
      fileId: resource.fileId,
      fileName: resource.fileName,
      thumbnail: resource.thumbnail || "",
      fileUrl: resource.fileUrl,
      isRequired: Boolean(resource.isRequired),
      description: resource.description || "",
      trainTaskId: targetTaskId,
      scriptStepId: newStepId,
      sort: resource.sort,
      scriptStepResourceId: generateId(20),
    });
  }
  return Array.from(groups.values());
}

function cloneDetail(params: {
  sourceDetail: Record<string, unknown>;
  targetTaskId: string;
  newStepId: string;
  isNewNode: boolean;
  refinedNode: TrainingRefinementPlan["nodes"][number];
}) {
  const detail = structuredClone(params.sourceDetail);
  const originalResources = params.isNewNode
    ? []
    : Array.isArray(detail.scriptStepResourceList)
      ? (detail.scriptStepResourceList as Array<Record<string, unknown>>)
      : [];
  const remappedResources = originalResources
    .filter((resource) => text(resource.fileId))
    .map((resource) => {
      const cloned = structuredClone(resource);
      cloned.trainTaskId = params.targetTaskId;
      cloned.scriptStepId = params.newStepId;
      delete cloned.scriptStepResourceId;
      return cloned;
    });
  detail.scriptStepResourceList = remappedResources;
  const ext =
    detail.stepExtProperty && typeof detail.stepExtProperty === "object"
      ? structuredClone(detail.stepExtProperty as Record<string, unknown>)
      : {};
  ext.resources = remapResources(
    originalResources,
    params.targetTaskId,
    params.newStepId,
  );
  detail.stepExtProperty = ext;

  detail.nodeType = "SCRIPT_NODE";
  detail.trainSubType = "ability";
  detail.stepName = params.refinedNode.stepName;
  detail.description = params.refinedNode.description;
  detail.trainerName = params.refinedNode.trainerName;
  detail.prologue = params.refinedNode.prologue;
  detail.llmPrompt = params.refinedNode.llmPrompt;
  detail.interactiveRounds = params.refinedNode.interactiveRounds;
  if (params.refinedNode.modelId) detail.modelId = params.refinedNode.modelId;
  if (params.refinedNode.agentId) detail.agentId = params.refinedNode.agentId;
  if (params.refinedNode.avatarNid)
    detail.avatarNid = params.refinedNode.avatarNid;
  if (
    detail.scriptStepCover &&
    typeof detail.scriptStepCover === "object" &&
    text((detail.scriptStepCover as Record<string, unknown>).fileUrl)
  ) {
    detail.scriptBackgroundType ||= "image";
  }
  detail.contentSkip ??= 0;
  delete detail.createTime;
  delete detail.updateTime;
  return detail;
}

function graphPositions(plan: TrainingRefinementPlan) {
  const adjacency = new Map<string, string[]>();
  for (const flow of plan.flows) {
    adjacency.set(flow.from, [...(adjacency.get(flow.from) || []), flow.to]);
  }
  const depth = new Map<string, number>();
  const queue: Array<[string, number]> = [[START, -1]];
  while (queue.length > 0) {
    const [current, currentDepth] = queue.shift()!;
    for (const next of adjacency.get(current) || []) {
      if (next === END) continue;
      const proposed = currentDepth + 1;
      if (!depth.has(next) || proposed < depth.get(next)!) {
        depth.set(next, proposed);
        queue.push([next, proposed]);
      }
    }
  }
  const fallback = Math.max(-1, ...depth.values()) + 1;
  const layers = new Map<number, string[]>();
  for (const node of plan.nodes) {
    const layer = depth.get(node.id) ?? fallback;
    layers.set(layer, [...(layers.get(layer) || []), node.id]);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [layer, nodeIds] of [...layers.entries()].sort(
    ([a], [b]) => a - b,
  )) {
    nodeIds.forEach((nodeId, row) => {
      positions.set(nodeId, { x: 300 + layer * 430, y: 180 + row * 330 });
    });
  }
  return positions;
}

async function querySteps(taskId: string, credentials: PolymasCredentials) {
  return platformPost<RawStep[]>(
    "queryScriptStepList",
    { trainTaskId: taskId, trainSubType: "ability" },
    credentials,
  );
}

async function queryFlows(taskId: string, credentials: PolymasCredentials) {
  return platformPost<RawFlow[]>(
    "queryScriptStepFlowList",
    { trainTaskId: taskId },
    credentials,
  );
}

export async function queryTrainingScoreItems(
  taskId: string,
  credentials: PolymasCredentials,
): Promise<TrainingScoreItem[]> {
  const items = await platformPost<Array<Record<string, unknown>>>(
    "queryScoreItemList",
    { trainTaskId: taskId },
    credentials,
  );
  if (!Array.isArray(items)) {
    throw new Error("平台评分标准接口未返回评分项列表。");
  }
  return items.map((item) => ({
    itemId: text(item.itemId || item.scoreItemId || item.id) || undefined,
    itemName: text(item.itemName || item.name || item.title),
    score: Number(item.score ?? item.itemScore ?? item.fullScore ?? 0),
    description: text(item.description),
    requireDetail: text(item.requireDetail || item.requirement || item.detail),
  }));
}

async function replaceTrainingScoreItems(params: {
  taskId: string;
  existingItems: TrainingScoreItem[];
  scoreItems: TrainingScoreItem[];
  credentials: PolymasCredentials;
}) {
  const missingIds = params.existingItems.filter((item) => !item.itemId);
  if (missingIds.length > 0) {
    throw new Error(
      `目标训练有 ${missingIds.length} 个评分项缺少 itemId，已中止覆盖，避免产生重复评分项。`,
    );
  }
  for (const item of params.existingItems) {
    await platformPost(
      "delScoreItem",
      { trainTaskId: params.taskId, itemId: item.itemId },
      params.credentials,
    );
  }
  for (const item of params.scoreItems) {
    await platformPost(
      "createScoreItem",
      {
        trainTaskId: params.taskId,
        itemName: item.itemName,
        score: Number(item.score),
        description: item.description,
        requireDetail: item.requireDetail,
      },
      params.credentials,
    );
  }
  const liveItems = await queryTrainingScoreItems(
    params.taskId,
    params.credentials,
  );
  const normalized = (items: TrainingScoreItem[]) =>
    items
      .map((item) => ({
        itemName: item.itemName,
        score: Number(item.score),
        description: item.description,
        requireDetail: item.requireDetail,
      }))
      .sort((a, b) => a.itemName.localeCompare(b.itemName, "zh-CN"));
  if (
    JSON.stringify(normalized(liveItems)) !==
    JSON.stringify(normalized(params.scoreItems))
  ) {
    throw new Error("目标训练评分标准回采校验失败。");
  }
  return liveItems;
}

async function appendTrainingScoreItems(params: {
  taskId: string;
  existingItems: TrainingScoreItem[];
  scoreItems: TrainingScoreItem[];
  credentials: PolymasCredentials;
}) {
  for (const item of params.scoreItems) {
    await platformPost(
      "createScoreItem",
      {
        trainTaskId: params.taskId,
        itemName: item.itemName,
        score: Number(item.score),
        description: item.description,
        requireDetail: item.requireDetail,
      },
      params.credentials,
    );
  }
  const liveItems = await queryTrainingScoreItems(
    params.taskId,
    params.credentials,
  );
  const signature = (item: TrainingScoreItem) =>
    JSON.stringify({
      itemName: item.itemName,
      score: Number(item.score),
      description: item.description,
      requireDetail: item.requireDetail,
    });
  const expectedCounts = new Map<string, number>();
  for (const item of [...params.existingItems, ...params.scoreItems]) {
    const key = signature(item);
    expectedCounts.set(key, (expectedCounts.get(key) || 0) + 1);
  }
  const liveCounts = new Map<string, number>();
  for (const item of liveItems) {
    const key = signature(item);
    liveCounts.set(key, (liveCounts.get(key) || 0) + 1);
  }
  const matches =
    expectedCounts.size === liveCounts.size &&
    [...expectedCounts].every(([key, count]) => liveCounts.get(key) === count);
  if (!matches) throw new Error("目标训练评分标准追加后回采校验失败。");
  return liveItems;
}

async function cleanTarget(taskId: string, credentials: PolymasCredentials) {
  const [flows, steps] = await Promise.all([
    queryFlows(taskId, credentials),
    querySteps(taskId, credentials),
  ]);
  for (const flow of flows) {
    if (!flow.flowId) continue;
    await platformPost(
      "delScriptStepFlow",
      { trainTaskId: taskId, flowId: flow.flowId },
      credentials,
    );
  }
  for (const step of steps) {
    if (!step.stepId) continue;
    await platformPost(
      "delScriptStep",
      { trainTaskId: taskId, stepId: step.stepId },
      credentials,
    );
  }
  const remaining = await querySteps(taskId, credentials);
  if (remaining.length > 0) {
    throw new Error(
      `清理目标训练后仍有 ${remaining.length} 个节点，已中止写入。`,
    );
  }
  return { deletedSteps: steps.length, deletedFlows: flows.length };
}

async function createBoundaryNode(params: {
  taskId: string;
  courseId: string;
  stepId: string;
  nodeType: "SCRIPT_START" | "SCRIPT_END";
  position: { x: number; y: number };
  credentials: PolymasCredentials;
}) {
  await platformPost(
    "createScriptStep",
    {
      trainTaskId: params.taskId,
      stepId: params.stepId,
      stepDetailDTO: {
        nodeType: params.nodeType,
        stepName: "defaultStepName",
        description: "",
        prologue: "",
        modelId: "",
        llmPrompt: "",
        trainerName: "",
        scriptStepCover: {},
        whiteBoardSwitch: 0,
        videoSwitch: 0,
        scriptStepResourceList: [],
        knowledgeBaseSwitch: 0,
        searchEngineSwitch: 0,
        trainSubType: "ability",
      },
      positionDTO: params.position,
      courseId: params.courseId,
      libraryFolderId: "",
    },
    params.credentials,
  );
}

async function createBusinessNode(params: {
  taskId: string;
  courseId: string;
  stepId: string;
  detail: Record<string, unknown>;
  position: { x: number; y: number };
  credentials: PolymasCredentials;
}) {
  await platformPost(
    "createScriptStep",
    {
      trainTaskId: params.taskId,
      stepId: params.stepId,
      stepDetailDTO: {
        nodeType: "SCRIPT_NODE",
        stepName: params.detail.stepName || "未命名卡片",
        description: params.detail.description || "",
        prologue: "",
        modelId: params.detail.modelId || "Doubao-Seed-2.0-pro",
        llmPrompt: "",
        trainerName: params.detail.trainerName || "",
        interactiveRounds: params.detail.interactiveRounds || 1,
        scriptStepCover: {},
        whiteBoardSwitch: 0,
        agentId: params.detail.agentId || "Tg3LpKo28D",
        avatarNid: params.detail.avatarNid || "",
        videoSwitch: 0,
        scriptStepResourceList: [],
        knowledgeBaseSwitch: params.detail.knowledgeBaseSwitch ?? 1,
        searchEngineSwitch: params.detail.searchEngineSwitch ?? 1,
        historyRecordNum: params.detail.historyRecordNum ?? -1,
        trainSubType: "ability",
      },
      positionDTO: params.position,
      courseId: params.courseId,
      libraryFolderId: "",
    },
    params.credentials,
  );
  await platformPost(
    "editScriptStep",
    {
      trainTaskId: params.taskId,
      stepId: params.stepId,
      stepDetailDTO: params.detail,
      positionDTO: params.position,
      courseId: params.courseId,
    },
    params.credentials,
  );
}

async function createFlow(params: {
  taskId: string;
  startId: string;
  endId: string;
  sourceFlow?: RawFlow;
  condition: string;
  transitionPrompt: string;
  defaultFlow: boolean;
  credentials: PolymasCredentials;
}) {
  const flowId = generateId();
  await platformPost(
    "createScriptStepFlow",
    {
      trainTaskId: params.taskId,
      flowId,
      scriptStepStartId: params.startId,
      scriptStepStartHandle: `${params.startId}-source-bottom`,
      scriptStepEndId: params.endId,
      scriptStepEndHandle: `${params.endId}-target-top`,
      flowCondition: params.condition,
      flowConfiguration:
        params.sourceFlow?.flowConfiguration ??
        structuredClone(EMPTY_FLOW_CONFIGURATION),
      flowSettingType: "quick",
      transitionPrompt: params.transitionPrompt,
      transitionHistoryNum: params.sourceFlow?.transitionHistoryNum ?? -1,
      isDefault: params.defaultFlow ? 1 : 0,
      isError: false,
    },
    params.credentials,
  );
  return flowId;
}

export function buildRefinementDryRun(
  plan: TrainingRefinementPlan,
  sourceSteps: RawStep[],
  options?: {
    injectScript?: boolean;
    injectRubric?: boolean;
    injectMode?: TrainingRefineInjectMode;
  },
) {
  const injectScript = options?.injectScript !== false;
  const injectRubric = options?.injectRubric !== false;
  const injectMode = options?.injectMode === "append" ? "append" : "replace";
  const sourceById = new Map(sourceSteps.map((step) => [step.stepId, step]));
  const lines = [
    "========================================================================",
    `🛠️  优化训练：${plan.taskName}`,
    `📝 摘要：${plan.summary || "-"}`,
    `🧩 架构：${plan.architectureRationale || "-"}`,
    `🎯 注入内容：${[
      injectScript ? "训练剧本" : "",
      injectRubric ? "评分标准" : "",
    ]
      .filter(Boolean)
      .join(" + ")}`,
    `📥 注入模式：${injectMode === "append" ? "保留现有内容并追加" : "清空选中内容后重建"}`,
    `📦 卡片 ${plan.nodes.length} 张，连线 ${plan.flows.length} 条，评分项 ${plan.scoreItems?.length || 0} 条`,
  ];
  for (const node of injectScript ? plan.nodes : []) {
    const source = node.sourceStepId
      ? sourceById.get(node.sourceStepId)
      : undefined;
    lines.push(
      `  · [${source ? "原卡优化" : "新增卡"}] ${node.id} | ${node.stepName} | 附件 ${fileIds(source?.stepDetailDTO).length} | 轮次 ${node.interactiveRounds}`,
    );
  }
  for (const flow of injectScript ? plan.flows : []) {
    lines.push(
      `  → ${flow.from} --[${flow.isDefault ? "默认" : "条件"}: ${flow.condition.slice(0, 48)}]--> ${flow.to}`,
    );
  }
  for (const scoreItem of injectRubric ? plan.scoreItems || [] : []) {
    lines.push(
      `  ★ ${scoreItem.itemName}：${scoreItem.score} 分｜${scoreItem.requireDetail.slice(0, 80)}`,
    );
  }
  lines.push("✅ Dry-run 完成，未调用任何写入接口。");
  return lines.join("\n");
}

export async function injectRefinedTraining(params: {
  plan: TrainingRefinementPlan;
  sourceSteps: RawStep[];
  sourceFlows: RawFlow[];
  targetTaskId: string;
  targetCourseId?: string;
  credentials: PolymasCredentials;
  injectScript?: boolean;
  injectRubric?: boolean;
  injectMode?: TrainingRefineInjectMode;
}) {
  const injectScript = params.injectScript !== false;
  const injectRubric = params.injectRubric !== false;
  const injectMode: TrainingRefineInjectMode =
    params.injectMode === "append" ? "append" : "replace";
  if (!injectScript && !injectRubric) {
    throw new Error("请至少选择训练剧本或评分标准中的一项。");
  }
  if (injectScript && !params.targetCourseId) {
    throw new Error("注入训练剧本时，目标训练 URL 必须包含 courseId。");
  }
  if (injectRubric && !params.plan.scoreItems?.length) {
    throw new Error("优化方案中没有可注入的评分项。");
  }
  const targetScoreItemsBefore = injectRubric
    ? await queryTrainingScoreItems(params.targetTaskId, params.credentials)
    : [];
  if (
    injectRubric &&
    injectMode === "replace" &&
    targetScoreItemsBefore.some((item) => !item.itemId)
  ) {
    throw new Error(
      "目标训练存在无法精确定位的评分项，已在修改剧本前中止覆盖。",
    );
  }
  const sourceBusiness = businessSteps(params.sourceSteps);
  const sourceById = new Map(sourceBusiness.map((step) => [step.stepId, step]));
  const sourceFlowById = new Map(
    params.sourceFlows
      .filter((flow) => flow.flowId)
      .map((flow) => [flow.flowId!, flow]),
  );
  const templateFallback = sourceBusiness[0];
  if (injectScript && !templateFallback)
    throw new Error("源训练没有业务卡片。");

  const logs: string[] = [];
  let scriptCards = 0;
  let scriptFlows = 0;
  let scriptResources = 0;
  const edgeKey = (
    start: string,
    end: string,
    condition: string,
    defaultFlow: boolean,
  ) => `${start}\u0000${end}\u0000${condition}\u0000${defaultFlow ? 1 : 0}`;
  if (injectScript) {
    const [targetStepsBefore, targetFlowsBefore] = await Promise.all([
      querySteps(params.targetTaskId, params.credentials),
      queryFlows(params.targetTaskId, params.credentials),
    ]);
    const targetBusinessBefore = businessSteps(targetStepsBefore);
    const preservedStepIds = new Set(
      targetStepsBefore.map((step) => step.stepId).filter(Boolean),
    );
    const preservedFlowIds = new Set(
      targetFlowsBefore.map((flow) => flow.flowId).filter(Boolean) as string[],
    );
    let startId = "";
    let endId = "";
    let deletedConnectorCount = 0;
    let positionOffsetX = 0;

    if (injectMode === "replace") {
      const cleanup = await cleanTarget(
        params.targetTaskId,
        params.credentials,
      );
      logs.push(
        `🧹 已清理目标训练：节点 ${cleanup.deletedSteps}，连线 ${cleanup.deletedFlows}`,
      );
      startId = generateId();
      endId = generateId();
      await createBoundaryNode({
        taskId: params.targetTaskId,
        courseId: params.targetCourseId!,
        stepId: startId,
        nodeType: "SCRIPT_START",
        position: { x: 0, y: 300 },
        credentials: params.credentials,
      });
      await createBoundaryNode({
        taskId: params.targetTaskId,
        courseId: params.targetCourseId!,
        stepId: endId,
        nodeType: "SCRIPT_END",
        position: {
          x: Math.max(3_000, params.plan.nodes.length * 430),
          y: 300,
        },
        credentials: params.credentials,
      });
    } else {
      const starts = targetStepsBefore.filter(
        (step) => nodeType(step) === "SCRIPT_START",
      );
      const ends = targetStepsBefore.filter(
        (step) => nodeType(step) === "SCRIPT_END",
      );
      if (starts.length !== 1 || ends.length !== 1) {
        throw new Error(
          `追加模式要求目标训练恰好有 1 个 START 和 1 个 END，当前为 ${starts.length}/${ends.length}。`,
        );
      }
      startId = starts[0].stepId;
      endId = ends[0].stepId;
      const outgoingByStep = new Map<string, RawFlow[]>();
      for (const flow of targetFlowsBefore) {
        const from = text(flow.scriptStepStartId);
        outgoingByStep.set(from, [...(outgoingByStep.get(from) || []), flow]);
      }
      let appendAnchorId = startId;
      if (targetBusinessBefore.length > 0) {
        const safeTerminals = targetBusinessBefore.filter((step) => {
          const outgoing = outgoingByStep.get(step.stepId) || [];
          return (
            outgoing.length > 0 &&
            outgoing.every((flow) => text(flow.scriptStepEndId) === endId)
          );
        });
        if (safeTerminals.length === 0) {
          throw new Error(
            "目标训练没有可安全追加的末端卡片（仅连向 END），请改用覆盖重建或先整理目标连线。",
          );
        }
        safeTerminals.sort(
          (a, b) =>
            Number(b.positionDTO?.x || 0) - Number(a.positionDTO?.x || 0),
        );
        appendAnchorId = safeTerminals[0].stepId;
      }
      const connectors = targetFlowsBefore.filter(
        (flow) =>
          text(flow.scriptStepStartId) === appendAnchorId &&
          text(flow.scriptStepEndId) === endId,
      );
      for (const flow of connectors) {
        if (!flow.flowId) continue;
        await platformPost(
          "delScriptStepFlow",
          { trainTaskId: params.targetTaskId, flowId: flow.flowId },
          params.credentials,
        );
        preservedFlowIds.delete(flow.flowId);
        deletedConnectorCount += 1;
      }
      startId = appendAnchorId;
      const maxExistingX = Math.max(
        0,
        ...targetStepsBefore.map((step) => Number(step.positionDTO?.x || 0)),
      );
      const planPositions = graphPositions(params.plan);
      const minPlanX = Math.min(
        300,
        ...[...planPositions.values()].map((position) => position.x),
      );
      positionOffsetX = maxExistingX + 430 - minPlanX;
      logs.push(
        `➕ 追加模式：保留原节点 ${targetStepsBefore.length} 个、原连线 ${targetFlowsBefore.length - deletedConnectorCount} 条，从末端卡片接入优化图谱`,
      );
    }

    const liveIds = new Map<string, string>([
      [START, startId],
      [END, endId],
    ]);
    const positions = graphPositions(params.plan);
    const expectedFiles = new Map<string, string[]>();
    for (const node of params.plan.nodes) {
      const source = node.sourceStepId
        ? sourceById.get(node.sourceStepId)
        : node.templateSourceStepId
          ? sourceById.get(node.templateSourceStepId)
          : templateFallback;
      if (!source?.stepDetailDTO) {
        throw new Error(`卡片 ${node.stepName} 没有可继承的原卡配置。`);
      }
      const stepId = generateId();
      liveIds.set(node.id, stepId);
      const detail = cloneDetail({
        sourceDetail: source.stepDetailDTO,
        targetTaskId: params.targetTaskId,
        newStepId: stepId,
        isNewNode: !node.sourceStepId,
        refinedNode: node,
      });
      const basePosition = positions.get(node.id) || { x: 300, y: 300 };
      await createBusinessNode({
        taskId: params.targetTaskId,
        courseId: params.targetCourseId!,
        stepId,
        detail,
        position: {
          x: basePosition.x + positionOffsetX,
          y: basePosition.y,
        },
        credentials: params.credentials,
      });
      expectedFiles.set(stepId, fileIds(detail));
      logs.push(
        `✅ 卡片：${node.stepName}（附件 ${fileIds(detail).length} 个）`,
      );
    }

    const expectedEdges = new Map<string, number>();
    for (const flow of params.plan.flows) {
      const start = liveIds.get(flow.from);
      const end = liveIds.get(flow.to);
      if (!start || !end)
        throw new Error(`连线端点映射失败：${flow.from} -> ${flow.to}`);
      await createFlow({
        taskId: params.targetTaskId,
        startId: start,
        endId: end,
        sourceFlow: flow.sourceFlowId
          ? sourceFlowById.get(flow.sourceFlowId)
          : undefined,
        condition: flow.condition,
        transitionPrompt: flow.transitionPrompt,
        defaultFlow: flow.isDefault,
        credentials: params.credentials,
      });
      const key = edgeKey(start, end, flow.condition, flow.isDefault);
      expectedEdges.set(key, (expectedEdges.get(key) || 0) + 1);
    }

    const [liveSteps, liveFlows] = await Promise.all([
      querySteps(params.targetTaskId, params.credentials),
      queryFlows(params.targetTaskId, params.credentials),
    ]);
    const liveBusiness = businessSteps(liveSteps);
    const liveFileMap = new Map(
      liveBusiness.map((step) => [step.stepId, fileIds(step.stepDetailDTO)]),
    );
    const liveEdges = new Map<string, number>();
    for (const flow of liveFlows) {
      const key = edgeKey(
        text(flow.scriptStepStartId),
        text(flow.scriptStepEndId),
        text(flow.flowCondition),
        isDefault(flow.isDefault),
      );
      liveEdges.set(key, (liveEdges.get(key) || 0) + 1);
    }
    const exactFiles = [...expectedFiles].every(([stepId, expected]) => {
      const actual = [...(liveFileMap.get(stepId) || [])].sort();
      const sortedExpected = [...expected].sort();
      return (
        sortedExpected.length === actual.length &&
        sortedExpected.every((value, index) => value === actual[index])
      );
    });
    const edgesPresent = [...expectedEdges].every(
      ([key, count]) => (liveEdges.get(key) || 0) >= count,
    );
    const expectedBusinessCount =
      (injectMode === "append" ? targetBusinessBefore.length : 0) +
      params.plan.nodes.length;
    const expectedFlowCount =
      (injectMode === "append"
        ? targetFlowsBefore.length - deletedConnectorCount
        : 0) + params.plan.flows.length;
    const preservedStepsPresent =
      injectMode !== "append" ||
      [...preservedStepIds].every((id) =>
        liveSteps.some((step) => step.stepId === id),
      );
    const preservedFlowsPresent =
      injectMode !== "append" ||
      [...preservedFlowIds].every((id) =>
        liveFlows.some((flow) => flow.flowId === id),
      );
    const checks = {
      业务卡片: liveBusiness.length === expectedBusinessCount,
      连线数量: liveFlows.length === expectedFlowCount,
      新连线结构: edgesPresent,
      新卡附件: exactFiles,
      原节点保留: preservedStepsPresent,
      原连线保留: preservedFlowsPresent,
    };
    const failed = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    scriptResources = [...expectedFiles.values()].reduce(
      (sum, files) => sum + files.length,
      0,
    );
    logs.push(
      `🔎 回采：业务卡片 ${liveBusiness.length}/${expectedBusinessCount}，连线 ${liveFlows.length}/${expectedFlowCount}，新附件 ${scriptResources}`,
    );
    if (failed.length > 0) {
      throw new Error(`目标训练回采校验失败：${failed.join("、")}`);
    }
    logs.push("✅ 卡片、连线、附件及原配置保留校验通过");
    scriptCards = params.plan.nodes.length;
    scriptFlows = params.plan.flows.length;
  } else {
    logs.push("⏭️ 本次未勾选训练剧本，目标卡片和连线保持不变");
  }

  let scoreItems = 0;
  let scoreTotal = 0;
  if (injectRubric) {
    const liveScoreItems =
      injectMode === "append"
        ? await appendTrainingScoreItems({
            taskId: params.targetTaskId,
            existingItems: targetScoreItemsBefore,
            scoreItems: params.plan.scoreItems,
            credentials: params.credentials,
          })
        : await replaceTrainingScoreItems({
            taskId: params.targetTaskId,
            existingItems: targetScoreItemsBefore,
            scoreItems: params.plan.scoreItems,
            credentials: params.credentials,
          });
    scoreItems = liveScoreItems.length;
    scoreTotal = liveScoreItems.reduce(
      (sum, item) => sum + Number(item.score || 0),
      0,
    );
    logs.push(
      `✅ 评分标准已${injectMode === "append" ? "追加" : "覆盖"}并回采通过：目标现有 ${scoreItems} 项，共 ${scoreTotal} 分`,
    );
  } else {
    logs.push("⏭️ 本次未勾选评分标准，目标评分项保持不变");
  }
  return {
    logs: logs.join("\n"),
    summary: {
      cards: scriptCards,
      flows: scriptFlows,
      resources: scriptResources,
      scoreItems,
      scoreTotal,
    },
  };
}
