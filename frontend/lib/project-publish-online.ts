export const PROJECT_PUBLISH_BUCKET = "project-publish-staging";
export const PROJECT_PUBLISH_LIMITS = {
  maxFiles: 500,
  maxProjectBytes: 300 * 1024 * 1024,
  maxFileBytes: 200 * 1024 * 1024,
  maxPathLength: 512,
  retentionHours: 24,
} as const;

export type OnlinePublishStatus =
  | "uploading"
  | "queued"
  | "processing"
  | "needs_repair"
  | "needs_attention"
  | "passed"
  | "confirmed"
  | "published"
  | "failed";

export interface OnlinePublishManifestEntry {
  path: string;
  size: number;
  type: string;
  sha256: string;
  storagePath: string;
}

export interface OnlinePublishRevision {
  id: string;
  entryPath: string;
  status: string;
  manifest: OnlinePublishManifestEntry[];
  fingerprint: string | null;
  preflightReport: unknown;
  browserAudit: unknown;
  repairs: unknown[];
  warnings: string[];
  error: string | null;
}

export interface OnlinePublishJob {
  id: string;
  status: OnlinePublishStatus;
  expiresAt: string;
  revision: OnlinePublishRevision;
  progress?: { phase: string; completed: number; total: number };
}

export function normalizeProjectPath(input: string): string | null {
  if (!input || input.length > PROJECT_PUBLISH_LIMITS.maxPathLength || input.includes("\0")) return null;
  const value = input.replace(/\\/g, "/");
  if (value.startsWith("/") || /^[a-z]:/i.test(value) || value.startsWith("//")) return null;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

