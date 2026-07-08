import { execFile } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { NextRequest, NextResponse } from "next/server";
import { parsePolymasUrl } from "@/lib/training-injector/api";
import type { PolymasCredentials } from "@/lib/training-injector/types";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

type ActionMode = "plan" | "dry-run" | "import";
type Operation = "split" | "merge";
type ImportMode = "replace" | "append";
type MergeMode = "sequential" | "branch";

interface LLMSettings {
  apiKey?: string;
  apiUrl?: string;
  model?: string;
}

interface SplitLevelTarget {
  level: number;
  targetUrl: string;
}

interface SplitPlanGroup {
  level: number;
  title: string;
  reason?: string;
  nodeIds: string[];
  nodeNames: string[];
  targetUrl?: string;
}

interface SplitPlan {
  kind: "split";
  summary: string;
  groups: SplitPlanGroup[];
  unassignedNodes: string[];
  warnings: string[];
  planner: "llm" | "heuristic";
}

interface MergePlanSource {
  index: number;
  trainTaskId: string;
  title: string;
  nodeCount: number;
  firstNodeNames: string[];
  lastNodeNames: string[];
}

interface MergePlanConnection {
  from: string;
  to: string;
  type: "start" | "internal" | "cross" | "branch" | "end";
  label: string;
}

interface MergePlan {
  kind: "merge";
  summary: string;
  mode: MergeMode;
  renumber: boolean;
  sources: MergePlanSource[];
  connections: MergePlanConnection[];
  warnings: string[];
  planner: "llm" | "heuristic";
}

interface BaseRequestBody {
  operation: Operation;
  action: ActionMode;
  credentials?: PolymasCredentials;
  userLogic?: string;
  importMode?: ImportMode;
  confirmImport?: boolean;
  llmSettings?: LLMSettings;
}

interface SplitRequestBody extends BaseRequestBody {
  operation: "split";
  sourceUrl?: string;
  targets?: SplitLevelTarget[];
  splitPlan?: SplitPlan;
}

interface MergeRequestBody extends BaseRequestBody {
  operation: "merge";
  targetUrl?: string;
  sourceUrls?: string[];
  mode?: MergeMode;
  renumber?: boolean;
  mergePlan?: MergePlan;
}

type RequestBody = SplitRequestBody | MergeRequestBody;

interface ScriptNode {
  stepId: string;
  stepDetailDTO?: {
    nodeType?: string;
    stepName?: string;
    description?: string;
    scriptStepResourceList?: Array<{ fileId?: string; fileName?: string }>;
  };
}

interface ScriptFlow {
  scriptStepStartId?: string;
  scriptStepEndId?: string;
  flowCondition?: string;
}

const SKILL_DIR = path.resolve(process.cwd(), "..", ".agents", "skills", "training-split-injector");
const POLYMAS_BASE = "https://cloudapi.polymas.com/teacher-course/abilityTrain";
const PYTHON_DEPENDENCY_CHECK = "import requests, dotenv";
const PYTHON_DEPENDENCIES = "requests python-dotenv";
const CN_NUM: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAction(value: unknown): ActionMode {
  if (value === "import" || value === "dry-run" || value === "plan") return value;
  return "plan";
}

function normalizeOperation(value: unknown): Operation | null {
  if (value === "split" || value === "merge") return value;
  return null;
}

function normalizeMergeMode(value: unknown): MergeMode {
  return value === "branch" ? "branch" : "sequential";
}

function normalizeImportMode(value: unknown): ImportMode {
  return value === "append" ? "append" : "replace";
}

function requireCredentials(credentials: PolymasCredentials | undefined): PolymasCredentials {
  const authorization = cleanText(credentials?.authorization);
  const cookie = cleanText(credentials?.cookie);
  if (!authorization || !cookie) {
    throw new Error("请填写平台 Authorization 和 Cookie。");
  }
  return { authorization, cookie, userNid: cleanText(credentials?.userNid) || undefined };
}

function parseTrainingUrl(value: unknown, label: string) {
  const raw = cleanText(value);
  const parsed = parsePolymasUrl(raw);
  if (!parsed?.trainTaskId) {
    throw new Error(`${label} 不是有效的能力训练页面 URL。`);
  }
  return parsed;
}

function nodeName(node: ScriptNode): string {
  return cleanText(node.stepDetailDTO?.stepName) || node.stepId;
}

function nodeDescription(node: ScriptNode): string {
  return cleanText(node.stepDetailDTO?.description);
}

function isBusinessNode(node: ScriptNode): boolean {
  return node.stepDetailDTO?.nodeType === "SCRIPT_NODE";
}

function isStartNode(node: ScriptNode): boolean {
  return node.stepDetailDTO?.nodeType === "SCRIPT_START";
}

function isEndNode(node: ScriptNode): boolean {
  return node.stepDetailDTO?.nodeType === "SCRIPT_END";
}

function parseLevel(name: string): number | null {
  const digit = name.match(/^关卡\s*([1-9]|10|1[1-9]|20)(?:\.|[：:])/);
  if (digit) return Number(digit[1]);
  const cn = name.match(/^关卡\s*([一二三四五六七八九十])(?:\.|[：:])/);
  if (cn) return CN_NUM[cn[1]] || null;
  return null;
}

function parseLevelToken(token: string): number | null {
  const trimmed = token.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return CN_NUM[trimmed] || null;
}

async function fetchPolymasData<T>(
  action: string,
  payload: Record<string, unknown>,
  credentials: PolymasCredentials
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
  });

  if (!response.ok) {
    const rawText = await response.text().catch(() => "");
    throw new Error(`平台接口 ${action} 请求失败：${response.status} ${response.statusText}${rawText ? ` - ${rawText.slice(0, 300)}` : ""}`);
  }

  const result = await response.json();
  if (!(String(result.code) === "200" || result.success === true)) {
    throw new Error(`平台接口 ${action} 返回失败：${JSON.stringify(result).slice(0, 500)}`);
  }
  return result.data as T;
}

async function fetchTrainingGraph(trainTaskId: string, credentials: PolymasCredentials) {
  const [nodes, flows] = await Promise.all([
    fetchPolymasData<ScriptNode[]>(
      "queryScriptStepList",
      { trainTaskId, trainSubType: "ability" },
      credentials
    ),
    fetchPolymasData<ScriptFlow[]>(
      "queryScriptStepFlowList",
      { trainTaskId },
      credentials
    ),
  ]);
  return { nodes, flows };
}

async function writeSplitSourceDir(sourceTrainTaskId: string, credentials: PolymasCredentials) {
  const graph = await fetchTrainingGraph(sourceTrainTaskId, credentials);
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "training-split-"));
  await Promise.all([
    writeFile(path.join(sourceDir, "queryscriptsteplist.json"), JSON.stringify({ data: graph.nodes }, null, 2), "utf-8"),
    writeFile(path.join(sourceDir, "queryscriptstepflowlist.json"), JSON.stringify({ data: graph.flows }, null, 2), "utf-8"),
  ]);
  return { sourceDir, graph };
}

function groupNodesByDetectedLevel(nodes: ScriptNode[]) {
  const groups = new Map<number, ScriptNode[]>();
  const unassigned: ScriptNode[] = [];
  for (const node of nodes.filter(isBusinessNode)) {
    const level = parseLevel(nodeName(node));
    if (level == null) {
      unassigned.push(node);
      continue;
    }
    if (!groups.has(level)) groups.set(level, []);
    groups.get(level)!.push(node);
  }
  return { groups, unassigned };
}

function planGroupsFromUserLogic(logic: string, detected: Map<number, ScriptNode[]>) {
  const groups: Array<{ title: string; levels: number[]; reason: string }> = [];
  const rangePattern = /(?:关卡)?\s*([一二三四五六七八九十\d]+)\s*(?:[-~到至]|和|、|,|，)\s*(?:关卡)?\s*([一二三四五六七八九十\d]+)/g;
  let match: RegExpExecArray | null;
  while ((match = rangePattern.exec(logic))) {
    const start = parseLevelToken(match[1]);
    const end = parseLevelToken(match[2]);
    if (!start || !end) continue;
    const min = Math.min(start, end);
    const max = Math.max(start, end);
    const levels = Array.from({ length: max - min + 1 }, (_, index) => min + index).filter((level) => detected.has(level));
    if (levels.length > 0) {
      groups.push({
        title: `关卡 ${levels.join("-")}`,
        levels,
        reason: "根据用户说明中的关卡组合生成",
      });
    }
  }
  return groups;
}

async function callPlannerLLM<T>(settings: LLMSettings | undefined, systemPrompt: string, userPrompt: string): Promise<T | null> {
  const apiKey = cleanText(settings?.apiKey);
  const apiUrl = cleanText(settings?.apiUrl);
  const model = cleanText(settings?.model);
  if (!apiKey || !apiUrl || !model) return null;

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!response.ok) return null;
    const json = await response.json();
    const content = json.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function buildSplitPlan(body: SplitRequestBody, credentials: PolymasCredentials): Promise<SplitPlan> {
  const source = parseTrainingUrl(body.sourceUrl, "源训练链接");
  const graph = await fetchTrainingGraph(source.trainTaskId, credentials);
  const businessNodes = graph.nodes.filter(isBusinessNode);
  const detected = groupNodesByDetectedLevel(graph.nodes);
  const logic = cleanText(body.userLogic);
  const nodeBrief = businessNodes.map((node) => ({
    id: node.stepId,
    name: nodeName(node),
    description: nodeDescription(node),
    detectedLevel: parseLevel(nodeName(node)),
  }));

  let planner: SplitPlan["planner"] = "heuristic";
  let llmGroups: Array<{ title?: string; reason?: string; nodeIds?: string[] }> = [];
  if (logic) {
    const llm = await callPlannerLLM<{ groups?: Array<{ title?: string; reason?: string; nodeIds?: string[] }>; warnings?: string[] }>(
      body.llmSettings,
      "你是能力训练拆分规划助手。只输出 JSON。根据用户意图把源训练节点分成若干目标训练，每组必须返回 nodeIds，不要编造不存在的 nodeId。",
      JSON.stringify({ userLogic: logic, nodes: nodeBrief }, null, 2)
    );
    if (llm?.groups?.length) {
      llmGroups = llm.groups;
      planner = "llm";
    }
  }

  const validNodeIds = new Set(businessNodes.map((node) => node.stepId));
  const groups: SplitPlanGroup[] = [];
  const used = new Set<string>();

  for (const [index, group] of llmGroups.entries()) {
    const nodeIds = (group.nodeIds || []).filter((id) => validNodeIds.has(id) && !used.has(id));
    if (nodeIds.length === 0) continue;
    nodeIds.forEach((id) => used.add(id));
    groups.push({
      level: index + 1,
      title: cleanText(group.title) || `拆分组 ${index + 1}`,
      reason: cleanText(group.reason) || "大模型根据用户说明生成",
      nodeIds,
      nodeNames: nodeIds.map((id) => nodeName(businessNodes.find((node) => node.stepId === id)!)),
    });
  }

  if (groups.length === 0) {
    const explicitGroups = planGroupsFromUserLogic(logic, detected.groups);
    if (explicitGroups.length > 0) {
      explicitGroups.forEach((group, index) => {
        const nodes = group.levels.flatMap((level) => detected.groups.get(level) || []).filter((node) => !used.has(node.stepId));
        nodes.forEach((node) => used.add(node.stepId));
        groups.push({
          level: index + 1,
          title: group.title,
          reason: group.reason,
          nodeIds: nodes.map((node) => node.stepId),
          nodeNames: nodes.map(nodeName),
        });
      });
    } else {
      Array.from(detected.groups.entries())
        .sort(([a], [b]) => a - b)
        .forEach(([level, nodes], index) => {
          nodes.forEach((node) => used.add(node.stepId));
          groups.push({
            level: index + 1,
            title: `关卡 ${level}`,
            reason: "按源训练中的关卡编号自动拆分",
            nodeIds: nodes.map((node) => node.stepId),
            nodeNames: nodes.map(nodeName),
          });
        });
    }
  }

  if (groups.length === 0 && businessNodes.length > 0) {
    groups.push({
      level: 1,
      title: "全部卡片",
      reason: "未识别出关卡编号，暂按全部卡片生成一个训练",
      nodeIds: businessNodes.map((node) => node.stepId),
      nodeNames: businessNodes.map(nodeName),
    });
  }

  const unassignedNodes = businessNodes.filter((node) => !used.has(node.stepId)).map(nodeName);
  const warnings = [
    ...(unassignedNodes.length ? [`有 ${unassignedNodes.length} 个业务卡片未进入拆分组，请确认是否需要在规划说明里指定它们。`] : []),
    ...(detected.unassigned.length ? [`源训练中存在 ${detected.unassigned.length} 个未归属关卡的业务卡片，可能是分支/选择卡。`] : []),
  ];

  return {
    kind: "split",
    summary: `已规划 ${groups.length} 个目标训练，共覆盖 ${groups.reduce((sum, group) => sum + group.nodeIds.length, 0)} 个业务卡片。`,
    groups,
    unassignedNodes,
    warnings,
    planner,
  };
}

async function buildMergePlan(body: MergeRequestBody, credentials: PolymasCredentials): Promise<MergePlan> {
  const sourceUrls = (Array.isArray(body.sourceUrls) ? body.sourceUrls : []).filter((url) => cleanText(url)).slice(0, 10);
  if (sourceUrls.length < 2) {
    throw new Error("合并规划至少需要 2 个源训练页面 URL。");
  }

  const logic = cleanText(body.userLogic);
  const parsedSources = sourceUrls.map((url, index) => parseTrainingUrl(url, `源训练 ${index + 1} 链接`));
  const sourceGraphs = await Promise.all(parsedSources.map((source) => fetchTrainingGraph(source.trainTaskId, credentials)));
  const sourceBrief = sourceGraphs.map((graph, index) => {
    const businessNodes = graph.nodes.filter(isBusinessNode);
    const start = graph.nodes.find(isStartNode)?.stepId;
    const end = graph.nodes.find(isEndNode)?.stepId;
    const firstIds = graph.flows.filter((flow) => flow.scriptStepStartId === start).map((flow) => flow.scriptStepEndId);
    const lastIds = graph.flows.filter((flow) => flow.scriptStepEndId === end).map((flow) => flow.scriptStepStartId);
    return {
      index: index + 1,
      trainTaskId: parsedSources[index].trainTaskId,
      title: `源训练 ${index + 1}`,
      nodeCount: businessNodes.length,
      firstNodeNames: firstIds.map((id) => nodeName(businessNodes.find((node) => node.stepId === id) || { stepId: id || "" })),
      lastNodeNames: lastIds.map((id) => nodeName(businessNodes.find((node) => node.stepId === id) || { stepId: id || "" })),
      nodes: businessNodes.map((node) => ({ id: node.stepId, name: nodeName(node), description: nodeDescription(node) })),
    };
  });

  let mode = normalizeMergeMode(body.mode);
  let order = sourceBrief.map((source) => source.index);
  let planner: MergePlan["planner"] = "heuristic";

  if (/分支|选择|并行|多路径/.test(logic)) mode = "branch";
  if (/串联|顺序|依次|线性/.test(logic)) mode = "sequential";

  if (logic) {
    const llm = await callPlannerLLM<{ mode?: MergeMode; order?: number[]; warnings?: string[] }>(
      body.llmSettings,
      "你是能力训练合并规划助手。只输出 JSON。根据用户意图选择合并模式和源训练顺序。mode 只能是 sequential 或 branch，order 只能使用给定源训练 index。",
      JSON.stringify({ userLogic: logic, defaultMode: mode, sources: sourceBrief }, null, 2)
    );
    if (llm) {
      if (llm.mode === "branch" || llm.mode === "sequential") mode = llm.mode;
      const validOrder = (llm.order || []).filter((item) => order.includes(item));
      if (validOrder.length === order.length) order = validOrder;
      planner = "llm";
    }
  }

  const orderedSources = order.map((sourceIndex) => sourceBrief[sourceIndex - 1]);
  const connections: MergePlanConnection[] = [];
  if (mode === "sequential") {
    connections.push({ from: "START", to: orderedSources[0].title, type: "start", label: "进入首个源训练" });
    orderedSources.slice(0, -1).forEach((source, index) => {
      connections.push({
        from: source.title,
        to: orderedSources[index + 1].title,
        type: "cross",
        label: "前一训练结束后进入下一训练",
      });
    });
    connections.push({ from: orderedSources[orderedSources.length - 1].title, to: "END", type: "end", label: "末尾训练结束" });
  } else {
    connections.push({ from: "START", to: orderedSources[0].title, type: "start", label: "先进入入口训练" });
    connections.push({ from: orderedSources[0].title, to: "分支选择", type: "branch", label: "入口训练结束后选择分支" });
    orderedSources.slice(1).forEach((source) => {
      connections.push({ from: "分支选择", to: source.title, type: "branch", label: `选择 ${source.title}` });
      connections.push({ from: source.title, to: "END", type: "end", label: "分支训练结束" });
    });
  }

  return {
    kind: "merge",
    summary: `已规划 ${orderedSources.length} 个源训练以 ${mode === "branch" ? "分支" : "串联"} 方式合并。`,
    mode,
    renumber: body.renumber !== false,
    sources: orderedSources.map(({ nodes, ...source }) => source),
    connections,
    warnings: planner === "heuristic" && logic ? ["当前未使用大模型或大模型规划失败，已按关键词和输入顺序生成兜底规划。"] : [],
    planner,
  };
}

function validateSplitPlan(plan: SplitPlan | undefined): SplitPlan {
  if (!plan?.groups?.length) {
    throw new Error("请先生成并确认拆分规划。");
  }
  return plan;
}

function validateMergePlan(plan: MergePlan | undefined): MergePlan {
  if (!plan?.sources?.length) {
    throw new Error("请先生成并确认合并规划。");
  }
  return plan;
}

async function writeSplitPlanFile(plan: SplitPlan) {
  const planDir = await mkdtemp(path.join(os.tmpdir(), "training-plan-"));
  const planFile = path.join(planDir, "split-plan.json");
  await writeFile(
    planFile,
    JSON.stringify(
      {
        groups: plan.groups.map((group, index) => ({
          level: group.level || index + 1,
          title: group.title,
          nodeIds: group.nodeIds,
        })),
      },
      null,
      2
    ),
    "utf-8"
  );
  return { planDir, planFile };
}

async function buildSplitArgs(body: SplitRequestBody, credentials: PolymasCredentials) {
  const action = normalizeAction(body.action);
  const source = parseTrainingUrl(body.sourceUrl, "源训练链接");
  const { sourceDir } = await writeSplitSourceDir(source.trainTaskId, credentials);
  const args = [path.join(SKILL_DIR, "split_training.py"), "--source-dir", sourceDir];
  const tempDirs = [sourceDir];

  const plan = validateSplitPlan(body.splitPlan);
  const { planDir, planFile } = await writeSplitPlanFile(plan);
  tempDirs.push(planDir);
  args.push("--plan-file", planFile);

  if (action === "dry-run") {
    args.push("--dry-run");
    return { args, tempDirs };
  }

  if (!body.confirmImport) {
    throw new Error("正式拆分导入前需要确认执行。");
  }

  const targetByLevel = new Map<number, ReturnType<typeof parseTrainingUrl>>();
  for (const target of Array.isArray(body.targets) ? body.targets : []) {
    if (!cleanText(target.targetUrl)) continue;
    targetByLevel.set(Number(target.level), parseTrainingUrl(target.targetUrl, `拆分组 ${target.level} 目标训练链接`));
  }

  for (const group of plan.groups) {
    if (!targetByLevel.has(group.level)) {
      throw new Error(`拆分组「${group.title}」还没有填写目标训练页面 URL。`);
    }
  }

  const targetCourseId = Array.from(targetByLevel.values()).find((item) => item.courseId)?.courseId || source.courseId;
  if (targetCourseId) args.push("--course-id", targetCourseId);

  args.push("--import", "--import-mode", normalizeImportMode(body.importMode));
  for (const group of plan.groups) {
    args.push(`--level${group.level}`, targetByLevel.get(group.level)!.trainTaskId);
  }
  return { args, tempDirs };
}

function buildMergeArgs(body: MergeRequestBody) {
  const action = normalizeAction(body.action);
  const target = parseTrainingUrl(body.targetUrl, "目标训练链接");
  const plan = validateMergePlan(body.mergePlan);

  if (!target.courseId) {
    throw new Error("目标训练 URL 中缺少 courseId，请粘贴平台完整页面 URL。");
  }
  if (action === "import" && !body.confirmImport) {
    throw new Error("正式合并导入前需要确认执行。");
  }

  const args = [
    path.join(SKILL_DIR, "merge_training.py"),
    action === "import" ? "--import" : "--dry-run",
    "--target",
    target.trainTaskId,
    "--course-id",
    target.courseId,
    "--mode",
    plan.mode,
  ];

  if (action === "import") {
    args.push("--import-mode", normalizeImportMode(body.importMode));
  }

  plan.sources.forEach((source, index) => {
    args.push(`--source${index + 1}`, source.trainTaskId);
  });

  if (plan.renumber) args.push("--renumber");
  return { args, tempDirs: [] as string[] };
}

function uniqueValues(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map(cleanText).filter(Boolean)));
}

async function resolvePythonBin(): Promise<string> {
  const candidates = uniqueValues([process.env.PYTHON_BIN, process.env.CONDA_PYTHON_EXE, "python3"]);
  const failures: string[] = [];

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["-c", PYTHON_DEPENDENCY_CHECK], {
        timeout: 10 * 1000,
        maxBuffer: 1024 * 1024,
      });
      return candidate;
    } catch (error) {
      const err = error as Error & { stderr?: string };
      failures.push(`${candidate}: ${(err.stderr || err.message).trim()}`);
    }
  }

  const installTarget = candidates[0] || "python3";
  throw new Error(
    [
      `Python 依赖缺失，脚本需要 ${PYTHON_DEPENDENCIES}。`,
      `请执行：${installTarget} -m pip install ${PYTHON_DEPENDENCIES}`,
      "也可以设置 PYTHON_BIN 指向已安装这些依赖的 Python。",
      failures.join("\n"),
    ].join("\n")
  );
}

async function runPython(args: string[], credentials: PolymasCredentials) {
  const pythonBin = await resolvePythonBin();
  try {
    const result = await execFileAsync(pythonBin, args, {
      cwd: SKILL_DIR,
      timeout: 10 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        AUTHORIZATION: credentials.authorization,
        COOKIE: credentials.cookie,
      },
    });
    return {
      ok: true,
      pythonBin,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } catch (error) {
    const err = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      signal?: string;
    };
    return {
      ok: false,
      pythonBin,
      stdout: err.stdout || "",
      stderr: err.stderr || err.message,
      exitCode: err.code,
      signal: err.signal,
    };
  }
}

async function removeTempDirs(tempDirs: string[]) {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
}

function scrubCommand(args: string[], tempDirs: string[], pythonBin: string) {
  return [
    pythonBin,
    ...args.map((item) => {
      if (path.basename(item) === item) return item;
      if (item.startsWith(SKILL_DIR)) return item.replace(SKILL_DIR, "<skill>");
      const tempDir = tempDirs.find((dir) => item.startsWith(dir));
      if (tempDir) return item.replace(tempDir, "<temp>");
      return item;
    }),
  ];
}

export async function POST(request: NextRequest) {
  const tempDirs: string[] = [];
  try {
    const body = (await request.json()) as RequestBody;
    const operation = normalizeOperation(body.operation);
    const action = normalizeAction(body.action);
    if (!operation) {
      return NextResponse.json({ ok: false, error: "不支持的操作类型。" }, { status: 400 });
    }

    const credentials = requireCredentials(body.credentials);

    if (action === "plan") {
      const plan = operation === "split"
        ? await buildSplitPlan(body as SplitRequestBody, credentials)
        : await buildMergePlan(body as MergeRequestBody, credentials);
      return NextResponse.json({ ok: true, operation, plan });
    }

    const built = operation === "split" ? await buildSplitArgs(body as SplitRequestBody, credentials) : buildMergeArgs(body as MergeRequestBody);
    tempDirs.push(...built.tempDirs);

    const result = await runPython(built.args, credentials);
    const status = result.ok ? 200 : 500;

    return NextResponse.json(
      {
        ...result,
        operation,
        command: scrubCommand(built.args, tempDirs, result.pythonBin || process.env.PYTHON_BIN || "python3"),
      },
      { status }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "执行请求失败。";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  } finally {
    await removeTempDirs(tempDirs);
  }
}
