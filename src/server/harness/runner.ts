/**
 * 每运行 harness 子进程的入口：boot 显式给定的组合配置并拥有进程退出。
 *
 * 由 Next 进程用 `node --import tsx` spawn（ADR-0007）；不读任何 .env，
 * 环境由父进程洗刷后显式注入，组合路径只取 argv。
 *
 * 移植自 agent-workflow-studio 的 packages/harness/src/run/runner.ts。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { installFailLoud } from "@deepseek-ai/dsh-app-boot";
import { bootComposition } from "./boot";
import { HARNESS_BIN_NAME } from "./identity";

async function main(): Promise<void> {
  installFailLoud(HARNESS_BIN_NAME);
  const requested = process.argv[2];
  if (requested === undefined || requested === "" || !existsSync(requested)) {
    process.stderr.write("用法：runner <运行目录内 cordis.yml 的路径>；组合配置必填，没有内置回退\n");
    process.exit(1);
  }
  const ctx = await bootComposition(path.resolve(requested));
  let exiting = false;

  async function disposeAndExit(code: number): Promise<void> {
    if (exiting) return;
    exiting = true;
    try {
      await ctx.fiber.dispose();
    } finally {
      process.exit(code);
    }
  }

  process.stdin.on("end", () => void disposeAndExit(0));
  process.on("SIGTERM", () => void disposeAndExit(0));
  process.on("SIGINT", () => void disposeAndExit(130));
}

void main();
