/**
 * GET /api/settings/composition — 按当前设置推导「下一次运行会挂哪些插件」。
 *
 * 这是插件面板的数据源。它报的是**推导结果**而不是某个活着的进程：本项目没有
 * 长驻的 harness 宿主树，每次运行自己起一个子进程（ADR-0007），所以「现在挂了
 * 什么」这个问题在没有运行时是不成立的。面板据此分两栏：设置推导出的下次组合，
 * 与最近一次运行真实落盘的组合。
 *
 * `groups` 是插件目录（catalog.ts 的 PLUGIN_CATALOG）按十组投影后的视图：每行的
 * 挂载状态由同一份 runCompositionEntries 推导，所以目录、组合与面板不会各说各话
 * （ADR-0013）。客户端不能从 @/server 导入值，目录只经这条路到达页面。
 */
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { desc } from "drizzle-orm";
import { db, runs } from "@/db";
import { handle } from "@/lib/http";
import {
  PLUGIN_CATALOG,
  PLUGIN_GROUPS,
  type PluginCatalogRow,
  type PluginGroupId,
  catalogRowForEntryId,
} from "@/server/harness/catalog";
import { runCompositionEntries } from "@/server/harness/composition";
import { mcpCompositionEntry } from "@/server/harness/entries";
import type { RunWorkspace } from "@/server/harness/workspace";
import { readSettings } from "@/server/settings";

export const dynamic = "force-dynamic";

/**
 * 一行在当前设置下的挂载状态。「会挂载」也覆盖按运行生成的前缀行（MCP、Tool 插件）：
 * 它们的实例数取决于登记与工作流，面板另以 entries 列出本次推导出的每一台。
 */
type MountedState = "会挂载" | "按运行生成" | "按开关未挂" | "按开关已挂" | "不挂" | "备选" | "库" | "自有";

function mountedState(row: PluginCatalogRow, mountedIds: ReadonlySet<string>): MountedState {
  if (row.decision === "不挂" || row.decision === "待定") return "不挂";
  if (row.decision === "备选") return "备选";
  // 自有行没有 entry 的是生成器/入口/会话内改造，不是库；有 entry 的按前缀或 id 判断。
  if (row.entry === undefined) return row.decision === "自有" ? "自有" : "库";
  // 前缀行（MCP 服务器、Tool 插件）按运行生成：推导组合里有匹配的 entry 才叫「会挂载」，
  // 一台 MCP 都没启用时不能与同页空空的 entry 清单自相矛盾。
  if ("idPrefix" in row.entry) {
    // 按目录的解析结果判断而不是裸前缀：Tool 插件的前缀 tool- 也是上游 tool-fs / tool-bash
    // 等固定 id 的前缀，裸匹配会把它们算成本行的实例。
    return [...mountedIds].some((id) => catalogRowForEntryId(id) === row) ? "会挂载" : "按运行生成";
  }
  const present = mountedIds.has(row.entry.id);
  if (row.mountedByDefault === false) return present ? "按开关已挂" : "按开关未挂";
  return present ? "会挂载" : "不挂";
}

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
    tmpDir: path.join(runDir, "tmp"),
    compositionPath: path.join(runDir, "cordis.yml"),
    imports: { instructionsDigest: "", items: [] },
  };
}

export async function GET() {
  return handle(async () => {
    const settings = readSettings();
    // 与 runner.ts 受理时交给 launchRun 的组合选项同构，但只取全局层：工作流设置的
    // 开关覆盖、MCP 子集与 Tool 集在受理时才合成，面板推导的是「不带工作流覆盖的下一次运行」。
    const mounted = runCompositionEntries(previewWorkspace(), {
      deepseek: {
        apiKeyEnv: settings.modelApiKeyEnv,
        ...(settings.modelBaseUrl ? { baseURL: settings.modelBaseUrl } : {}),
      },
      mcpServers: settings.mcpServers,
      // 全局默认开关；工作流的覆盖与 MCP 子集只在受理时合成，面板报的是全局基线（ADR-0016）。
      toggles: settings.toggles,
    });
    // entries 是下一次运行真正会挂载的组合，不能为了展示把停用项混回这份事实。
    // 停用的 MCP 独立返回，页面另区展示登记状态。
    const entries = mounted.map((entry) => ({ id: entry.id, name: entry.name }));
    const disabledEntries = settings.mcpServers
      .filter((server) => !server.enabled)
      .map((server) => {
        const entry = mcpCompositionEntry(server);
        return { id: entry.id, name: entry.name };
      });

    const mountedIds = new Set(mounted.map((entry) => entry.id));
    const groupIds = (Object.keys(PLUGIN_GROUPS).map(Number) as PluginGroupId[]).sort(
      (a, b) => a - b,
    );
    const groups = groupIds.map((id) => ({
      id,
      title: PLUGIN_GROUPS[id].title,
      defaultStance: PLUGIN_GROUPS[id].defaultStance,
      rows: PLUGIN_CATALOG.filter((row) => row.group === id).map((row) => ({
        package: row.package,
        decision: row.decision,
        entryId:
          row.entry === undefined
            ? null
            : "id" in row.entry
              ? row.entry.id
              : `${row.entry.idPrefix}*`,
        mounted: mountedState(row, mountedIds),
        workflowToggle: row.workflowToggle,
        reason: row.reason,
        customization: row.customization ?? null,
      })),
    }));

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
    return NextResponse.json({ entries, disabledEntries, groups, lastComposition });
  });
}
