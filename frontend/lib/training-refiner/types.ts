export interface TrainingRefineCredentials {
  authorization: string;
  cookie: string;
}

export interface TrainingRefineLlmSettings {
  apiKey?: string;
  apiUrl?: string;
  model?: string;
  imageModel?: string;
}

export type TrainingRefineInjectMode = "replace" | "append";

export type TrainingRefineStrategy = "incremental" | "template-rebuild";
export type TrainingTemplateMode = "general" | "sequential" | "roleplay" | "summary";

export interface TrainingTemplateModuleDiagnosis {
  id: string;
  title: string;
  recommendedMode: TrainingTemplateMode;
  sourceStepIds: string[];
  objective: string;
  reason: string;
  suggestedRounds: number;
}

export interface TrainingTemplateDiagnosis {
  overallMode: TrainingTemplateMode | "mixed";
  confidence: number;
  reasons: string[];
  currentProblems: string[];
  flowType: "linear" | "graph";
  modules: TrainingTemplateModuleDiagnosis[];
}

export interface TrainingTemplateRewriteOptions {
  strategy: TrainingRefineStrategy;
  mode: TrainingTemplateMode | "auto";
  preserveResources: boolean;
  preservePlatformConfig: boolean;
  rewriteScoring: boolean;
}

export interface TrainingRefineInjectionOptions {
  injectScript: boolean;
  injectRubric: boolean;
  injectMode: TrainingRefineInjectMode;
}

export interface TrainingGraphNodeSummary {
  id: string;
  name: string;
  description: string;
  trainerName: string;
  interactiveRounds: number;
  resourceCount: number;
  outgoing: Array<{
    to: string;
    toName: string;
    condition: string;
    isDefault: boolean;
  }>;
}

export interface TrainingScoreItem {
  itemId?: string;
  itemName: string;
  score: number;
  description: string;
  requireDetail: string;
}

export interface TrainingConfigurationInventory {
  taskFieldCount: number;
  nodeFieldCount: number;
  flowFieldCount: number;
  nodeFieldNames: string[];
  flowFieldNames: string[];
}

export interface TrainingGraphSnapshot {
  taskName: string;
  description: string;
  trainTaskId: string;
  courseId?: string;
  sourceUrl: string;
  nodeCount: number;
  flowCount: number;
  resourceCount: number;
  entryNodeIds: string[];
  exitNodeIds: string[];
  branchNodeIds: string[];
  unreachableNodeIds: string[];
  deadEndNodeIds: string[];
  hasCycle: boolean;
  nodes: TrainingGraphNodeSummary[];
  scoreItems: TrainingScoreItem[];
  scoreTotal: number;
  configurationInventory: TrainingConfigurationInventory;
  warnings: string[];
}

export interface RefinedTrainingNode {
  id: string;
  sourceStepId?: string;
  templateSourceStepId?: string;
  stepName: string;
  description: string;
  trainerName: string;
  prologue: string;
  llmPrompt: string;
  interactiveRounds: number;
  modelId?: string;
  agentId?: string;
  avatarNid?: string;
  templateMode?: TrainingTemplateMode;
  sourceStepIds?: string[];
  resourcePolicy?: "inherit" | "none";
}

export interface RefinedTrainingFlow {
  id: string;
  sourceFlowId?: string;
  from: string;
  to: string;
  condition: string;
  transitionPrompt: string;
  isDefault: boolean;
}

export interface TrainingRefinementPlan {
  taskName: string;
  description: string;
  summary: string;
  architectureRationale: string;
  changes: Array<{
    type: "keep" | "update" | "add" | "remove" | "reconnect";
    target: string;
    reason: string;
  }>;
  nodes: RefinedTrainingNode[];
  flows: RefinedTrainingFlow[];
  scoreItems: TrainingScoreItem[];
  warnings: string[];
  strategy?: TrainingRefineStrategy;
  templateDiagnosis?: TrainingTemplateDiagnosis;
}

export interface TrainingRefineImageOptions {
  generateCover: boolean;
  generateBackgrounds: boolean;
  stylePrompt?: string;
}

export interface TrainingRefineImageAsset {
  fileId: string;
  fileUrl: string;
  contextKey: string;
}

export interface TrainingRefineImageAssets {
  cover?: TrainingRefineImageAsset;
  backgrounds?: Record<string, TrainingRefineImageAsset>;
}

// 只包含实际生图输入，不包含凭证；用于识别旧方案、旧风格或旧模型的图片。
export function refinementImageContextKey(
  plan: TrainingRefinementPlan,
  kind: "cover" | "background",
  nodeId: string | undefined,
  stylePrompt = "",
  imageModel = "",
): string {
  const node = kind === "background" ? plan.nodes.find((item) => item.id === nodeId) : undefined;
  return JSON.stringify([
    "refinement-image-v1", kind, plan.taskName.trim(), plan.description.trim(),
    node?.id || "", node?.stepName.trim() || "", node?.description.trim() || "",
    stylePrompt.trim(), imageModel.trim(),
  ]);
}

export interface TrainingRefineApiResponse {
  ok: boolean;
  action:
    | "extract"
    | "optimize"
    | "analyze-template"
    | "rewrite-template"
    | "dry-run"
    | "import"
    | "generate-image";
  image?: TrainingRefineImageAsset;
  imageKind?: "cover" | "background";
  nodeId?: string;
  source?: TrainingGraphSnapshot;
  plan?: TrainingRefinementPlan;
  validation?: {
    errors: string[];
    warnings: string[];
  };
  stdout?: string;
  stderr?: string;
  command?: string[];
  modelUsed?: string;
  inputChars?: number;
  diagnosis?: TrainingTemplateDiagnosis;
  templateModulePlan?: import("@/lib/training-generator/types").TrainingScriptPlan;
  error?: string;
}
