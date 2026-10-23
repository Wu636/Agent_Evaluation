function collectErrorFragments(
  value: unknown,
  fragments: string[],
  depth: number = 0
): void {
  if (value == null || depth > 4) return;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return;
    fragments.push(trimmed);

    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        collectErrorFragments(JSON.parse(trimmed), fragments, depth + 1);
      } catch {
        // ignore nested parse failure
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectErrorFragments(item, fragments, depth + 1));
    return;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    Object.values(record).forEach((item) =>
      collectErrorFragments(item, fragments, depth + 1)
    );
  }
}

function normalizeErrorFragments(rawText: string): string[] {
  const fragments: string[] = [];
  const trimmed = String(rawText || "").trim();
  if (!trimmed) return fragments;

  collectErrorFragments(trimmed, fragments);

  return Array.from(
    new Set(
      fragments
        .map((item) => item.replace(/\s+/g, " ").trim())
        .filter(Boolean)
    )
  );
}

function buildFallbackSnippet(rawText: string): string {
  return String(rawText || "").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** HTTP 成功仍可能没有可用正文；保持上游结束原因，不伪造成网关状态码。 */
export class LlmOutputError extends Error {
  constructor(
    public readonly code: 'content_filter' | 'refusal' | 'empty_response',
    message: string,
  ) {
    super(message);
    this.name = 'LlmOutputError';
  }

  get retryable(): boolean {
    return this.code === 'empty_response';
  }
}

export class LlmHttpError extends Error {
  readonly requestId?: string;

  constructor(public readonly status: number, rawText: string) {
    super(summarizeLlmHttpError(status, rawText));
    this.name = "LlmHttpError";
    this.requestId = rawText.replace(/\\+"/g, '"')
      .match(/"request_?id"\s*:\s*"([A-Za-z0-9_.:-]{1,160})"/i)?.[1];
  }

  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export function summarizeLlmHttpError(status: number, rawText: string): string {
  if (status === 504) {
    return "模型服务网关响应超时（HTTP 504）。请求经过的网关未及时收到模型响应；仅切换同一网关下的模型可能无效，请稍后重试或检查服务网关。";
  }
  if (status === 502 || status === 503) {
    return `模型服务暂时不可用（HTTP ${status}），请稍后重试。`;
  }
  const fragments = normalizeErrorFragments(rawText);
  const combined = fragments.join(" | ");
  const normalized = combined.toLowerCase();
  const fallbackSnippet = buildFallbackSnippet(rawText);
  const detail = combined || fallbackSnippet;

  if (
    normalized.includes("insufficient balance") ||
    normalized.includes("payment required")
  ) {
    return "上游模型服务余额不足（402 Payment Required / Insufficient Balance）。请更换模型，或给对应供应商账号充值后重试。";
  }

  if (
    normalized.includes("invalid api key") ||
    normalized.includes("incorrect api key") ||
    normalized.includes("unauthorized") ||
    normalized.includes("authentication")
  ) {
    return "API Key 无效、缺失，或当前密钥无权访问该模型。请检查密钥和模型权限。";
  }

  if (
    normalized.includes("model_not_found") ||
    normalized.includes("does not exist") ||
    normalized.includes("no such model") ||
    normalized.includes("model not found")
  ) {
    return "当前模型不存在，或当前账号无权访问该模型。请更换模型后重试。";
  }

  if (
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("quota exceeded")
  ) {
    return "请求频率或配额已超限，请稍后重试。";
  }

  if (
    /503\s+service\s+unavailable/i.test(combined) ||
    normalized.includes('unknown_service_err') ||
    normalized.includes('unknown service error') ||
    normalized.includes('aigateway_error')
  ) {
    const upstreamStatus = /503\s+service\s+unavailable/i.test(combined) ? '上游 HTTP 503，' : '';
    return `所选模型的上游通道当前异常（${upstreamStatus}外层 HTTP ${status}）。请联系网关服务方核查该模型通道，或稍后重试。`;
  }

  if (status >= 500 && /stacktrace|<html|<!doctype/i.test(combined)) {
    return `模型网关返回服务异常（HTTP ${status}），请检查模型服务或稍后重试。`;
  }

  if (!detail) {
    return `API请求失败（HTTP ${status}）`;
  }

  return `API请求失败（HTTP ${status}）：${detail.slice(0, 220)}`;
}

