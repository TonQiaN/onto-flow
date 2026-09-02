/**
 * 编排器取消竞态测试：用内存 SQLite 和可控 Action 返回验证 cancelRun 的终态
 * 不会被会话收束窗口里晚到的成功结果覆盖，不启动真实 harness。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";
import type { PortValue } from "../../lib/values";
import type { ResolvedActionDefinition, ResolvedWorkflow } from "../resolve";
import type { SettingsDocument } from "../settings";

const controls = vi.hoisted(() => ({
  resolveWorkflow: vi.fn(),
  runActionNode: vi.fn(),
  launchRun: vi.fn(),
  dispose: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
  finalizeUnsettledActionUsage: vi.fn(),
  retainSkillProjections: vi.fn(),
  releaseSkillProjections: vi.fn(),
  createRunWorkspace: vi.fn(),
}));

vi.mock("@/server/resolve", () => {
  class WorkflowResolveError extends Error {
    readonly status = 422 as const;
    constructor(
      message: string,
      readonly issues: Array<{ nodeId?: string; message: string }>,
    ) {
      super(message);
      this.name = "WorkflowResolveError";
    }
  }
  return { resolveWorkflow: controls.resolveWorkflow, WorkflowResolveError };
});
const GLOBAL_TOGGLES = {
  webSearch: false,
  fsSearch: true,
  strReplaceEditor: true,
  todo: true,
  compaction: true,
};
const DEFAULT_INSTRUCTIONS_TEXT = "# 默认指令\n";
function testSettings(overrides: Partial<SettingsDocument> = {}): SettingsDocument {
  return {
    modelApiKeyEnv: "DEEPSEEK_API_KEY",
    modelBaseUrl: "",
    credentialRefs: [],
    mcpServers: [],
    disabledTools: [],
    toggles: { ...GLOBAL_TOGGLES },
    defaultInstructions: DEFAULT_INSTRUCTIONS_TEXT,
    ...overrides,
  };
}
vi.mock("@/server/settings", () => ({
  readSettings: () => testSettings(),
}));
vi.mock("@/server/harness/workspace", () => ({
  WORKSPACE_INPUTS_SUBDIR: "inputs",
  createRunWorkspace: controls.createRunWorkspace,
}));
vi.mock("@/server/harness/launch", () => {
  class UnsettledRunLaunchError extends Error {
    constructor(
      readonly runProcess: unknown,
      readonly initializationError: unknown,
      readonly disposalError: unknown,
    ) {
      super("harness 初始化失败且子进程无法确认已退出");
      this.name = "UnsettledRunLaunchError";
    }
  }
  return { launchRun: controls.launchRun, UnsettledRunLaunchError };
});
vi.mock("./capabilities", () => ({
  collectCapabilities: (resolved: ResolvedWorkflow) => ({
    skills: [],
    skillRefs: resolved.capabilities.skills,
    tools: resolved.capabilities.tools,
    toolNamesByActionId: resolved.capabilities.toolNamesByActionId,
  }),
  materializeToolPlugins: () => [],
  toolFilterForAction: () => undefined,
}));
vi.mock("./events", () => ({ recordSessionEvent: vi.fn() }));
vi.mock("./action", () => ({
  runActionNode: controls.runActionNode,
  refreshUnsettledActionUsage: vi.fn(),
  finalizeUnsettledActionUsage: controls.finalizeUnsettledActionUsage,
}));
vi.mock("@/server/skill-library", () => ({
  retainSkillProjections: controls.retainSkillProjections,
  releaseSkillProjections: controls.releaseSkillProjections,
}));

const sqlite = new Database(":memory:");
sqlite.exec(`
CREATE TABLE runs (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL,
  workflow_name TEXT NOT NULL DEFAULT '', error TEXT, run_dir TEXT, imports TEXT,
  settings_snapshot TEXT, started_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE TABLE run_results (
  run_id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL,
  sha256 TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE run_nodes (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL, label TEXT NOT NULL,
  status TEXT NOT NULL, snapshot TEXT, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0, inputs TEXT, outputs TEXT, session_id TEXT, error TEXT,
  started_at INTEGER, finished_at INTEGER, UNIQUE(run_id, node_id)
);
`);
(globalThis as unknown as {
  ontoflowDb?: unknown;
  ontoflowCancelledRuns?: Set<string>;
  ontoflowRunProcesses?: Map<string, unknown>;
  ontoflowActiveRuns?: Set<string>;
  ontoflowRunDisposalFailures?: Set<string>;
  ontoflowPendingUsageSettlements?: Map<string, Promise<void>>;
}).ontoflowDb = drizzle(sqlite, { schema });
(globalThis as unknown as { ontoflowCancelledRuns?: Set<string> }).ontoflowCancelledRuns =
  new Set();
const runProcesses = new Map<string, unknown>();
(globalThis as unknown as { ontoflowRunProcesses?: Map<string, unknown> }).ontoflowRunProcesses =
  runProcesses;
const activeRuns = new Set<string>();
(globalThis as unknown as { ontoflowActiveRuns?: Set<string> }).ontoflowActiveRuns = activeRuns;
const disposalFailures = new Set<string>();
(globalThis as unknown as { ontoflowRunDisposalFailures?: Set<string> })
  .ontoflowRunDisposalFailures = disposalFailures;
const pendingUsageSettlements = new Map<string, Promise<void>>();
(globalThis as unknown as {
  ontoflowPendingUsageSettlements?: Map<string, Promise<void>>;
}).ontoflowPendingUsageSettlements = pendingUsageSettlements;

let startRun: typeof import("./runner").startRun;
let startResolvedRun: typeof import("./runner").startResolvedRun;
let cancelRun: typeof import("./runner").cancelRun;
let isRunExecutionActive: typeof import("./runner").isRunExecutionActive;
let deleteRun: typeof import("../monitor/cleanup").deleteRun;
let UnsettledRunLaunchError: typeof import("../harness/launch").UnsettledRunLaunchError;
const runnerTestRoot = "/tmp/ontoflow-runner-test";

function executionSnapshot(
  actionIds: string[],
): Pick<ResolvedWorkflow, "objectTypes" | "actionDefinitions" | "capabilities"> {
  const now = new Date(0);
  const definitions = new Map<string, ResolvedActionDefinition>(
    actionIds.map((actionId) => [
      actionId,
      {
        action: {
          id: actionId,
          name: actionId,
          description: "",
          prompt: "测试",
          rule: "",
          modelId: "model-test",
          reasoningEffort: "off",
          maxReentries: 0,
          onExhausted: "fail",
          createdAt: now,
          updatedAt: now,
        },
        model: {
          id: "model-test",
          providerId: "test-provider",
          modelId: "test-model",
          displayName: "测试模型",
        },
        ports: { inputs: [], outputs: [] },
        preloads: [],
      },
    ]),
  );
  return {
    objectTypes: new Map(),
    actionDefinitions: definitions,
    capabilities: { skills: [], tools: [], toolNamesByActionId: new Map() },
  };
}

function workflowRow(id: string, name: string) {
  return {
    id,
    name,
    description: "",
    instructions: "",
    settings: { toggles: {}, mcpServers: [] },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function resolvedWorkflow(): ResolvedWorkflow {
  const workflow = workflowRow("workflow-1", "取消竞态测试");
  const actionNodeRow = {
    id: "action-node",
    workflowId: workflow.id,
    kind: "action" as const,
    actionId: "action-1",
    objectTypeId: null,
    label: "测试 Action",
    x: 0,
    y: 0,
  };
  return {
    workflow,
    settings: { toggles: {}, mcpServers: [] },
    subsetIssues: [],
    nodes: [
      {
        id: "input-node",
        kind: "input",
        label: "输入",
        inputs: [],
        outputs: [
          {
            name: "value",
            objectTypeId: "text-type",
            objectTypeName: "文本",
            kind: "text",
          },
        ],
      },
      {
        id: "action-node",
        kind: "action",
        label: "测试 Action",
        inputs: [
          {
            name: "source",
            objectTypeId: "text-type",
            objectTypeName: "文本",
            kind: "text",
          },
        ],
        outputs: [
          {
            name: "result",
            objectTypeId: "text-type",
            objectTypeName: "文本",
            kind: "text",
          },
        ],
      },
      {
        id: "output-node",
        kind: "output",
        label: "输出",
        inputs: [
          {
            name: "value",
            objectTypeId: "text-type",
            objectTypeName: "文本",
            kind: "text",
          },
        ],
        outputs: [],
      },
    ],
    edges: [
      {
        id: "edge-input",
        sourceNodeId: "input-node",
        sourcePort: "value",
        targetNodeId: "action-node",
        targetPort: "source",
      },
      {
        id: "edge-output",
        sourceNodeId: "action-node",
        sourcePort: "result",
        targetNodeId: "output-node",
        targetPort: "value",
      },
    ],
    nodeRows: new Map([[actionNodeRow.id, actionNodeRow]]),
    ...executionSnapshot(["action-1"]),
  };
}

function materializationWorkflow(textInputLabel = "完整题目"): ResolvedWorkflow {
  const workflow = workflowRow("workflow-materialization", "输入物化测试");
  const port = (
    name: string,
    objectTypeId: string,
    objectTypeName: string,
    kind: "text" | "json",
  ) => ({ name, objectTypeId, objectTypeName, kind });
  const actionNodeRow = {
    id: "materialize-action",
    workflowId: workflow.id,
    kind: "action" as const,
    actionId: "action-materialize",
    objectTypeId: null,
    label: "读取输入",
    x: 0,
    y: 0,
  };
  return {
    workflow,
    settings: { toggles: {}, mcpServers: [] },
    subsetIssues: [],
    nodes: [
      {
        id: "text-input",
        kind: "input",
        label: textInputLabel,
        inputs: [],
        outputs: [port("value", "type-text", "文本", "text")],
      },
      {
        id: "json-input",
        kind: "input",
        label: "运行参数",
        inputs: [],
        outputs: [port("value", "type-json", "JSON", "json")],
      },
      {
        id: "materialize-action",
        kind: "action",
        label: "读取输入",
        inputs: [
          port("题目", "type-text", "文本", "text"),
          port("参数", "type-json", "JSON", "json"),
        ],
        outputs: [port("结果", "type-text", "文本", "text")],
      },
      {
        id: "materialize-output",
        kind: "output",
        label: "输出",
        inputs: [port("value", "type-text", "文本", "text")],
        outputs: [],
      },
    ],
    edges: [
      {
        id: "e-text",
        sourceNodeId: "text-input",
        sourcePort: "value",
        targetNodeId: "materialize-action",
        targetPort: "题目",
      },
      {
        id: "e-json",
        sourceNodeId: "json-input",
        sourcePort: "value",
        targetNodeId: "materialize-action",
        targetPort: "参数",
      },
      {
        id: "e-output",
        sourceNodeId: "materialize-action",
        sourcePort: "结果",
        targetNodeId: "materialize-output",
        targetPort: "value",
      },
    ],
    nodeRows: new Map([[actionNodeRow.id, actionNodeRow]]),
    ...executionSnapshot(["action-materialize"]),
  };
}

/**
 * 回边重入图：输入同时喂环内两个节点（写码与测试），测试节点具名出口，
 * 不通过时经回边把写码节点连同环体拉回下一轮。
 */
function loopWorkflow(): ResolvedWorkflow {
  const workflow = workflowRow("workflow-loop", "回边重入测试");
  const port = (name: string) => ({
    name,
    objectTypeId: "text-type",
    objectTypeName: "文本",
    kind: "text" as const,
  });
  const writerRow = {
    id: "writer-node",
    workflowId: workflow.id,
    kind: "action" as const,
    actionId: "action-writer",
    objectTypeId: null,
    label: "写码",
    x: 0,
    y: 0,
  };
  const testerRow = {
    id: "tester-node",
    workflowId: workflow.id,
    kind: "action" as const,
    actionId: "action-tester",
    objectTypeId: null,
    label: "测试",
    x: 0,
    y: 0,
  };
  return {
    workflow,
    settings: { toggles: {}, mcpServers: [] },
    subsetIssues: [],
    nodes: [
      { id: "input-node", kind: "input", label: "题目", inputs: [], outputs: [port("value")] },
      {
        id: "writer-node",
        kind: "action",
        label: "写码",
        inputs: [port("题目"), port("意见")],
        outputs: [port("脚本")],
        maxReentries: 2,
        onExhausted: "fail",
      },
      {
        id: "tester-node",
        kind: "action",
        label: "测试",
        inputs: [port("题目"), port("脚本")],
        outputs: [
          { ...port("定稿"), exitName: "通过" },
          { ...port("意见"), exitName: "不通过" },
        ],
      },
      { id: "output-node", kind: "output", label: "产出", inputs: [port("value")], outputs: [] },
    ],
    edges: [
      {
        id: "e1-题目到写码",
        sourceNodeId: "input-node",
        sourcePort: "value",
        targetNodeId: "writer-node",
        targetPort: "题目",
      },
      {
        id: "e2-题目到测试",
        sourceNodeId: "input-node",
        sourcePort: "value",
        targetNodeId: "tester-node",
        targetPort: "题目",
      },
      {
        id: "e3-脚本",
        sourceNodeId: "writer-node",
        sourcePort: "脚本",
        targetNodeId: "tester-node",
        targetPort: "脚本",
      },
      {
        id: "e4-回边意见",
        sourceNodeId: "tester-node",
        sourcePort: "意见",
        targetNodeId: "writer-node",
        targetPort: "意见",
      },
      {
        id: "e5-定稿",
        sourceNodeId: "tester-node",
        sourcePort: "定稿",
        targetNodeId: "output-node",
        targetPort: "value",
      },
    ],
    nodeRows: new Map([
      [writerRow.id, writerRow],
      [testerRow.id, testerRow],
    ]),
    ...executionSnapshot(["action-writer", "action-tester"]),
  };
}

beforeAll(async () => {
  ({ startRun, startResolvedRun, cancelRun, isRunExecutionActive } = await import("./runner"));
  ({ deleteRun } = await import("../monitor/cleanup"));
  ({ UnsettledRunLaunchError } = await import("../harness/launch"));
});

beforeEach(() => {
  sqlite.exec("DELETE FROM run_results;");
  controls.createRunWorkspace.mockReset();
  controls.createRunWorkspace.mockImplementation(
    async ({ workflowId, runId }: { workflowId: string; runId: string }) => ({
      runId,
      workflowId,
      runDir: "/tmp/ontoflow-runner-test/run",
      workspaceDir: "/tmp/ontoflow-runner-test/workspace",
      logsDir: "/tmp/ontoflow-runner-test/logs",
      homeDir: "/tmp/ontoflow-runner-test/home",
      pluginsDir: "/tmp/ontoflow-runner-test/plugins",
      tmpDir: "/tmp/ontoflow-runner-test/tmp",
      compositionPath: "/tmp/ontoflow-runner-test/cordis.yml",
      imports: { instructionsDigest: "test", items: [] },
    }),
  );
  controls.launchRun.mockReset();
  controls.launchRun.mockResolvedValue({
    dispose: controls.dispose,
    cancel: controls.cancel,
  });
  controls.dispose.mockReset();
  controls.dispose.mockResolvedValue(undefined);
  controls.cancel.mockClear();
  controls.runActionNode.mockReset();
  controls.finalizeUnsettledActionUsage.mockReset();
  controls.finalizeUnsettledActionUsage.mockImplementation(() => undefined);
  controls.retainSkillProjections.mockReset();
  controls.releaseSkillProjections.mockReset();
  activeRuns.clear();
  disposalFailures.clear();
  pendingUsageSettlements.clear();
  runProcesses.clear();
});

afterAll(() => {
  fs.rmSync(runnerTestRoot, { recursive: true, force: true });
});

describe("三层设置受理", () => {
  function settingsWorkflow(): ResolvedWorkflow {
    const graph = resolvedWorkflow();
    graph.workflow.instructions = "# 工作流自己的指令\n";
    graph.workflow.settings = { toggles: { webSearch: true, todo: false }, mcpServers: ["docs", "ghost"] };
    graph.settings = { toggles: { webSearch: true, todo: false }, mcpServers: ["docs", "ghost"] };
    graph.capabilities = {
      skills: [{ id: "skill-1", name: "核对", slug: "skill-abc" }],
      tools: [
        {
          id: "tool-1",
          name: "校验",
          publicName: "validate_result",
          description: "",
          parameters: { type: "object" },
          output: null,
          timeoutMs: null,
          code: "export default async () => ({})",
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      ],
      toolNamesByActionId: new Map([["action-1", ["validate_result"]]]),
    };
    return graph;
  }

  it("settingsSnapshot 与 runs 行同一事务落库，记全局、工作流与生效三层", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    controls.runActionNode.mockResolvedValue({
      outputs: { result: { kind: "text", text: "完成" } },
      selectedExit: null,
    });
    const settings = testSettings({
      disabledTools: ["todo_write"],
      mcpServers: [
        { name: "docs", enabled: true, transport: "streamable-http", url: "https://example.invalid/a", headers: {} },
        { name: "off", enabled: false, transport: "streamable-http", url: "https://example.invalid/b", headers: {} },
        { name: "other", enabled: true, transport: "streamable-http", url: "https://example.invalid/c", headers: {} },
      ],
    });
    const startedRun = await startResolvedRun(
      settingsWorkflow(),
      { "input-node": { kind: "text", text: "测试" } },
      settings,
      { source: "workflow" },
    );
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;

    // 受理返回 runId 时快照已经在库里，不等执行器启动。
    const row = sqlite
      .prepare("SELECT settings_snapshot AS snapshot FROM runs WHERE id = ?")
      .get(startedRun.runId) as { snapshot: string };
    const snapshot = JSON.parse(row.snapshot);
    expect(snapshot).toEqual({
      global: {
        toggles: GLOBAL_TOGGLES,
        mcpServers: ["docs", "other"],
        disabledTools: ["todo_write"],
        defaultInstructionsSha256: createHash("sha256").update(DEFAULT_INSTRUCTIONS_TEXT).digest("hex"),
      },
      workflow: {
        settings: { toggles: { webSearch: true, todo: false }, mcpServers: ["docs", "ghost"] },
        instructionsSha256: createHash("sha256").update("# 工作流自己的指令\n").digest("hex"),
        skills: [{ id: "skill-1", name: "核对", slug: "skill-abc" }],
        tools: [{ id: "tool-1", name: "校验", publicName: "validate_result" }],
      },
      effective: {
        toggles: { ...GLOBAL_TOGGLES, webSearch: true, todo: false },
        mcpServers: ["docs"],
      },
    });

    await vi.waitFor(() => {
      const run = sqlite
        .prepare("SELECT status FROM runs WHERE id = ?")
        .get(startedRun.runId) as { status: string };
      expect(run.status).toBe("success");
    });
  });

  it("组合的开关取生效值、MCP 取全局启用与工作流子集的交集，指令分两处落盘", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    controls.runActionNode.mockResolvedValue({
      outputs: { result: { kind: "text", text: "完成" } },
      selectedExit: null,
    });
    const docs = { name: "docs", enabled: true, transport: "streamable-http" as const, url: "https://example.invalid/a", headers: {} };
    const settings = testSettings({
      credentialRefs: [{ name: "TEAM_API_KEY", purpose: "" }],
      mcpServers: [
        docs,
        { name: "ghost", enabled: false, transport: "streamable-http", url: "https://example.invalid/b", headers: {} },
        { name: "other", enabled: true, transport: "streamable-http", url: "https://example.invalid/c", headers: {} },
      ],
    });
    const startedRun = await startResolvedRun(
      settingsWorkflow(),
      { "input-node": { kind: "text", text: "测试" } },
      settings,
      { source: "workflow" },
    );
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;
    await vi.waitFor(() => {
      const run = sqlite
        .prepare("SELECT status FROM runs WHERE id = ?")
        .get(startedRun.runId) as { status: string };
      expect(run.status).toBe("success");
    });

    expect(controls.createRunWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        instructions: "# 工作流自己的指令\n",
        homeInstructions: DEFAULT_INSTRUCTIONS_TEXT,
      }),
    );
    const launch = controls.launchRun.mock.calls[0]?.[1] as {
      credentialRefs: string[];
      composition: { toggles: unknown; mcpServers: unknown[] };
    };
    expect(launch.credentialRefs).toEqual(["TEAM_API_KEY"]);
    expect(launch.composition.toggles).toEqual({ ...GLOBAL_TOGGLES, webSearch: true, todo: false });
    // 工作流子集里的 ghost 已停用、other 不在子集里：只剩 docs。
    expect(launch.composition.mcpServers).toEqual([docs]);
  });

  it("工作流没有自己的指令时工作区 AGENTS.md 只留标题", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    controls.runActionNode.mockResolvedValue({
      outputs: { result: { kind: "text", text: "完成" } },
      selectedExit: null,
    });
    const startedRun = await startResolvedRun(
      resolvedWorkflow(),
      { "input-node": { kind: "text", text: "测试" } },
      testSettings(),
      { source: "workflow" },
    );
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;
    await vi.waitFor(() => {
      expect(controls.createRunWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ instructions: "# 取消竞态测试\n" }),
      );
    });
    await vi.waitFor(() => {
      const run = sqlite
        .prepare("SELECT status FROM runs WHERE id = ?")
        .get(startedRun.runId) as { status: string };
      expect(run.status).toBe("success");
    });
  });

  it("预载或可见 Tool 越出工作流集合时 startRun 以 422 回绝，不创建运行", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    const { WorkflowResolveError } = await import("../resolve");
    controls.resolveWorkflow.mockRejectedValueOnce(
      new WorkflowResolveError("工作流校验未通过", [
        { message: "Action「汇总」预载的技能「外部技能」不在本工作流的技能集里" },
      ]),
    );
    await expect(
      startRun("workflow-1", { "input-node": { kind: "text", text: "测试" } }),
    ).resolves.toEqual({
      ok: false,
      status: 422,
      error: "工作流校验未通过",
      issues: [{ message: "Action「汇总」预载的技能「外部技能」不在本工作流的技能集里" }],
    });
    expect(sqlite.prepare("SELECT count(*) AS count FROM runs").get()).toEqual({ count: 0 });
  });
});

describe("运行输入物化", () => {
  it("Skill 投影缺失时在受理前返回 422，不创建运行或付费节点", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    const graph = resolvedWorkflow();
    controls.retainSkillProjections.mockImplementationOnce(() => {
      throw new Error("技能「已删除技能」的磁盘投影不存在或不可读");
    });

    const startedRun = await startResolvedRun(
      graph,
      { "input-node": { kind: "text", text: "测试" } },
      testSettings(),
      { source: "workflow" },
    );

    expect(startedRun).toEqual({
      ok: false,
      status: 422,
      error: "工作流校验未通过",
      issues: [{ message: "技能「已删除技能」的磁盘投影不存在或不可读" }],
    });
    expect(sqlite.prepare("SELECT count(*) AS count FROM runs").get()).toEqual({ count: 0 });
    expect(controls.launchRun).not.toHaveBeenCalled();
  });

  it("专用入口完成校验通过后把证据固化到运行元数据", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    fs.rmSync(runnerTestRoot, { recursive: true, force: true });
    const graph = materializationWorkflow();
    controls.runActionNode.mockResolvedValue({
      outputs: { 结果: { kind: "text", text: "完成" } },
      selectedExit: null,
    });
    const resultContent = '{"ok":true}';
    const resultSha256 = createHash("sha256").update(resultContent).digest("hex");
    const completionGate = vi.fn(() => ({
      ok: true as const,
      evidence: { kind: "test-contract", digest: "abc123" },
      result: { kind: "test-result", content: resultContent, sha256: resultSha256 },
    }));

    const startedRun = await startResolvedRun(
      graph,
      {
        "text-input": { kind: "text", text: "正文" },
        "json-input": { kind: "json", json: { ok: true } },
      },
      testSettings(),
      { source: "workflow" },
      completionGate,
    );
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;

    await vi.waitFor(() => {
      const run = sqlite
        .prepare("select status, imports from runs where id = ?")
        .get(startedRun.runId) as { status: string; imports: string };
      expect(run.status).toBe("success");
      expect(JSON.parse(run.imports)).toMatchObject({
        invocation: { source: "workflow" },
        completion: { kind: "test-contract", digest: "abc123" },
      });
    });
    expect(completionGate).toHaveBeenCalledWith(startedRun.runId);
    expect(
      sqlite
        .prepare(
          "select kind, content, sha256 from run_results where run_id = ?",
        )
        .get(startedRun.runId),
    ).toEqual({ kind: "test-result", content: resultContent, sha256: resultSha256 });
    expect(controls.releaseSkillProjections).toHaveBeenCalledWith(
      startedRun.runId,
      graph.capabilities.skills,
    );
  });

  it("专用入口完成证据缺失时收束为 failed 而不是留下不可读 success", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    fs.rmSync(runnerTestRoot, { recursive: true, force: true });
    const graph = materializationWorkflow();
    controls.runActionNode.mockResolvedValue({
      outputs: { 结果: { kind: "text", text: "完成" } },
      selectedExit: null,
    });

    const startedRun = await startResolvedRun(
      graph,
      {
        "text-input": { kind: "text", text: "正文" },
        "json-input": { kind: "json", json: { ok: true } },
      },
      testSettings(),
      { source: "workflow" },
      () => ({ ok: false, error: "权威回执未落库" }),
    );
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;

    await vi.waitFor(() => {
      const run = sqlite
        .prepare("select status, error from runs where id = ?")
        .get(startedRun.runId) as { status: string; error: string };
      expect(run.status).toBe("failed");
      expect(run.error).toBe("运行完成校验失败：权威回执未落库");
    });
  });

  it("文字与 JSON 在 Action 启动前完整落盘并改写成文件引用", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    fs.rmSync(runnerTestRoot, { recursive: true, force: true });
    controls.resolveWorkflow.mockResolvedValue(materializationWorkflow());

    let capturedInputs: Record<string, PortValue[]> | undefined;
    controls.runActionNode.mockImplementation(
      async (ctx: { inputs: Record<string, PortValue[]> }) => {
        capturedInputs = ctx.inputs;
        return {
          outputs: { 结果: { kind: "text", text: "完成" } },
          selectedExit: null,
        };
      },
    );

    const fullText = `${"题目正文".repeat(80)}\nclass Solution:\n    def convert(self, s: str, numRows: int) -> str:`;
    const json = { language: "python3", numRows: 3 };
    const startedRun = await startRun("workflow-materialization", {
      "text-input": { kind: "text", text: fullText },
      "json-input": { kind: "json", json },
    });
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;

    await vi.waitFor(() => {
      const run = sqlite
        .prepare("SELECT status, error, imports FROM runs WHERE id = ?")
        .get(startedRun.runId) as { status: string; error: string | null; imports: string };
      expect(run.status).toBe("success");
      expect(run.error).toBeNull();
      expect(JSON.parse(run.imports)).toMatchObject({
        invocation: { source: "workflow" },
        instructionsDigest: "test",
      });
    });

    const textValue = capturedInputs?.题目?.[0];
    const jsonValue = capturedInputs?.参数?.[0];
    expect(textValue?.kind).toBe("file");
    expect(jsonValue?.kind).toBe("file");
    if (textValue?.kind !== "file" || jsonValue?.kind !== "file") return;
    expect(textValue.file.name).toBe("完整题目.md");
    expect(textValue.file.mime).toBe("text/markdown");
    expect(jsonValue.file.name).toBe("运行参数.json");
    expect(jsonValue.file.mime).toBe("application/json");

    const dataRoot = path.join(process.cwd(), "data");
    expect(fs.readFileSync(path.resolve(dataRoot, textValue.file.path), "utf8")).toBe(fullText);
    expect(fs.readFileSync(path.resolve(dataRoot, jsonValue.file.path), "utf8")).toBe(
      `${JSON.stringify(json, null, 2)}\n`,
    );
  });

  it("递归过深而无法序列化的 JSON 在受理边界返回 422", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    controls.resolveWorkflow.mockResolvedValue(materializationWorkflow());
    let json: Record<string, unknown> = {};
    for (let depth = 0; depth < 20_000; depth += 1) json = { next: json };

    await expect(
      startRun("workflow-materialization", {
        "text-input": { kind: "text", text: "正文" },
        "json-input": { kind: "json", json },
      }),
    ).resolves.toEqual({
      ok: false,
      status: 422,
      error: "工作流校验未通过",
      issues: [
        {
          nodeId: "json-input",
          message: "输入节点「运行参数」的 JSON 内容无法安全序列化",
        },
      ],
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM runs").get()).toEqual({ count: 0 });
    expect(controls.launchRun).not.toHaveBeenCalled();
  });

  it("超长中文节点名收敛为文件系统可接受的稳定文件名", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    fs.rmSync(runnerTestRoot, { recursive: true, force: true });
    controls.resolveWorkflow.mockResolvedValue(materializationWorkflow("超长输入节点".repeat(80)));

    let capturedInputs: Record<string, PortValue[]> | undefined;
    controls.runActionNode.mockImplementation(
      async (ctx: { inputs: Record<string, PortValue[]> }) => {
        capturedInputs = ctx.inputs;
        return {
          outputs: { 结果: { kind: "text", text: "完成" } },
          selectedExit: null,
        };
      },
    );

    const startedRun = await startRun("workflow-materialization", {
      "text-input": { kind: "text", text: "正文" },
      "json-input": { kind: "json", json: { ok: true } },
    });
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;
    await vi.waitFor(() => {
      const run = sqlite
        .prepare("SELECT status, error FROM runs WHERE id = ?")
        .get(startedRun.runId) as { status: string; error: string | null };
      expect(run.status).toBe("success");
      expect(run.error).toBeNull();
    });

    const value = capturedInputs?.题目?.[0];
    expect(value?.kind).toBe("file");
    if (value?.kind !== "file") return;
    expect(Buffer.byteLength(value.file.name, "utf8")).toBeLessThanOrEqual(240);
    expect(value.file.name).toMatch(/-[0-9a-f]{12}\.md$/);
    expect(fs.readFileSync(path.resolve(process.cwd(), "data", value.file.path), "utf8")).toBe(
      "正文",
    );
  });

  it("输入节点叫 AGENTS 时物化文件名加「输入-」前缀，不被上游当作该目录的指令文件", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    fs.rmSync(runnerTestRoot, { recursive: true, force: true });
    controls.resolveWorkflow.mockResolvedValue(materializationWorkflow("AGENTS"));

    let capturedInputs: Record<string, PortValue[]> | undefined;
    controls.runActionNode.mockImplementation(
      async (ctx: { inputs: Record<string, PortValue[]> }) => {
        capturedInputs = ctx.inputs;
        return {
          outputs: { 结果: { kind: "text", text: "完成" } },
          selectedExit: null,
        };
      },
    );

    const startedRun = await startRun("workflow-materialization", {
      "text-input": { kind: "text", text: "正文" },
      "json-input": { kind: "json", json: { ok: true } },
    });
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;
    await vi.waitFor(() => {
      const run = sqlite
        .prepare("SELECT status FROM runs WHERE id = ?")
        .get(startedRun.runId) as { status: string };
      expect(run.status).toBe("success");
    });

    const value = capturedInputs?.题目?.[0];
    expect(value?.kind).toBe("file");
    if (value?.kind !== "file") return;
    expect(value.file.name).toBe("输入-AGENTS.md");
  });

  it("节点名中的 NUL 在写文件前稳定替换", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    fs.rmSync(runnerTestRoot, { recursive: true, force: true });
    controls.resolveWorkflow.mockResolvedValue(materializationWorkflow("题目\0危险字符"));

    let capturedInputs: Record<string, PortValue[]> | undefined;
    controls.runActionNode.mockImplementation(
      async (ctx: { inputs: Record<string, PortValue[]> }) => {
        capturedInputs = ctx.inputs;
        return {
          outputs: { 结果: { kind: "text", text: "完成" } },
          selectedExit: null,
        };
      },
    );

    const startedRun = await startRun("workflow-materialization", {
      "text-input": { kind: "text", text: "正文" },
      "json-input": { kind: "json", json: { ok: true } },
    });
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;
    await vi.waitFor(() => {
      const run = sqlite
        .prepare("SELECT status, error FROM runs WHERE id = ?")
        .get(startedRun.runId) as { status: string; error: string | null };
      expect(run.status).toBe("success");
      expect(run.error).toBeNull();
    });

    const value = capturedInputs?.题目?.[0];
    expect(value?.kind).toBe("file");
    if (value?.kind !== "file") return;
    expect(value.file.name).toBe("题目_危险字符.md");
    expect(fs.readFileSync(path.resolve(process.cwd(), "data", value.file.path), "utf8")).toBe(
      "正文",
    );
  });
});

describe("回边重入", () => {
  it("环外输入喂环内多个节点时，回流后下一轮仍能等齐并收束成功", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    controls.resolveWorkflow.mockResolvedValue(loopWorkflow());

    const rounds: Array<{ node: string; round: number }> = [];
    controls.runActionNode.mockImplementation(
      async (ctx: { node: { id: string }; round: number }) => {
        rounds.push({ node: ctx.node.id, round: ctx.round });
        if (ctx.node.id === "writer-node") {
          return {
            outputs: { 脚本: { kind: "text", text: `第${ctx.round + 1}版脚本` } },
            selectedExit: null,
          };
        }
        // 测试节点：第一轮不通过（走回边），第二轮通过（走定稿）。
        return ctx.round === 0
          ? {
              outputs: { 意见: { kind: "text", text: "有用例失败" } },
              selectedExit: "不通过",
            }
          : {
              outputs: { 定稿: { kind: "text", text: "验收通过的脚本" } },
              selectedExit: "通过",
            };
      },
    );

    const startedRun = await startRun("workflow-loop", {
      "input-node": { kind: "text", text: "两数之和" },
    });
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;

    await vi.waitFor(() => {
      const run = sqlite
        .prepare("SELECT status, error FROM runs WHERE id = ?")
        .get(startedRun.runId) as { status: string; error: string | null };
      expect(run.status).toBe("success");
      expect(run.error).toBeNull();
    });

    // 两个环内节点各跑两轮，轮次成对推进。
    expect(rounds).toEqual([
      { node: "writer-node", round: 0 },
      { node: "tester-node", round: 0 },
      { node: "writer-node", round: 1 },
      { node: "tester-node", round: 1 },
    ]);
    const output = sqlite
      .prepare("SELECT status, outputs FROM run_nodes WHERE run_id = ? AND node_id = 'output-node'")
      .get(startedRun.runId) as { status: string; outputs: string };
    expect(output.status).toBe("success");
    expect(output.outputs).toContain("验收通过的脚本");
  });
});

describe("运行取消终态", () => {
  it("cancelled 但仍在收尾的执行器继续占用并发名额", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    controls.resolveWorkflow.mockResolvedValue(resolvedWorkflow());
    for (let index = 0; index < 16; index += 1) {
      activeRuns.add(`settling-${index}`);
    }

    await expect(
      startRun("workflow-1", {
        "input-node": { kind: "text", text: "测试" },
      }),
    ).resolves.toEqual({
      ok: false,
      status: 429,
      error: "并行运行已达上限 16，请等待现有运行结束后重试",
    });
    expect(sqlite.prepare("SELECT count(*) AS count FROM runs").get()).toEqual({ count: 0 });
  });

  it("Action 在取消后才返回成功时仍保持 cancelled", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    controls.dispose.mockClear();
    controls.cancel.mockClear();
    controls.resolveWorkflow.mockResolvedValue(resolvedWorkflow());

    let releaseAction: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    controls.runActionNode.mockImplementation(
      () =>
        new Promise<{ outputs: Record<string, PortValue>; selectedExit: null }>((resolve) => {
          markStarted?.();
          releaseAction = () =>
            resolve({
              outputs: { result: { kind: "text", text: "晚到的成功" } },
              selectedExit: null,
            });
        }),
    );

    const startedRun = await startRun("workflow-1", {
      "input-node": { kind: "text", text: "测试" },
    });
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;

    await started;
    await expect(cancelRun(startedRun.runId)).resolves.toEqual({ ok: true });
    expect(isRunExecutionActive(startedRun.runId)).toBe(true);
    expect(deleteRun(startedRun.runId)).toEqual({
      ok: false,
      status: 409,
      error: "运行执行尚未完全收束，不能删除",
    });
    releaseAction?.();

    await vi.waitFor(() => {
      const run = sqlite
        .prepare("SELECT status FROM runs WHERE id = ?")
        .get(startedRun.runId) as { status: string };
      const action = sqlite
        .prepare("SELECT status FROM run_nodes WHERE run_id = ? AND node_id = 'action-node'")
        .get(startedRun.runId) as { status: string };
      expect(run.status).toBe("cancelled");
      expect(action.status).toBe("cancelled");
      expect(controls.dispose).toHaveBeenCalledOnce();
      expect(isRunExecutionActive(startedRun.runId)).toBe(false);
    });
    sqlite.prepare("UPDATE runs SET run_dir = NULL WHERE id = ?").run(startedRun.runId);
    expect(deleteRun(startedRun.runId)).toEqual({ ok: true });
  });

  it("子进程退出后的用量结算瞬时失败时持续占用并自动重试", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    controls.resolveWorkflow.mockResolvedValue(resolvedWorkflow());
    controls.runActionNode.mockResolvedValue({
      outputs: { result: { kind: "text", text: "完成" } },
      selectedExit: null,
    });
    let canSettle = false;
    controls.finalizeUnsettledActionUsage.mockImplementation(() => {
      if (!canSettle) throw new Error("database is locked");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const startedRun = await startRun("workflow-1", {
        "input-node": { kind: "text", text: "测试" },
      });
      expect(startedRun.ok).toBe(true);
      if (!startedRun.ok) return;

      await vi.waitFor(() => {
        const run = sqlite
          .prepare("SELECT status, error FROM runs WHERE id = ?")
          .get(startedRun.runId) as { status: string; error: string | null };
        expect(run.status).toBe("failed");
        expect(run.error).toContain("运行子进程退出后的用量结算失败");
        expect(isRunExecutionActive(startedRun.runId)).toBe(true);
        expect(runProcesses.has(startedRun.runId)).toBe(true);
        expect(controls.releaseSkillProjections).not.toHaveBeenCalled();
      });

      canSettle = true;
      await vi.waitFor(
        () => {
          expect(controls.finalizeUnsettledActionUsage.mock.calls.length).toBeGreaterThan(1);
          expect(isRunExecutionActive(startedRun.runId)).toBe(false);
          expect(runProcesses.has(startedRun.runId)).toBe(false);
          expect(pendingUsageSettlements.has(startedRun.runId)).toBe(false);
          expect(controls.releaseSkillProjections).toHaveBeenCalledOnce();
        },
        { timeout: 2_000 },
      );
    } finally {
      canSettle = true;
      log.mockRestore();
    }
  });

  it("子进程无法确认退出时保持活动所有权并拒绝清理", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    controls.resolveWorkflow.mockResolvedValue(resolvedWorkflow());
    controls.runActionNode.mockResolvedValue({
      outputs: { result: { kind: "text", text: "完成" } },
      selectedExit: null,
    });
    controls.dispose.mockRejectedValueOnce(new Error("SIGKILL 后仍未退出"));

    const startedRun = await startRun("workflow-1", {
      "input-node": { kind: "text", text: "测试" },
    });
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;

    await vi.waitFor(() => {
      const run = sqlite
        .prepare("SELECT status, error FROM runs WHERE id = ?")
        .get(startedRun.runId) as { status: string; error: string | null };
      expect(run.status).toBe("failed");
      expect(run.error).toContain("运行子进程无法确认已退出");
    });
    expect(isRunExecutionActive(startedRun.runId)).toBe(true);
    expect(deleteRun(startedRun.runId)).toEqual({
      ok: false,
      status: 409,
      error: "运行执行尚未完全收束，不能删除",
    });
  });

  it("初始化失败后的收束不明也保留进程句柄与活动所有权", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    controls.resolveWorkflow.mockResolvedValue(resolvedWorkflow());
    const strandedProcess = {
      dispose: controls.dispose,
      cancel: controls.cancel,
    };
    controls.launchRun.mockRejectedValueOnce(
      new UnsettledRunLaunchError(
        strandedProcess as never,
        new Error("initialize 请求超时"),
        new Error("SIGKILL 后仍未退出"),
      ),
    );

    const startedRun = await startRun("workflow-1", {
      "input-node": { kind: "text", text: "测试" },
    });
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;

    await vi.waitFor(() => {
      const run = sqlite
        .prepare("SELECT status, error FROM runs WHERE id = ?")
        .get(startedRun.runId) as { status: string; error: string | null };
      expect(run.status).toBe("failed");
      expect(run.error).toContain("harness 初始化失败且子进程无法确认已退出");
    });
    expect(runProcesses.get(startedRun.runId)).toBe(strandedProcess);
    expect(isRunExecutionActive(startedRun.runId)).toBe(true);
    expect(deleteRun(startedRun.runId)).toEqual({
      ok: false,
      status: 409,
      error: "运行执行尚未完全收束，不能删除",
    });
  });
});
