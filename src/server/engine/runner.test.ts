/**
 * 编排器取消竞态测试：用内存 SQLite 和可控 Action 返回验证 cancelRun 的终态
 * 不会被会话收束窗口里晚到的成功结果覆盖，不启动真实 harness。
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";
import type { PortValue } from "../../lib/values";
import type { ResolvedWorkflow } from "../resolve";

const controls = vi.hoisted(() => ({
  resolveWorkflow: vi.fn(),
  runActionNode: vi.fn(),
  dispose: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
}));

vi.mock("@/server/resolve", () => ({
  resolveWorkflow: controls.resolveWorkflow,
}));
vi.mock("@/server/settings", () => ({
  readSettings: () => ({
    modelApiKeyEnv: "DEEPSEEK_API_KEY",
    modelBaseUrl: "",
    credentialRefs: [],
    mcpServers: [],
    disabledTools: [],
  }),
}));
vi.mock("@/server/harness/workspace", () => ({
  WORKSPACE_INPUTS_SUBDIR: "inputs",
  createRunWorkspace: async ({ workflowId, runId }: { workflowId: string; runId: string }) => ({
    runId,
    workflowId,
    runDir: "/tmp/ontoflow-runner-test/run",
    workspaceDir: "/tmp/ontoflow-runner-test/workspace",
    logsDir: "/tmp/ontoflow-runner-test/logs",
    homeDir: "/tmp/ontoflow-runner-test/home",
    pluginsDir: "/tmp/ontoflow-runner-test/plugins",
    compositionPath: "/tmp/ontoflow-runner-test/cordis.yml",
    imports: { instructionsDigest: "test", items: [] },
  }),
}));
vi.mock("@/server/harness/launch", () => ({
  launchRun: async () => ({
    dispose: controls.dispose,
    cancel: controls.cancel,
  }),
}));
vi.mock("./capabilities", () => ({
  collectCapabilities: () => ({
    skills: [],
    tools: [],
    toolNamesByActionId: new Map(),
  }),
  materializeToolPlugins: () => [],
  toolFilterForAction: () => undefined,
}));
vi.mock("./events", () => ({ recordSessionEvent: vi.fn() }));
vi.mock("./action", () => ({ runActionNode: controls.runActionNode }));

const sqlite = new Database(":memory:");
sqlite.exec(`
CREATE TABLE runs (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL,
  workflow_name TEXT NOT NULL DEFAULT '', error TEXT, run_dir TEXT, imports TEXT,
  started_at INTEGER NOT NULL, finished_at INTEGER
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
  ontoflowInputControllers?: Map<string, AbortController>;
}).ontoflowDb = drizzle(sqlite, { schema });
(globalThis as unknown as { ontoflowCancelledRuns?: Set<string> }).ontoflowCancelledRuns =
  new Set();
(globalThis as unknown as { ontoflowRunProcesses?: Map<string, unknown> }).ontoflowRunProcesses =
  new Map();
(globalThis as unknown as {
  ontoflowInputControllers?: Map<string, AbortController>;
}).ontoflowInputControllers = new Map();

let startRun: typeof import("./runner").startRun;
let cancelRun: typeof import("./runner").cancelRun;

function resolvedWorkflow(): ResolvedWorkflow {
  const workflow = {
    id: "workflow-1",
    name: "取消竞态测试",
    description: "",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
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
  };
}

/**
 * 回边重入图：输入同时喂环内两个节点（写码与测试），测试节点具名出口，
 * 不通过时经回边把写码节点连同环体拉回下一轮。
 */
function loopWorkflow(): ResolvedWorkflow {
  const workflow = {
    id: "workflow-loop",
    name: "回边重入测试",
    description: "",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
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
  };
}

beforeAll(async () => {
  ({ startRun, cancelRun } = await import("./runner"));
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
  it("Action 在取消后才返回成功时仍保持 cancelled", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
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
    });
  });
});
