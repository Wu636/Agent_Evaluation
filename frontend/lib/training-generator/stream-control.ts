export class TrainingStreamTimeoutError extends Error {
    readonly retryable = true;

    constructor(message: string) {
        super(message);
        this.name = 'TrainingStreamTimeoutError';
    }
}

interface TrainingStreamControl {
    signal?: AbortSignal;
    firstTokenTimeoutMs?: number;
    idleTimeoutMs?: number;
    timeoutMs?: number;
    progressIntervalMs?: number;
    onProgress?: (progress: { elapsedMs: number; receivedChars: number }) => void;
}

/** 给每次模型调用设置正文等待和总时长上限；下游取消时同步释放上游请求。 */
export async function* guardTrainingStream(
    factory: (signal: AbortSignal) => AsyncGenerator<string, void, unknown>,
    options: TrainingStreamControl = {},
): AsyncGenerator<string, void, unknown> {
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
    const startedAt = Date.now();
    const firstTokenMs = options.firstTokenTimeoutMs ?? 90_000;
    const idleMs = options.idleTimeoutMs ?? 45_000;
    const totalMs = Math.max(1, options.timeoutMs ?? 150_000);
    let receivedChars = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const firstTimer = setTimeout(() => controller.abort(new TrainingStreamTimeoutError(
        `模型 ${Math.round(Math.min(firstTokenMs, totalMs) / 1000)} 秒内未返回正文，已停止本轮等待。`,
    )), Math.min(firstTokenMs, totalMs));
    const totalTimer = setTimeout(() => controller.abort(new TrainingStreamTimeoutError(
        `模型单次生成超过 ${Math.round(totalMs / 1000)} 秒，已保留本轮已接收的内容。`,
    )), totalMs);
    const progressTimer = options.onProgress ? setInterval(() => {
        try {
            options.onProgress?.({ elapsedMs: Date.now() - startedAt, receivedChars });
        } catch (error) {
            controller.abort(error);
        }
    }, options.progressIntervalMs ?? 5_000) : undefined;
    const iterator = factory(signal);
    let rejectAborted: ((reason: unknown) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
    const onAbort = () => rejectAborted?.(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });

    try {
        signal.throwIfAborted();
        while (true) {
            // 即使某个兼容接口未响应取消，也让本轮等待按时结束。
            const result = await Promise.race([iterator.next(), aborted]);
            signal.throwIfAborted();
            if (result.done) return;
            if (!result.value) continue;
            clearTimeout(firstTimer);
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => controller.abort(new TrainingStreamTimeoutError(
                `模型连续 ${Math.round(idleMs / 1000)} 秒没有新增正文，已保留本轮已接收的内容。`,
            )), idleMs);
            receivedChars += result.value.length;
            yield result.value;
        }
    } catch (error) {
        signal.throwIfAborted();
        throw error;
    } finally {
        clearTimeout(firstTimer);
        clearTimeout(totalTimer);
        if (idleTimer) clearTimeout(idleTimer);
        if (progressTimer) clearInterval(progressTimer);
        signal.removeEventListener('abort', onAbort);
        controller.abort();
        // 不等待拒绝取消的上游生成器；fetch 的 signal 会释放真实网络连接。
        void iterator.return(undefined).catch(() => {});
    }
}
