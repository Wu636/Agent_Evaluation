import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

export type PreparedImage = { fileId: string; fileUrl: string };
export type ImagePreparationResult = { id: string; image: PreparedImage | null; cache: 'hit' | 'miss' | 'shared' | 'disabled'; durationMs: number; queueMs: number; failed: boolean };
export type ImagePreparationJob = { id: string; fingerprint: unknown; generate: () => Promise<PreparedImage | null> };
const salt = randomBytes(32);
const cache = new Map<string, { image: PreparedImage; expires: number }>();
const inFlight = new Map<string, Promise<PreparedImage | null>>();
const TTL = 30 * 60 * 1000;
const MAX_ENTRIES = 256;

/** No credentials, source prompts or account IDs are retained in cache keys/diagnostics. */
export function imagePreparationScope(input: { userId?: string; courseId: string; taskId: string; apiOrigin?: string; authorization: string; cookie: string; generationKey?: string }): string {
  // Stable authenticated sessions can reuse their own results even without userNid.
  // With no session identity at all, isolate the request rather than share anonymously.
  const identity = input.userId?.trim() || (input.authorization || input.cookie ? 'session' : randomUUID());
  return createHmac('sha256', salt).update(JSON.stringify([identity, input.courseId, input.taskId, input.apiOrigin || '', input.authorization, input.cookie, input.generationKey || ''])).digest('hex');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
function valid(image: PreparedImage | null): image is PreparedImage {
  return !!image && typeof image.fileId === 'string' && !!image.fileId.trim() && typeof image.fileUrl === 'string' && /^https?:\/\//.test(image.fileUrl);
}

/** Per-request bounded preparation. Node writes remain the caller's responsibility.
 * Successful uploads are cached in process memory only; failures are never cached or retried.
 * Re-requesting only failed IDs therefore does not regenerate successful images.
 */
export function prepareImages(jobs: ImagePreparationJob[], options: {
  scope: string; concurrency?: number; cacheMode?: 'reuse' | 'refresh' | 'off'; refreshIds?: string[];
  onResult?: (result: ImagePreparationResult) => void;
}) {
  const concurrency = options.concurrency ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('imageConcurrency must be an integer from 1 to 8');
  if (!['reuse', 'refresh', 'off'].includes(options.cacheMode || 'reuse')) throw new Error('Invalid imageCacheMode');
  if (!options.scope || new Set(jobs.map(j => j.id)).size !== jobs.length) throw new Error('Image scope and unique job IDs are required');
  if (options.refreshIds?.some(id => !jobs.some(j => j.id === id))) throw new Error('Unknown imageRefreshIds');
  const mode = options.cacheMode || 'reuse';
  const queuedAt = Date.now();
  for (const [key, entry] of cache) if (entry.expires <= queuedAt) cache.delete(key);
  const resolvers = new Map<string, (result: ImagePreparationResult) => void>();
  const results = new Map(jobs.map(job => [job.id, new Promise<ImagePreparationResult>(resolve => resolvers.set(job.id, resolve))]));
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const startedAt = Date.now();
      const key = createHash('sha256').update(options.scope + canonical({ version: 1, id: job.id, input: job.fingerprint })).digest('hex');
      let source: ImagePreparationResult['cache'] = mode === 'off' ? 'disabled' : 'miss';
      let image: PreparedImage | null = null;
      const refresh = mode === 'refresh' || options.refreshIds?.includes(job.id);
      if (refresh) cache.delete(key);
      try {
        const entry = !refresh && mode !== 'off' ? cache.get(key) : undefined;
        if (entry && entry.expires > Date.now()) { image = { ...entry.image }; source = 'hit'; }
        else {
          let pending = mode !== 'off' ? inFlight.get(key) : undefined;
          if (pending) source = 'shared';
          else {
            pending = Promise.resolve().then(job.generate).then(value => valid(value) ? { fileId: value.fileId, fileUrl: value.fileUrl } : null);
            if (mode !== 'off') inFlight.set(key, pending);
          }
          try { image = await pending; }
          finally { if (inFlight.get(key) === pending) inFlight.delete(key); }
          if (image && mode !== 'off') {
            while (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
            cache.set(key, { image: { ...image }, expires: Date.now() + TTL });
          }
        }
      } catch { /* Do not surface provider errors that could contain sensitive headers. */ }
      const result: ImagePreparationResult = { id: job.id, image, cache: source, durationMs: Date.now() - startedAt, queueMs: startedAt - queuedAt, failed: !image };
      resolvers.get(job.id)!(result);
      try { options.onResult?.(result); } catch { /* diagnostics cannot break preparation */ }
    }
  };
  const done = Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker)).then(() => Promise.all([...results.values()]));
  return { results, done };
}
