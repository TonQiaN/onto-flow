import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "@opencode-ai/sdk"],
};

export default nextConfig;
