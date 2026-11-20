export type ImageStrategy = 'regenerate' | 'preserve' | 'missing';
export type PreservedBackground = { cover: Record<string, unknown>; theme: string | null; present: boolean };
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function safeCover(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Existing image reference is not an object');
  const copy = JSON.parse(JSON.stringify(value));
  const inspect = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    for (const [key, child] of Object.entries(v)) {
      if (/^(cookie|authorization|apiKey|__proto__|constructor|prototype)$/i.test(key)) throw new Error('Unsupported existing image metadata');
      inspect(child);
    }
  };
  inspect(copy);
  if (copy.fileId != null && typeof copy.fileId !== 'string') throw new Error('Existing image fileId must be string');
  if (copy.fileUrl != null && (typeof copy.fileUrl !== 'string' || (copy.fileUrl && !/^https?:\/\//.test(copy.fileUrl)))) throw new Error('Existing image URL is unsupported');
  const hasContent = Object.values(copy).some(v => v !== null && v !== undefined && v !== '' && v !== false && v !== 0);
  if (hasContent && !String(copy.fileId || '').trim()) throw new Error('Existing nonempty image reference lacks fileId; cannot preserve safely');
  return copy;
}
export function resolveImagePreservation(strategy: unknown, newSteps: { stepName: string }[], oldSteps: unknown[], taskCover: unknown) {
  if (!['regenerate','preserve','missing'].includes(String(strategy))) throw new Error('imageStrategy must be preserve, missing or regenerate');
  const backgrounds = new Map<string, PreservedBackground>();
  if (strategy === 'regenerate') return { cover: null, backgrounds };
  const names = new Set<string>();
  for (const step of newSteps) {
    const name = String(step.stepName || '').trim();
    if (!name || names.has(name)) throw new Error('Cannot preserve images with ambiguous target stage names');
    names.add(name);
  }
  const oldByName = new Map<string, Record<string, unknown>>();
  for (const raw of oldSteps) {
    const outer = object(raw); const detail = object(outer.stepDetailDTO || outer);
    const name = String(detail.stepName || '').trim();
    if (!names.has(name)) continue;
    if (oldByName.has(name)) throw new Error('Cannot preserve images with ambiguous existing stage names');
    oldByName.set(name, detail);
  }
  for (const name of names) {
    const detail = oldByName.get(name) || {};
    const cover = safeCover(detail.scriptStepCover);
    const ext = object(detail.stepExtProperty);
    const rawTheme = detail.backgroundTheme ?? ext.backgroundTheme ?? null;
    if (rawTheme !== null && typeof rawTheme !== 'string') throw new Error('Unsupported existing background theme');
    const theme = rawTheme as string | null;
    backgrounds.set(name, { cover, theme, present: !!cover.fileId || (!!theme && !['white', 'black', 'default', 'none'].includes(theme.toLowerCase())) });
  }
  const cover = safeCover(taskCover);
  return { cover: cover.fileId ? cover as Record<string, unknown> & {fileId:string;fileUrl:string} : null, backgrounds };
}
