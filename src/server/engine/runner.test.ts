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

beforeAll(async () => {
  ({ startRun, cancelRun } = await import("./runner"));
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
