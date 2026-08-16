import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // 与 tsconfig 的 "@/*" → "./src/*" 对齐，服务层测试才能加载 @/db 等模块
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
