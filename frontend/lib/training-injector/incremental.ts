import { createHash } from 'node:crypto';

export type JsonObject = Record<string, unknown>;
export interface IncrementalStep extends JsonObject {
  stepId: string;
  stepDetailDTO: JsonObject;
  positionDTO: { x: number; y: number };
}
export interface IncrementalSnapshot {
  trainTaskId: string;
  type: 'ability' | 'oral';
  steps: IncrementalStep[];
  flows: JsonObject[];
}
export const TEXT_FIELDS = ['prologue', 'description', 'llmPrompt'] as const;
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value as JsonObject).sort().map(k => JSON.stringify(k) + ':' + canonical((value as JsonObject)[k])).join(',') + '}';
}
export function fingerprint(snapshot: IncrementalSnapshot): string {
  // The service rewrites this timestamp after editScriptStepDetailDTO. Exclude
  // only this known metadata path, not similarly named fields in resources,
  // flows or other business data. Keep the original DTO intact for writes.
  const comparable = structuredClone(snapshot);
  for (const step of comparable.steps) delete step.stepDetailDTO.updateTime;
  return createHash('sha256').update(canonical(comparable)).digest('hex');
}
/** Translate read-side flat resources to the write contract without dropping IDs or metadata. */
export function resourcePreservingDetail(input: JsonObject): JsonObject {
  const detail = structuredClone(input);
  const flat = detail.scriptStepResourceList;
  if (!Array.isArray(flat)) throw new Error('阶段附件列表结构未知，拒绝写入');
  const ext = detail.stepExtProperty;
  if (ext !== null && ext !== undefined && (typeof ext !== 'object' || Array.isArray(ext))) throw new Error('阶段资源扩展结构未知，拒绝写入');
  const property = (ext || {}) as JsonObject;
  const groups: JsonObject[] = [];
  // The service occasionally reads an unmaterialized category row as a flat
  // placeholder, then writes it back as an empty nested list.  Recognize only
  // that exact shape; never drop a row carrying an ID or any real metadata.
  const knownResourceKeys = ['scriptStepResourceId', 'trainTaskId', 'scriptStepId', 'sort', 'fileId', 'contentType', 'type', 'category', 'resourceTypeNid', 'description', 'fileUrl', 'fileName', 'thumbnail', 'isRequired', 'studied'];
  const isEmptyPlaceholder = (resource: JsonObject) => {
    const unknown = Object.keys(resource).filter(key => !knownResourceKeys.includes(key));
    if (typeof resource.category !== 'string' || typeof resource.resourceTypeNid !== 'string') return false;
    let empty = true;
    for (const key of knownResourceKeys) {
      if (key === 'category' || key === 'resourceTypeNid') continue;
      if (Object.hasOwn(resource, key) && resource[key] !== null) empty = false;
    }
    // Unknown metadata is retained on real entities, but an empty category
    // placeholder must be exact and cannot smuggle unknown fields.
    if (empty && unknown.length) throw new Error('阶段附件空占位包含未知字段，拒绝写入');
    return empty && !unknown.length;
  };
  const normalized = (list: unknown[]) => list.filter(resource => !isEmptyPlaceholder(resource as JsonObject));
  for (const resource of flat) {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) throw new Error('阶段附件结构未知，拒绝写入');
    const item = resource as JsonObject;
    const { resourceTypeNid: nid, category } = item;
    if (typeof nid !== 'string' || typeof category !== 'string') throw new Error('阶段附件分类缺失，拒绝猜测资源分组');
    let group = groups.find(g => g.nid === nid && g.category === category);
    if (!group) { group = { nid, category, list: [] }; groups.push(group); }
    if (!isEmptyPlaceholder(item)) (group.list as unknown[]).push(structuredClone(item));
  }
  if (property.resources != null) {
    // Preserve existing group metadata only when the two read representations agree exactly.
    if (!Array.isArray(property.resources)) throw new Error('阶段资源分组结构未知，拒绝写入');
    const nested: unknown[] = [];
    for (const group of property.resources) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.list) || typeof group.nid !== 'string' || typeof group.category !== 'string') throw new Error('阶段资源分组结构未知，拒绝写入');
      for (const resource of group.list) {
        if (!resource || typeof resource !== 'object' || Array.isArray(resource)) throw new Error('阶段附件结构未知，拒绝写入');
        const item = resource as JsonObject;
        if (item.resourceTypeNid !== group.nid || item.category !== group.category) throw new Error('阶段资源分类不一致，拒绝写入');
        // Reuse the strict field/placeholder validator for nested entities too.
        isEmptyPlaceholder(item);
        nested.push(item);
      }
    }
    const flatComparable = normalized(flat).map(canonical).sort();
    const nestedComparable = normalized(nested).map(canonical).sort();
    if (canonical(nestedComparable) !== canonical(flatComparable)) throw new Error('阶段附件双重表示不一致，拒绝写入');
    for (const group of groups) {
      if (!property.resources.some(existing => existing.nid === group.nid && existing.category === group.category)) throw new Error('阶段附件分类双重表示不一致，拒绝写入');
    }
    for (const group of property.resources) group.list = normalized(group.list);
  } else {
    property.resources = groups;
  }
  detail.stepExtProperty = property;
  return detail;
}
export function assertSnapshot(value: IncrementalSnapshot): void {
  if (!value || !value.trainTaskId || !['ability', 'oral'].includes(value.type) || !Array.isArray(value.steps) || !value.steps.length || !Array.isArray(value.flows) || !value.flows.length) throw new Error('需要完整非空节点/连线快照；查询失败或缺失连线不能增量写入');
  if (Object.keys(value).some(k => !['trainTaskId','type','steps','flows'].includes(k))) throw new Error('快照包含未支持的顶层字段');
  const ids = new Set<string>();
  let content = 0;
  for (const step of value.steps) {
    if (!step.stepId || ids.has(step.stepId) || !step.stepDetailDTO || !step.positionDTO || !Number.isFinite(Number(step.positionDTO.x)) || !Number.isFinite(Number(step.positionDTO.y))) throw new Error('节点ID/原始DTO/位置无效或重复');
    ids.add(step.stepId);
    if (step.stepDetailDTO.nodeType === 'SCRIPT_NODE') content++;
  }
  if (!content) throw new Error('没有可更新的阶段');
  for (const flow of value.flows) {
    if (!flow.flowId || !ids.has(String(flow.scriptStepStartId)) || !ids.has(String(flow.scriptStepEndId))) throw new Error('连线缺ID或引用未知节点');
  }
}
const BACKGROUND_FIELDS = ['scriptStepCover', 'backgroundTheme', 'scriptBackgroundType'] as const;
const STRATEGY_FIELDS = ['endStrategy', 'interactiveRounds', 'trainTime'] as const;
function objectRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function strippedDetail(detail: JsonObject, type: 'ability' | 'oral', backgroundChanged: boolean, strategyChanged: boolean): JsonObject {
  const copy = structuredClone(detail);
  for (const key of TEXT_FIELDS) delete copy[key];
  if (strategyChanged) for (const key of STRATEGY_FIELDS) delete copy[key];
  if (backgroundChanged) {
    for (const key of BACKGROUND_FIELDS) delete copy[key];
    if (objectRecord(copy.stepExtProperty)) {
      delete copy.stepExtProperty[type === 'oral' ? 'backgroundTheme' : 'bgMediaType'];
      if (!Object.keys(copy.stepExtProperty).length) delete copy.stepExtProperty;
    } else if (copy.stepExtProperty == null) delete copy.stepExtProperty;
  }
  return copy;
}
/** Validate complete background/ending groups and return exact changed paths; never mutates inputs. */
export function validateIncrementalDetailChange(before: JsonObject, after: JsonObject, type: 'ability' | 'oral'): string[] {
  if (!['ability', 'oral'].includes(type)) throw new Error('阶段类型不支持增量');
  const fields: string[] = TEXT_FIELDS.filter(key => canonical(before[key] ?? '') !== canonical(after[key] ?? ''));
  if (fields.some(key => typeof after[key] !== 'string')) throw new Error('修改文本必须显式提供字符串，不能删除字段');
  for (const key of TEXT_FIELDS) if (key in after && typeof after[key] !== 'string') throw new Error('增量文本字段必须为字符串');
  const extKey = type === 'oral' ? 'backgroundTheme' : 'bgMediaType';
  const oldExt = before.stepExtProperty, newExt = after.stepExtProperty;
  const extChanged = canonical(objectRecord(oldExt) ? oldExt[extKey] : undefined) !== canonical(objectRecord(newExt) ? newExt[extKey] : undefined);
  const backgroundFields = BACKGROUND_FIELDS.filter(key => canonical(before[key]) !== canonical(after[key]));
  const backgroundChanged = backgroundFields.length > 0 || extChanged;
  if (backgroundChanged) {
    if ((oldExt != null && !objectRecord(oldExt)) || !objectRecord(newExt)) throw new Error('阶段背景扩展结构未知或不完整');
    const cover = after.scriptStepCover;
    if (!objectRecord(cover) || typeof cover.fileId !== 'string' || !cover.fileId.trim() || typeof cover.fileUrl !== 'string' || !cover.fileUrl.trim()) throw new Error('阶段背景必须提供完整fileId/fileUrl');
    let url: URL;
    try { url = new URL(cover.fileUrl); } catch { throw new Error('阶段背景URL无效'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('阶段背景URL不安全');
    if (after.backgroundTheme !== cover.fileId || canonical(after.scriptBackgroundType) !== canonical(before.scriptBackgroundType) || (type === 'oral' ? newExt.backgroundTheme !== cover.fileId : newExt.bgMediaType !== 1)) throw new Error('阶段背景字段组不完整或不一致');
    if ('fileName' in cover && cover.fileName !== null && typeof cover.fileName !== 'string') throw new Error('阶段背景fileName必须为字符串');
    // Only the three known file-reference fields may change; retain opaque metadata exactly.
    const oldCover = before.scriptStepCover;
    if (oldCover != null && !objectRecord(oldCover)) throw new Error('阶段原背景结构未知');
    const a = structuredClone(oldCover || {}) as JsonObject, b = structuredClone(cover);
    for (const key of ['fileId', 'fileUrl']) { delete a[key]; delete b[key]; }
    if (canonical(a) !== canonical(b)) throw new Error('阶段背景未知元数据变化');
    fields.push(...backgroundFields);
    if (extChanged) fields.push(`stepExtProperty.${extKey}`);
  }
  const strategyFields = STRATEGY_FIELDS.filter(key => canonical(before[key]) !== canonical(after[key]));
  if (strategyFields.length) {
    const { endStrategy, interactiveRounds, trainTime } = after;
    const integer = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
    const valid = endStrategy === 2
      ? integer(interactiveRounds, 0, 30) && trainTime === -1
      : endStrategy === 0 && interactiveRounds === -1 && (trainTime === -1 || integer(trainTime, 1, 480));
    if (!valid) throw new Error('阶段结束策略三元组不完整或轮次/时长无效');
    fields.push(...strategyFields);
  }
  if (canonical(strippedDetail(before, type, backgroundChanged, !!strategyFields.length)) !== canonical(strippedDetail(after, type, backgroundChanged, !!strategyFields.length))) throw new Error('阶段非授权字段变化；拒绝自动fresh');
  return fields;
}
export function planIncremental(base: IncrementalSnapshot, desired: IncrementalSnapshot) {
  assertSnapshot(base); assertSnapshot(desired);
  if (base.trainTaskId !== desired.trainTaskId || base.type !== desired.type || base.steps.length !== desired.steps.length || canonical(base.flows) !== canonical(desired.flows)) throw new Error('目标、阶段数量或拓扑变化不支持增量更新');
  const changes: { stepId: string; stepName: string; fields: string[]; step: IncrementalStep }[] = [];
  for (let i = 0; i < base.steps.length; i++) {
    const before = base.steps[i], after = desired.steps[i];
    const a = structuredClone(before), b = structuredClone(after);
    const fields = validateIncrementalDetailChange(before.stepDetailDTO, after.stepDetailDTO, base.type);
    if (fields.length && before.stepDetailDTO.nodeType !== 'SCRIPT_NODE') throw new Error('不能修改开始/结束节点');
    // The helper proved all remaining detail paths equal; outer identity/position stays exact.
    a.stepDetailDTO = {}; b.stepDetailDTO = {};
    if (canonical(a) !== canonical(b)) throw new Error('阶段ID/顺序/位置变化；拒绝自动fresh');
    if (fields.length) changes.push({ stepId: before.stepId, stepName: String(before.stepDetailDTO.stepName), fields, step: after });
  }
  return { baseFingerprint: fingerprint(base), desiredFingerprint: fingerprint(desired), changes };
}

export function planControlTokenNormalization(base: IncrementalSnapshot) {
  assertSnapshot(base);
  if (base.trainTaskId !== 'LpIITNFm95atHPjt' || base.type !== 'ability') throw new Error('控制词修复仅允许明确授权的精密度任务');
  const nodes = base.steps.filter(s => s.stepDetailDTO.nodeType === 'SCRIPT_NODE');
  const changes: { index: number; flow: JsonObject }[] = [];
  if (nodes.length !== 6) throw new Error('控制词修复需要六个阶段');
  let jumps = 0, endings = 0;
  for (const node of nodes) {
    const outgoing = base.flows.map((flow, index) => ({ flow, index })).filter(x => x.flow.scriptStepStartId === node.stepId);
    if (outgoing.length !== 1) throw new Error('控制词修复拒绝分支或缺失连线');
    const { flow, index } = outgoing[0];
    const end = base.steps.find(s => s.stepId === flow.scriptStepEndId);
    const token = end?.stepDetailDTO.nodeType === 'SCRIPT_END' ? '本次实训到此结束' : end?.stepDetailDTO.nodeType === 'SCRIPT_NODE' ? '接下来我们将进入下一阶段' : '';
    const wrapped = '`' + token + '`';
    if (!token || flow.trainTaskId !== base.trainTaskId || flow.flowCondition !== wrapped) throw new Error('连线控制词与授权修复不一致');
    const edited = structuredClone(flow);
    const config = edited.flowConfiguration as { conditions?: { conditions?: JsonObject[] }[] };
    if (!config || config.conditions?.length !== 1 || config.conditions[0].conditions?.length !== 1) throw new Error('连线条件结构未知');
    const leaf = config.conditions[0].conditions[0];
    if (leaf.text !== wrapped || 'conditions' in leaf) throw new Error('连线叶控制词不一致');
    edited.flowCondition = token; leaf.text = token;
    if (token === '本次实训到此结束') endings++; else jumps++;
    changes.push({ index, flow: edited });
  }
  if (jumps !== 5 || endings !== 1) throw new Error('控制词修复要求五跳转一结束');
  return changes;
}

export async function normalizeControlTokens(base: IncrementalSnapshot, expectedFingerprint: string, io: {
  read: () => Promise<IncrementalSnapshot>; editFlow: (flow: JsonObject) => Promise<boolean>;
}) {
  const changes = planControlTokenNormalization(base);
  if (fullSnapshotFingerprint(base) !== expectedFingerprint) throw new Error('快照完整指纹不一致');
  const expected = structuredClone(base), applied: unknown[] = [];
  for (const change of changes) {
    let fresh: IncrementalSnapshot;
    try { fresh = await io.read(); assertSnapshot(fresh); }
    catch { return { success: false, applied, reason: 'readback-unavailable', reconciliationRequired: true, atomic: false }; }
    if (fullSnapshotFingerprint(fresh) !== fullSnapshotFingerprint(expected)) return { success: false, applied, reason: 'concurrent-change', reconciliationRequired: true, atomic: false };
    let ok = false;
    try { ok = await io.editFlow(structuredClone(change.flow)); } catch { /* do not retry */ }
    if (!ok) return { success: false, applied, failedFlowId: change.flow.flowId, reason: 'write-outcome-unknown', reconciliationRequired: true, atomic: false };
    applied.push(change.flow.flowId);expected.flows[change.index] = structuredClone(change.flow);
    let after: IncrementalSnapshot;
    try { after = await io.read(); assertSnapshot(after); }
    catch { return { success: false, applied, reason: 'readback-unavailable', reconciliationRequired: true, atomic: false }; }
    if (fullSnapshotFingerprint(after) !== fullSnapshotFingerprint(expected)) return { success: false, applied, failedFlowId: change.flow.flowId, reason: 'post-write-mismatch', reconciliationRequired: true, atomic: false };
  }
  return { success: true, mode: 'normalize-control-tokens', applied, verified: true, atomic: false, reconciliationRequired: false, resultFingerprint: fullSnapshotFingerprint(expected) };
}

export function fullSnapshotFingerprint(snapshot: IncrementalSnapshot): string {
  return createHash('sha256').update(canonical(snapshot)).digest('hex');
}

/** Explicit reconciliation only: restore one emptied list from a matching original snapshot. */
export async function restoreResources(expected: IncrementalSnapshot, original: IncrementalSnapshot,
  stepId: string, expectedFingerprint: string, io: {
    read: () => Promise<IncrementalSnapshot>; edit: (step: IncrementalStep) => Promise<boolean>;
  }) {
  assertSnapshot(expected); assertSnapshot(original);
  if (fullSnapshotFingerprint(expected) !== expectedFingerprint) throw new Error('快照完整指纹不一致');
  const currentStep = expected.steps.find(s => s.stepId === stepId);
  const sourceStep = original.steps.find(s => s.stepId === stepId);
  if (!currentStep || !sourceStep || currentStep.stepDetailDTO.nodeType !== 'SCRIPT_NODE') throw new Error('恢复目标阶段无效');
  const empty = currentStep.stepDetailDTO.scriptStepResourceList;
  const resources = sourceStep.stepDetailDTO.scriptStepResourceList;
  if (!Array.isArray(empty) || empty.length || !Array.isArray(resources) || !resources.length) throw new Error('仅支持从原始快照恢复已清空的阶段附件');
  // Prove the source differs only by this node's text, timestamp and lost list.
  const a = structuredClone(expected), b = structuredClone(original);
  for (const snapshot of [a, b]) {
    const detail = snapshot.steps.find(s => s.stepId === stepId)!.stepDetailDTO;
    for (const key of [...TEXT_FIELDS, 'updateTime', 'scriptStepResourceList']) delete detail[key];
  }
  if (canonical(a) !== canonical(b)) throw new Error('原始快照与当前快照有恢复范围外变化，拒绝恢复');
  const desired = structuredClone(expected);
  const restoreStep = desired.steps.find(s => s.stepId === stepId)!;
  restoreStep.stepDetailDTO.scriptStepResourceList = structuredClone(resources);
  const payload = structuredClone(restoreStep);
  payload.stepDetailDTO = resourcePreservingDetail(payload.stepDetailDTO);
  // Full hash includes timestamps; even metadata drift requires an explicitly refreshed expectation.
  for (let i = 0; i < 2; i++) {
    const fresh = await io.read(); assertSnapshot(fresh);
    if (fullSnapshotFingerprint(fresh) !== expectedFingerprint) throw new Error('CONFLICT: 恢复前完整快照已变化');
  }
  let ok = false;
  try { ok = await io.edit(payload); } catch { /* outcome unknown, never retry */ }
  if (!ok) return { success: false, mode: 'restore-resources', applied: [], failedStepId: stepId, reason: 'write-outcome-unknown', reconciliationRequired: true, atomic: false };
  let after: IncrementalSnapshot;
  try { after = await io.read(); assertSnapshot(after); }
  catch { return { success: false, mode: 'restore-resources', applied: [stepId], reason: 'readback-unavailable', reconciliationRequired: true, atomic: false }; }
  // Only the repaired node's server timestamp may change. No resource IDs are ignored.
  const comparable = structuredClone(after), wanted = structuredClone(desired);
  delete comparable.steps.find(s => s.stepId === stepId)?.stepDetailDTO.updateTime;
  delete wanted.steps.find(s => s.stepId === stepId)?.stepDetailDTO.updateTime;
  const verified = canonical(comparable) === canonical(wanted);
  return { success: verified, mode: 'restore-resources', applied: [stepId], verified,
    reason: verified ? undefined : 'post-write-mismatch', reconciliationRequired: !verified, atomic: false,
    resultFingerprint: fullSnapshotFingerprint(after) };
}

export function verifyBindingRefresh(expected: IncrementalSnapshot, actual: IncrementalSnapshot, stepId: string) {
  const wanted = structuredClone(expected), comparable = structuredClone(actual);
  const a = wanted.steps.find(s => s.stepId === stepId)?.stepDetailDTO;
  const b = comparable.steps.find(s => s.stepId === stepId)?.stepDetailDTO;
  const mappings: { stepId: string; index: number; oldId: unknown; newId: string }[] = [];
  if (!a || !b || !Array.isArray(a.scriptStepResourceList) || !Array.isArray(b.scriptStepResourceList) || a.scriptStepResourceList.length !== b.scriptStepResourceList.length) return { verified: false, mappings };
  const ids = new Set<string>();
  for (let i = 0; i < a.scriptStepResourceList.length; i++) {
    const before = a.scriptStepResourceList[i], after = b.scriptStepResourceList[i];
    if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return { verified: false, mappings };
    const id = after.scriptStepResourceId;
    if (typeof id !== 'string' || !id.trim() || ids.has(id)) return { verified: false, mappings };
    ids.add(id);
    mappings.push({ stepId, index: i, oldId: before.scriptStepResourceId, newId: id });
    // Only this exact field in this just-written node may be server assigned.
    delete before.scriptStepResourceId; delete after.scriptStepResourceId;
  }
  delete a.updateTime; delete b.updateTime;
  return { verified: canonical(wanted) === canonical(comparable), mappings };
}

/** Non-transactional optimistic preflight; never claims atomic CAS or retries writes. */
export async function applyIncremental(base: IncrementalSnapshot, desired: IncrementalSnapshot, io: {
  read: () => Promise<IncrementalSnapshot>;
  edit: (step: IncrementalStep) => Promise<boolean>;
}, apply = false, options: { allowResourceBindingIdRefresh?: boolean } = {}) {
  const plan = planIncremental(base, desired);
  const current = await io.read(); assertSnapshot(current);
  const preconditionFingerprint = options.allowResourceBindingIdRefresh === true ? fullSnapshotFingerprint : fingerprint;
  if (preconditionFingerprint(current) !== preconditionFingerprint(base)) throw new Error('CONFLICT: 平台在基线后已变化，请重新拉取，不自动覆盖');
  const summary = plan.changes.map(({stepId,stepName,fields}) => ({stepId,stepName,fields}));
  if (!apply) return { success: true, mode: 'preflight', changes: summary, applied: [] as string[], baseFingerprint: plan.baseFingerprint, atomic: false };
  const applied: string[] = [];
  const resourceBindingIdMappings: { stepId: string; index: number; oldId: unknown; newId: string }[] = [];
  let expected = structuredClone(base);
  for (const change of plan.changes) {
    // Check all preconditions before any write, and recheck before each subsequent write.
    let fresh: IncrementalSnapshot;
    try { fresh = await io.read(); assertSnapshot(fresh); }
    catch { return { success: false, mode: 'apply', applied, failedStepId: change.stepId, reason: 'readback-unavailable', reconciliationRequired: true, atomic: false, resourceBindingIdMappings }; }
    if (preconditionFingerprint(fresh) !== preconditionFingerprint(expected)) return { success: false, mode: 'apply', applied, failedStepId: change.stepId, reason: 'concurrent-change', reconciliationRequired: true, atomic: false, resourceBindingIdMappings };
    let ok = false;
    const expectedStep = structuredClone(change.step);
    try { ok = await io.edit(structuredClone(change.step)); }
    catch { /* write may have reached the service: do not retry */ }
    if (!ok) return { success: false, mode: 'apply', applied, failedStepId: change.stepId, reason: 'write-outcome-unknown', reconciliationRequired: true, atomic: false, resourceBindingIdMappings };
    applied.push(change.stepId);
    expected.steps = expected.steps.map(s => s.stepId === change.stepId ? expectedStep : s);
    // A successful edit response does not guarantee preservation. Verify immediately,
    // including every non-text field, before considering another node for writing.
    let readback: IncrementalSnapshot;
    try { readback = await io.read(); assertSnapshot(readback); }
    catch { return { success: false, mode: 'apply', applied, failedStepId: change.stepId, reason: 'readback-unavailable', reconciliationRequired: true, atomic: false, resourceBindingIdMappings }; }
    const refresh = options.allowResourceBindingIdRefresh === true ? verifyBindingRefresh(expected, readback, change.stepId) : null;
    if (refresh) resourceBindingIdMappings.push(...refresh.mappings);
    if (refresh ? !refresh.verified : fingerprint(readback) !== fingerprint(expected)) return { success: false, mode: 'apply', applied, failedStepId: change.stepId, reason: 'post-write-mismatch', reconciliationRequired: true, atomic: false, resourceBindingIdMappings };
    // Adopt only a fully verified readback; the next preflight still compares real IDs.
    expected = structuredClone(readback);
  }
  let final: IncrementalSnapshot;
  try { final = await io.read(); assertSnapshot(final); }
  catch { return { success: false, mode: 'apply', applied, reason: 'readback-unavailable', reconciliationRequired: true, atomic: false, resourceBindingIdMappings }; }
  const verified = preconditionFingerprint(final) === preconditionFingerprint(expected);
  return { success: verified, mode: 'apply', changes: summary, applied, verified, reconciliationRequired: !verified, atomic: false, baseFingerprint: plan.baseFingerprint, resultFingerprint: fingerprint(final), resourceBindingIdMappings };
}
