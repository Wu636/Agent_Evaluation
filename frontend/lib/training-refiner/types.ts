export interface TrainingRefineCredentials {
  authorization: string;
  cookie: string;
}

export interface TrainingRefineLlmSettings {
  apiKey?: string;
  apiUrl?: string;
  model?: string;
}

export type TrainingRefineInjectMode = "replace" | "append";

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
}

export interface TrainingRefineApiResponse {
  ok: boolean;
  action: "extract" | "optimize" | "dry-run" | "import";
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
  error?: string;
}
