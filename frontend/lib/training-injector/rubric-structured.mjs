import { createHash } from 'node:crypto';

const FIELDS = ['itemName', 'score', 'description', 'requireDetail'];
// Only identities and platform bookkeeping are known non-rule metadata. Unknown platform fields disable the shortcut.
const RAW_FIELDS = new Set([...FIELDS, 'itemId', 'trainTaskId', 'realTime']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const miss = reason => ({ ok: false, reason });
export const rubricHash = markdown => createHash('sha256').update(String(markdown), 'utf8').digest('hex');

export function validateScoreItems(value, { raw = false } = {}) {
  if (!Array.isArray(value) || value.length === 0) return miss('empty-or-invalid-items');
  const names = new Set();
  const items = [];
  for (const item of value) {
    if (!object(item) || Object.keys(item).some(key => !(raw ? RAW_FIELDS : new Set(FIELDS)).has(key))) return miss('unknown-item-fields');
    if (typeof item.itemName !== 'string' || !item.itemName.trim() || item.itemName !== item.itemName.trim()) return miss('invalid-name');
    if (names.has(item.itemName)) return miss('duplicate-name');
    if (typeof item.score !== 'number' || !Number.isFinite(item.score) || item.score < 0) return miss('invalid-score');
    if (typeof item.description !== 'string' || !item.description.trim() || typeof item.requireDetail !== 'string' || !item.requireDetail.trim()) return miss('missing-rule-text');
    names.add(item.itemName);
    items.push(Object.fromEntries(FIELDS.map(key => [key, item[key]])));
  }
  return { ok: true, items };
}

/** Deliberately small grammar. Every non-format byte must belong to a DTO field. */
export function parseRubricDeterministic(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return miss('empty-markdown');
  const text = markdown.replace(/\r\n/g, '\n').trim();
  if (/```|~~~/.test(text)) return miss('ambiguous-fenced-content');
  const header = /^## ([^\n]+?)[（(](\d+(?:\.\d+)?)\s*分[）)]\s*$/gm;
  const matches = [...text.matchAll(header)];
  if (!matches.length) return miss('no-explicit-score-headings');
  const prefix = text.slice(0, matches[0].index).trim();
  // Only a neutral document title and optional total heading may precede items.
  const prefixMatch = /^(?:# (?:评价标准|评分标准)\s*)?(?:## 总分[：:]\s*(\d+(?:\.\d+)?)\s*分\s*)?$/.exec(prefix);
  if (!prefixMatch) return miss('unassigned-global-rules');
  const items = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    let body = text.slice(match.index + match[0].length, matches[i + 1]?.index ?? text.length).trim();
    // A separator between sections is format, not a scoring rule.
    if (i < matches.length - 1) body = body.replace(/\n\s*---\s*$/, '').trim();
    if (/^#{1,2}\s/m.test(body)) return miss('unassigned-section');
    const descMarkers = [...body.matchAll(/\*\*评价描述[：:]\*\*/g)];
    const ruleMarkers = [...body.matchAll(/\*\*评分区间[：:]\*\*/g)];
    if (descMarkers.length !== 1 || ruleMarkers.length !== 1 || descMarkers[0].index !== 0 || ruleMarkers[0].index <= descMarkers[0].index) return miss('ambiguous-field-markers');
    const description = body.slice(descMarkers[0][0].length, ruleMarkers[0].index).trim();
    const requireDetail = body.slice(ruleMarkers[0].index + ruleMarkers[0][0].length).trim();
    items.push({ itemName: match[1].trim(), score: Number(match[2]), description, requireDetail });
  }
  const validated = validateScoreItems(items);
  if (!validated.ok) return validated;
  if (prefixMatch[1] !== undefined && Math.abs(Number(prefixMatch[1]) - items.reduce((n, item) => n + item.score, 0)) > 1e-8) return miss('total-score-mismatch');
  return { ok: true, items };
}

export function createRubricSidecar(markdown, rawScoreItems, sourceTaskId) {
  // Keep the full source structure even when a later shortcut cannot safely consume it.
  return { version: 1, rubricHash: rubricHash(markdown), sourceTaskId: String(sourceTaskId || ''), rawScoreItems: JSON.parse(JSON.stringify(rawScoreItems)) };
}

export function resolveRubricFastPath(markdown, sidecar) {
  if (sidecar !== undefined && sidecar !== null) {
    if (!object(sidecar) || Object.keys(sidecar).some(key => !['version', 'rubricHash', 'sourceTaskId', 'rawScoreItems'].includes(key)) || sidecar.version !== 1 || typeof sidecar.sourceTaskId !== 'string') return { ...miss('invalid-sidecar'), blocked: true };
    if (sidecar.rubricHash === rubricHash(markdown)) {
      const validated = validateScoreItems(sidecar.rawScoreItems, { raw: true });
      return validated.ok ? { ...validated, source: 'platform-sidecar' } : { ...validated, blocked: true };
    }
    // Edited Markdown invalidates the original source; only parse the current text.
  }
  const parsed = parseRubricDeterministic(markdown);
  return parsed.ok ? { ...parsed, source: 'deterministic-markdown' } : parsed;
}

export function compareScoreItemsExact(expected, actual) {
  const left = validateScoreItems(expected);
  const right = validateScoreItems(actual, { raw: true });
  if (!left.ok || !right.ok) return { ok: false, reason: !left.ok ? 'invalid-expected:' + left.reason : 'invalid-actual:' + right.reason, differences: [] };
  const actualByName = new Map(right.items.map(item => [item.itemName, item]));
  const differences = [];
  for (const item of left.items) {
    const found = actualByName.get(item.itemName);
    if (!found) { differences.push({ itemName: item.itemName, field: 'itemName', kind: 'missing' }); continue; }
    for (const key of FIELDS) if (item[key] !== found[key]) differences.push({ itemName: item.itemName, field: key, kind: 'changed' });
  }
  const expectedNames = new Set(left.items.map(item => item.itemName));
  for (const item of right.items) if (!expectedNames.has(item.itemName)) differences.push({ itemName: item.itemName, field: 'itemName', kind: 'unexpected' });
  return { ok: differences.length === 0, differences };
}
