export interface StructuredScoreItem { itemName: string; score: number; description: string; requireDetail: string; }
export type RubricResult = { ok: true; items: StructuredScoreItem[]; source?: 'platform-sidecar' | 'deterministic-markdown' } | { ok: false; reason: string; blocked?: boolean };
export interface RubricSidecar { version: 1; rubricHash: string; sourceTaskId: string; rawScoreItems: unknown; }
export function rubricHash(markdown: string): string;
export function validateScoreItems(value: unknown, options?: {raw?: boolean}): RubricResult;
export function parseRubricDeterministic(markdown: string): RubricResult;
export function createRubricSidecar(markdown: string, rawScoreItems: unknown, sourceTaskId: string): RubricSidecar;
export function resolveRubricFastPath(markdown: string, sidecar?: unknown): RubricResult;
export function compareScoreItemsExact(expected: unknown, actual: unknown): {ok: boolean; reason?: string; differences: Array<{itemName: string; field: string; kind: string}>};
