import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "@opencode-ai/sdk"],
  // Pin the Turbopack root. Without this, Next walks up looking for a lockfile
  // and can latch onto one outside the repo (e.g. a stray ~/package-lock.json).
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
