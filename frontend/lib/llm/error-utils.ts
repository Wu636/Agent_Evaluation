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

export function summarizeLlmHttpError(status: number, rawText: string): string {
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

  if (!detail) {
    return `API请求失败（HTTP ${status}）`;
  }

  return `API请求失败（HTTP ${status}）：${detail.slice(0, 220)}`;
}

