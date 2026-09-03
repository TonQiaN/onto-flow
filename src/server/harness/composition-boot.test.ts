/**
 * 组合能启动：真起一个 harness 子进程 boot 默认组合并完成 initialize，不调用模型、
 * 不需要凭据。一行插件写错（裸名不是直接依赖、必填配置缺失、provider 顺序不对）
 * 都在这里现形，而不是等到第一次付费运行整个起不来。initialize 不碰模型，
 * llm-deepseek 的凭据缺失只会在请求时以 MISSING_CREDENTIAL 失败。
 *
 * 搜索开关单独 boot 一次：web 三件套默认不挂，不能只靠默认组合证明它们能加载。
 * 契约 Tool 也单独 boot 一次：包装是平台生成的 cordis 插件，它能被 loader 加载并
 * 完成注册，才证明 tool-plugin.ts 与上游 ToolDefinition 的形状仍对得上（ADR-0017）。
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRunWorkspace, runDirPath, type RunWorkspace } from "./workspace";
import { launchRun } from "./launch";
import { runCompositionEntries, type RunCompositionOptions } from "./composition";
import { materializeToolPlugin } from "./tool-plugin";
import { PLUGIN_CATALOG } from "./catalog";
import type { CompositionToggles } from "@/lib/workflow-settings";

const WORKFLOW_ID = "composition-boot-test";
const created: RunWorkspace[] = [];

async function bootAndDispose(ws: RunWorkspace, composition: RunCompositionOptions): Promise<void> {
  const proc = await launchRun(ws, {
    composition,
    onCrash: (message) => {
      throw new Error(`子进程未经收束退出：${message}`);
    },
  });
  const exit = await proc.dispose();
  expect(exit.expected).toBe(true);
}

afterAll(async () => {
  for (const ws of created) await rm(ws.runDir, { recursive: true, force: true });
  // 工作流目录只属于本测试，连它一起清掉，不给 data/runs/ 留空壳
  await rm(path.dirname(runDirPath(WORKFLOW_ID, "x")), { recursive: true, force: true });
});

describe("每运行组合", () => {
  it("默认组合能 boot 并完成 initialize", async () => {
    const ws = await createRunWorkspace({
      workflowId: WORKFLOW_ID,
      runId: `boot-default-${Date.now().toString(36)}`,
      instructions: "# 组合启动测试\n",
    });
    created.push(ws);
    await bootAndDispose(ws, { toggles: { webSearch: false } });
  }, 90_000);

  it("带样例契约 Tool 的组合能 boot：平台包装被 loader 加载并完成注册", async () => {
    const ws = await createRunWorkspace({
      workflowId: WORKFLOW_ID,
      runId: `boot-tool-${Date.now().toString(36)}`,
      instructions: "# 组合启动测试\n",
      homeInstructions: "# 默认指令\n",
    });
    created.push(ws);
    const entry = materializeToolPlugin(
      ws,
      {
        id: "boot-sample",
        name: "启动样例",
        publicName: "boot_sample",
        description: "组合启动测试用的契约 Tool",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { label: { type: "string" } },
          required: ["label"],
        },
        output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        timeoutMs: 5_000,
        code: "export default async function execute(args, ctx) { return { ok: typeof ctx.run === 'function' }; }",
      },
      { envKeys: ["DEEPSEEK_API_KEY"] },
    );
    const ids = runCompositionEntries(ws, { toolPlugins: [entry] }).map((e) => e.id);
    expect(ids).toContain("tool-boot-sample");
    await bootAndDispose(ws, { toolPlugins: [entry] });
  }, 90_000);

  it("四个默认开的开关全关也能 boot：被关掉的行没有别的行 inject 它们", async () => {
    const ws = await createRunWorkspace({
      workflowId: WORKFLOW_ID,
      runId: `boot-all-off-${Date.now().toString(36)}`,
      instructions: "# 组合启动测试\n",
    });
    created.push(ws);
    const allOff: CompositionToggles = {
      webSearch: false,
      fsSearch: false,
      strReplaceEditor: false,
      todo: false,
      compaction: false,
    };
    const ids = runCompositionEntries(ws, { toggles: allOff }).map((e) => e.id);
    const toggledIds = PLUGIN_CATALOG.flatMap((row) =>
      row.toggle !== undefined && row.entry !== undefined && "id" in row.entry
        ? [row.entry.id]
        : [],
    );
    expect(toggledIds.length).toBeGreaterThan(0);
    for (const id of toggledIds) expect(ids, `开关全关时「${id}」不该在组合里`).not.toContain(id);
    await bootAndDispose(ws, { toggles: allOff });
  }, 90_000);

  it("打开搜索开关后 web 三件套同样能 boot", async () => {
    const ws = await createRunWorkspace({
      workflowId: WORKFLOW_ID,
      runId: `boot-web-${Date.now().toString(36)}`,
      instructions: "# 组合启动测试\n",
    });
    created.push(ws);
    const ids = runCompositionEntries(ws, { toggles: { webSearch: true } }).map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(["web", "web-search-deepseek", "tool-web"]));
    await bootAndDispose(ws, { toggles: { webSearch: true } });
  }, 90_000);

  it("默认组合不含搜索三件套", () => {
    const ws: RunWorkspace = {
      runId: "preview",
      workflowId: WORKFLOW_ID,
      runDir: runDirPath(WORKFLOW_ID, "preview"),
      workspaceDir: "/preview/workspace",
      logsDir: "/preview/logs",
      homeDir: "/preview/home",
      pluginsDir: "/preview/plugins",
      tmpDir: "/preview/tmp",
      compositionPath: "/preview/cordis.yml",
      imports: { instructionsDigest: "", items: [] },
    };
    const ids = runCompositionEntries(ws).map((e) => e.id);
    expect(ids).not.toContain("tool-web");
  });
});
