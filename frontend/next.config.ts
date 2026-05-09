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

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: collectAllowedDevOrigins(),
};

export default nextConfig;
