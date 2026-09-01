import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // dsh 依赖闭包里有原生模块（koffi）与只在服务端跑的包，必须整体外置，
  // 否则 Turbopack 会尝试打包它们（ADR-0006）。
  serverExternalPackages: [
    "better-sqlite3",
    "tsx",
    "@deepseek-ai/dsh-app-boot",
    "@deepseek-ai/dsh-fs-local",
    "@deepseek-ai/dsh-session-persistence-jsonl",
    "@deepseek-ai/dsh-subprocess",
    "@deepseek-ai/dsh-subprocess-local",
    "@deepseek-ai/dsh-sdk-protocol",
    "@deepseek-ai/cordis",
  ],
  // Pin the Turbopack root. Without this, Next walks up looking for a lockfile
  // and can latch onto one outside the repo (e.g. a stray ~/package-lock.json).
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
