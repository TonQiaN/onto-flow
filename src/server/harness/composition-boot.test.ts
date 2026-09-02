/**
 * 组合能启动：真起一个 harness 子进程 boot 默认组合并完成 initialize，不调用模型、
 * 不需要凭据。一行插件写错（裸名不是直接依赖、必填配置缺失、provider 顺序不对）
 * 都在这里现形，而不是等到第一次付费运行整个起不来。initialize 不碰模型，
 * llm-deepseek 的凭据缺失只会在请求时以 MISSING_CREDENTIAL 失败。
 *
 * 搜索开关单独 boot 一次：web 三件套默认不挂，不能只靠默认组合证明它们能加载。
 */
import { rm } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { createRunWorkspace, runDirPath, type RunWorkspace } from "./workspace";
import { launchRun } from "./launch";
import { runCompositionEntries } from "./composition";

const WORKFLOW_ID = "composition-boot-test";
const created: RunWorkspace[] = [];

async function bootAndDispose(ws: RunWorkspace, toggles: { webSearch: boolean }): Promise<void> {
  const proc = await launchRun(ws, {
    composition: { toggles },
    onCrash: (message) => {
      throw new Error(`子进程未经收束退出：${message}`);
    },
  });
  const exit = await proc.dispose();
  expect(exit.expected).toBe(true);
}

afterAll(async () => {
  for (const ws of created) await rm(ws.runDir, { recursive: true, force: true });
});

describe("每运行组合", () => {
  it("默认组合能 boot 并完成 initialize", async () => {
    const ws = await createRunWorkspace({
      workflowId: WORKFLOW_ID,
      runId: `boot-default-${Date.now().toString(36)}`,
      instructions: "# 组合启动测试\n",
    });
    created.push(ws);
    await bootAndDispose(ws, { webSearch: false });
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
    await bootAndDispose(ws, { webSearch: true });
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
