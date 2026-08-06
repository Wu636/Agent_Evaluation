import { networkInterfaces } from "node:os";
import type { NextConfig } from "next";

function collectAllowedDevOrigins() {
  const origins = new Set(["localhost", "127.0.0.1"]);

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal) continue;
      if (address.family !== "IPv4") continue;
      origins.add(address.address);
    }
  }

  const extraOrigins = (process.env.ALLOWED_DEV_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  for (const origin of extraOrigins) {
    origins.add(origin);
  }

  return Array.from(origins);
}

function getHomeworkApiUrl() {
  const raw = (
    process.env.HOMEWORK_API_URL ||
    process.env.NEXT_PUBLIC_HOMEWORK_API_URL ||
    ""
  ).trim();

  if (!raw) return "";

  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("HOMEWORK_API_URL 仅支持 HTTP(S) URL");
  }

  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

const homeworkApiUrl = getHomeworkApiUrl();

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: collectAllowedDevOrigins(),
  async rewrites() {
    if (!homeworkApiUrl) return [];

    return {
      // 长时间 SSE 任务由 Vercel CDN 外部重写直接代理，不占用
      // Vercel Function 的执行时长，同时对浏览器保持 wl363eval.top 同源。
      beforeFiles: [
        {
          source: "/api/homework-review/generate",
          destination: `${homeworkApiUrl}/api/generate`,
        },
        {
          source: "/api/homework-review",
          destination: `${homeworkApiUrl}/api/review`,
        },
        {
          source: "/api/homework-review/remote/preview",
          destination: `${homeworkApiUrl}/api/preview`,
        },
        {
          source: "/api/homework-review/remote/files",
          destination: `${homeworkApiUrl}/api/files`,
        },
      ],
    };
  },
};

export default nextConfig;
