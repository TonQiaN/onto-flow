/**
 * GET /api/settings/composition — 按当前设置推导「下一次运行会挂哪些插件」。
 *
 * 这是插件面板的数据源。它报的是**推导结果**而不是某个活着的进程：本项目没有
 * 长驻的 harness 宿主树，每次运行自己起一个子进程（ADR-0007），所以「现在挂了
 * 什么」这个问题在没有运行时是不成立的。面板据此分两栏：设置推导出的下次组合，
 * 与最近一次运行真实落盘的组合。
 */
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { desc } from "drizzle-orm";
import { db, runs } from "@/db";
import { handle } from "@/lib/http";
import { runCompositionEntries } from "@/server/harness/composition";
import { mcpCompositionEntry } from "@/server/harness/entries";
import type { RunWorkspace } from "@/server/harness/workspace";
import { readSettings } from "@/server/settings";

export const dynamic = "force-dynamic";

/** 只为推导 entry 清单而造的假工作区：路径只出现在展示里，不落盘。 */
function previewWorkspace(): RunWorkspace {
  const runDir = path.join(process.cwd(), "data", "runs", "<工作流>", "<下次运行>");
  return {
    runId: "<下次运行>",
    workflowId: "<工作流>",
    runDir,
    workspaceDir: path.join(runDir, "workspace"),
    logsDir: path.join(runDir, "logs"),
    homeDir: path.join(runDir, "home"),
    pluginsDir: path.join(runDir, "plugins"),
    compositionPath: path.join(runDir, "cordis.yml"),
    imports: { instructionsDigest: "", items: [] },
  };
}

export async function GET() {
  return handle(async () => {
    const settings = readSettings();
    const mounted = runCompositionEntries(previewWorkspace(), {
      deepseek: {
        apiKeyEnv: settings.modelApiKeyEnv,
        ...(settings.modelBaseUrl ? { baseURL: settings.modelBaseUrl } : {}),
      },
      mcpServers: settings.mcpServers,
    });
    // 每运行组合把停用的 MCP 整条省略——它只描述这次运行的真实能力。但面板是给人
    // 看的清单，「登记了但不会挂」也得看得见，所以这里把它们补回来并标停用。
    const entries = [
      ...mounted.map((entry) => ({
        id: entry.id,
        name: entry.name,
        disabled: entry.disabled === true,
      })),
      ...settings.mcpServers
        .filter((server) => !server.enabled)
        .map((server) => {
          const entry = mcpCompositionEntry(server);
          return { id: entry.id, name: entry.name, disabled: true };
        }),
    ];

    // 最近一次运行真实落盘的组合：文件在运行目录里，直接读回来。
    const lastRun = db
      .select({ id: runs.id, runDir: runs.runDir, startedAt: runs.startedAt })
      .from(runs)
      .orderBy(desc(runs.startedAt))
      .limit(1)
      .get();
    let lastComposition: { runId: string; yaml: string } | null = null;
    if (lastRun?.runDir) {
      const file = path.join(process.cwd(), lastRun.runDir, "cordis.yml");
      try {
        lastComposition = { runId: lastRun.id, yaml: fs.readFileSync(file, "utf8") };
      } catch {
        // 运行目录可能已被清理，面板照常显示推导结果。
      }
    }
    return NextResponse.json({ entries, lastComposition });
  });
}
