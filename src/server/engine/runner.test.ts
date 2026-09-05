/**
 * 编排器取消竞态测试：用内存 SQLite 和可控 Action 返回验证 cancelRun 的终态
 * 不会被会话收束窗口里晚到的成功结果覆盖，不启动真实 harness。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_NODE_ROUNDS } from "../../lib/graph";
import type { PortValue } from "../../lib/values";
import type { ResolvedActionDefinition, ResolvedWorkflow } from "../resolve";
import type { SettingsDocument } from "../settings";
import { createTestDb } from "../writers/test-db";

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

const { sqlite } = await createTestDb();
(globalThis as unknown as { ontoflowCancelledRuns?: Set<string> }).ontoflowCancelledRuns =
  new Set();
const runProcesses = new Map<string, unknown>();
(globalThis as unknown as { ontoflowRunProcesses?: Map<string, unknown> }).ontoflowRunProcesses =
  runProcesses;
const activeRuns = new Set<string>();
(globalThis as unknown as { ontoflowActiveRuns?: Set<string> }).ontoflowActiveRuns = activeRuns;
const disposalFailures = new Set<string>();
(
  globalThis as unknown as { ontoflowRunDisposalFailures?: Set<string> }
).ontoflowRunDisposalFailures = disposalFailures;
const pendingUsageSettlements = new Map<string, Promise<void>>();
(
  globalThis as unknown as {
    ontoflowPendingUsageSettlements?: Map<string, Promise<void>>;
  }
).ontoflowPendingUsageSettlements = pendingUsageSettlements;

let startRun: typeof import("./runner").startRun;
let beginRound: typeof import("./rounds").beginRound;
let settleRoundIfRunning: typeof import("./rounds").settleRoundIfRunning;
let reconcileOrphanRuns: typeof import("./reconcile").reconcileOrphanRuns;
let startResolvedRun: typeof import("./runner").startResolvedRun;
let cancelRun: typeof import("./runner").cancelRun;
let isRunExecutionActive: typeof import("./runner").isRunExecutionActive;
let deleteRun: typeof import("../monitor/cleanup").deleteRun;
let UnsettledRunLaunchError: typeof import("../harness/launch").UnsettledRunLaunchError;
// 夹具目录逐进程唯一：固定路径下，多个工作树同时 `npm test` 会互相 rmSync 掉对方跑到一半的运行目录。
const runnerTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ontoflow-runner-test-"));

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

/** 只有输入与输出两个节点的免费图：不含 Action，仍走完整的引擎生命周期。 */
function passthroughWorkflow(): ResolvedWorkflow {
  const workflow = workflowRow("workflow-passthrough", "直通测试");
  const port = {
    name: "value",
    objectTypeId: "text-type",
    objectTypeName: "文本",
    kind: "text" as const,
  };
  const inputRow = {
    id: "input-node",
    workflowId: workflow.id,
    kind: "input" as const,
    actionId: null,
    objectTypeId: "text-type",
    label: "输入",
    x: 12,
    y: 34,
  };
  const outputRow = {
    id: "output-node",
    workflowId: workflow.id,
    kind: "output" as const,
    actionId: null,
    objectTypeId: "text-type",
    label: "输出",
    x: 56,
    y: 78,
  };
  return {
    workflow,
    settings: { toggles: {}, mcpServers: [] },
    subsetIssues: [],
    nodes: [
      { id: "input-node", kind: "input", label: "输入", inputs: [], outputs: [port] },
      { id: "output-node", kind: "output", label: "输出", inputs: [port], outputs: [] },
    ],
    edges: [
      {
        id: "edge-passthrough",
        sourceNodeId: "input-node",
        sourcePort: "value",
        targetNodeId: "output-node",
        targetPort: "value",
      },
    ],
    nodeRows: new Map([
      [inputRow.id, inputRow],
      [outputRow.id, outputRow],
    ] as Array<[string, typeof inputRow | typeof outputRow]>),
    ...executionSnapshot([]),
  };
}

/**
 * 嵌套回边图：input → A → B → C → D → 输出，内环 C 打回 B、外环 D 打回 A。
 * 外环重入时 B / C / D 已经跑过第 1 轮，一律取「触发重入那个节点的轮次 + 1」会把它们
 * 再次推回第 1 轮，撞 (run_id, node_id, round) 唯一键。
 */
function nestedLoopWorkflow(): ResolvedWorkflow {
  const workflow = workflowRow("workflow-nested-loop", "嵌套回边测试");
  const port = (name: string) => ({
    name,
    objectTypeId: "text-type",
    objectTypeName: "文本",
    kind: "text" as const,
  });
  const actionRow = (id: string, actionId: string, label: string) => ({
    id,
    workflowId: workflow.id,
    kind: "action" as const,
    actionId,
    objectTypeId: null,
    label,
    x: 0,
    y: 0,
  });
  return {
    workflow,
    settings: { toggles: {}, mcpServers: [] },
    subsetIssues: [],
    nodes: [
      { id: "input-node", kind: "input", label: "题目", inputs: [], outputs: [port("value")] },
      {
        id: "a-node",
        kind: "action",
        label: "起草",
        inputs: [port("题目"), port("终审意见")],
        outputs: [port("稿件")],
        maxReentries: 2,
        onExhausted: "fail",
      },
      {
        id: "b-node",
        kind: "action",
        label: "改写",
        inputs: [port("稿件"), port("初审意见")],
        outputs: [port("改稿")],
        maxReentries: 2,
        onExhausted: "fail",
      },
      {
        id: "c-node",
        kind: "action",
        label: "初审",
        inputs: [port("改稿")],
        outputs: [
          { ...port("过初审"), exitName: "通过" },
          { ...port("初审意见"), exitName: "不通过" },
        ],
      },
      {
        id: "d-node",
        kind: "action",
        label: "终审",
        inputs: [port("过初审")],
        outputs: [
          { ...port("定稿"), exitName: "通过" },
          { ...port("终审意见"), exitName: "不通过" },
        ],
      },
      { id: "output-node", kind: "output", label: "产出", inputs: [port("value")], outputs: [] },
    ],
    edges: [
      {
        id: "n1-题目",
        sourceNodeId: "input-node",
        sourcePort: "value",
        targetNodeId: "a-node",
        targetPort: "题目",
      },
      {
        id: "n2-稿件",
        sourceNodeId: "a-node",
        sourcePort: "稿件",
        targetNodeId: "b-node",
        targetPort: "稿件",
      },
      {
        id: "n3-改稿",
        sourceNodeId: "b-node",
        sourcePort: "改稿",
        targetNodeId: "c-node",
        targetPort: "改稿",
      },
      {
        id: "n4-过初审",
        sourceNodeId: "c-node",
        sourcePort: "过初审",
        targetNodeId: "d-node",
        targetPort: "过初审",
      },
      {
        id: "n5-内环回边",
        sourceNodeId: "c-node",
        sourcePort: "初审意见",
        targetNodeId: "b-node",
        targetPort: "初审意见",
      },
      {
        id: "n6-外环回边",
        sourceNodeId: "d-node",
        sourcePort: "终审意见",
        targetNodeId: "a-node",
        targetPort: "终审意见",
      },
      {
        id: "n7-定稿",
        sourceNodeId: "d-node",
        sourcePort: "定稿",
        targetNodeId: "output-node",
        targetPort: "value",
      },
    ],
    nodeRows: new Map([
      ["a-node", actionRow("a-node", "action-a", "起草")],
      ["b-node", actionRow("b-node", "action-b", "改写")],
      ["c-node", actionRow("c-node", "action-c", "初审")],
      ["d-node", actionRow("d-node", "action-d", "终审")],
    ]),
    ...executionSnapshot(["action-a", "action-b", "action-c", "action-d"]),
  };
}

/**
 * 扇出环体：写码 W 同时喂快评委 F 与慢评委 S，F 的「不通过」出口经回边打回 W。
 * F 先收束触发回边时 S 还在跑——重入必须等 S 收束再重置，否则调度器会用同一个节点 id
 * 启动 S 的下一轮、顶掉 running 里正在跟踪的 promise，S 那次完成写进的就是下一轮的状态。
 */
function fanOutLoopWorkflow(): ResolvedWorkflow {
  const workflow = workflowRow("workflow-fanout-loop", "扇出环体测试");
  const port = (name: string) => ({
    name,
    objectTypeId: "text-type",
    objectTypeName: "文本",
    kind: "text" as const,
  });
  const actionRow = (id: string, actionId: string, label: string) => ({
    id,
    workflowId: workflow.id,
    kind: "action" as const,
    actionId,
    objectTypeId: null,
    label,
    x: 0,
    y: 0,
  });
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
        outputs: [port("稿件")],
        maxReentries: 2,
        onExhausted: "fail",
      },
      {
        id: "fast-node",
        kind: "action",
        label: "快评委",
        inputs: [port("稿件")],
        outputs: [
          { ...port("定稿"), exitName: "通过" },
          { ...port("意见"), exitName: "不通过" },
        ],
      },
      {
        id: "slow-node",
        kind: "action",
        label: "慢评委",
        inputs: [port("稿件")],
        outputs: [port("报告")],
      },
      {
        id: "merge-node",
        kind: "action",
        label: "汇总",
        inputs: [port("定稿"), port("报告")],
        outputs: [port("结论")],
      },
      { id: "output-node", kind: "output", label: "产出", inputs: [port("value")], outputs: [] },
    ],
    edges: [
      {
        id: "g1-题目",
        sourceNodeId: "input-node",
        sourcePort: "value",
        targetNodeId: "writer-node",
        targetPort: "题目",
      },
      {
        id: "g2-稿件到快",
        sourceNodeId: "writer-node",
        sourcePort: "稿件",
        targetNodeId: "fast-node",
        targetPort: "稿件",
      },
      {
        id: "g3-稿件到慢",
        sourceNodeId: "writer-node",
        sourcePort: "稿件",
        targetNodeId: "slow-node",
        targetPort: "稿件",
      },
      {
        id: "g4-定稿",
        sourceNodeId: "fast-node",
        sourcePort: "定稿",
        targetNodeId: "merge-node",
        targetPort: "定稿",
      },
      {
        id: "g5-报告",
        sourceNodeId: "slow-node",
        sourcePort: "报告",
        targetNodeId: "merge-node",
        targetPort: "报告",
      },
      {
        id: "g6-结论",
        sourceNodeId: "merge-node",
        sourcePort: "结论",
        targetNodeId: "output-node",
        targetPort: "value",
      },
      {
        id: "g7-回边意见",
        sourceNodeId: "fast-node",
        sourcePort: "意见",
        targetNodeId: "writer-node",
        targetPort: "意见",
      },
    ],
    nodeRows: new Map([
      ["writer-node", actionRow("writer-node", "action-writer", "写码")],
      ["fast-node", actionRow("fast-node", "action-fast", "快评委")],
      ["slow-node", actionRow("slow-node", "action-slow", "慢评委")],
      ["merge-node", actionRow("merge-node", "action-merge", "汇总")],
    ]),
    ...executionSnapshot(["action-writer", "action-fast", "action-slow", "action-merge"]),
  };
}

interface RoundRow {
  nodeId: string;
  round: number;
  status: string;
  sessionId: string | null;
  startedAt: number;
  finishedAt: number | null;
  exitName: string | null;
  error: string | null;
  inputs: string | null;
  outputs: string | null;
}

function roundRows(runId: string): RoundRow[] {
  return sqlite
    .prepare(
      `select node_id as nodeId, round, status, session_id as sessionId,
              started_at as startedAt, finished_at as finishedAt, exit_name as exitName,
              error, inputs, outputs
         from run_node_rounds where run_id = ? order by node_id, round`,
    )
    .all(runId) as RoundRow[];
}

beforeAll(async () => {
  ({ startRun, startResolvedRun, cancelRun, isRunExecutionActive } = await import("./runner"));
  ({ beginRound, settleRoundIfRunning } = await import("./rounds"));
  ({ reconcileOrphanRuns } = await import("./reconcile"));
  ({ deleteRun } = await import("../monitor/cleanup"));
  ({ UnsettledRunLaunchError } = await import("../harness/launch"));
});

beforeEach(() => {
  sqlite.exec("DELETE FROM run_results; DELETE FROM run_node_rounds; DELETE FROM run_events;");
  // runs 外键指向 workflows：各用例只清 runs / run_nodes，六个夹具工作流的父行常驻。
  sqlite.exec(`
    INSERT OR IGNORE INTO workflows (id, name, created_at, updated_at) VALUES
      ('workflow-1', '取消竞态测试', 0, 0),
      ('workflow-materialization', '输入物化测试', 0, 0),
      ('workflow-loop', '回边重入测试', 0, 0),
      ('workflow-passthrough', '直通测试', 0, 0),
      ('workflow-nested-loop', '嵌套回边测试', 0, 0),
      ('workflow-fanout-loop', '扇出环体测试', 0, 0);
  `);
  controls.createRunWorkspace.mockReset();
  controls.createRunWorkspace.mockImplementation(
    async ({ workflowId, runId }: { workflowId: string; runId: string }) => ({
      runId,
      workflowId,
      runDir: path.join(runnerTestRoot, "run"),
      workspaceDir: path.join(runnerTestRoot, "workspace"),
      logsDir: path.join(runnerTestRoot, "logs"),
      homeDir: path.join(runnerTestRoot, "home"),
      pluginsDir: path.join(runnerTestRoot, "plugins"),
      tmpDir: path.join(runnerTestRoot, "tmp"),
      compositionPath: path.join(runnerTestRoot, "cordis.yml"),
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
    graph.workflow.settings = {
      toggles: { webSearch: true, todo: false },
      mcpServers: ["docs", "ghost"],
    };
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
        {
          name: "docs",
          enabled: true,
          transport: "streamable-http",
          url: "https://example.invalid/a",
          headers: {},
        },
        {
          name: "off",
          enabled: false,
          transport: "streamable-http",
          url: "https://example.invalid/b",
          headers: {},
        },
        {
          name: "other",
          enabled: true,
          transport: "streamable-http",
          url: "https://example.invalid/c",
          headers: {},
        },
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
        defaultInstructionsSha256: createHash("sha256")
          .update(DEFAULT_INSTRUCTIONS_TEXT)
          .digest("hex"),
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
      const run = sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(startedRun.runId) as {
        status: string;
      };
      expect(run.status).toBe("success");
    });
  });

  it("组合的开关取生效值、MCP 取全局启用与工作流子集的交集，指令分两处落盘", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    controls.runActionNode.mockResolvedValue({
      outputs: { result: { kind: "text", text: "完成" } },
      selectedExit: null,
    });
    const docs = {
      name: "docs",
      enabled: true,
      transport: "streamable-http" as const,
      url: "https://example.invalid/a",
      headers: {},
    };
    const settings = testSettings({
      credentialRefs: [{ name: "TEAM_API_KEY", purpose: "" }],
      mcpServers: [
        docs,
        {
          name: "ghost",
          enabled: false,
          transport: "streamable-http",
          url: "https://example.invalid/b",
          headers: {},
        },
        {
          name: "other",
          enabled: true,
          transport: "streamable-http",
          url: "https://example.invalid/c",
          headers: {},
        },
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
      const run = sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(startedRun.runId) as {
        status: string;
      };
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
      const run = sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(startedRun.runId) as {
        status: string;
      };
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
  it("JSON 输入不满足受理契约时返回字段错误，不创建运行或启动模型", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    const graph = materializationWorkflow();
    graph.nodes.find((node) => node.id === "json-input")!.outputs[0].jsonSchema =
      '{"type":"object","properties":{"items":{"type":"array"}},"required":["items"]}';
    const result = await startResolvedRun(
      graph,
      {
        "text-input": { kind: "text", text: "正文" },
        "json-input": { kind: "json", json: { wrong: true } },
      },
      testSettings(),
      { source: "workflow" },
    );
    expect(result).toMatchObject({
      ok: false,
      status: 422,
      issues: [{ nodeId: "json-input", message: expect.stringContaining("$.items") }],
    });
    expect(sqlite.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 0 });
    expect(controls.launchRun).not.toHaveBeenCalled();
  });

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
      {
        source: "resume-match-api",
        contractVersion: 1,
        resultNodes: { outputNodeId: "output", validatorNodeId: "action" },
      },
      completionGate,
    );
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;

    // 来源与 run 行同一次同步 insert 落库，只此一份：运行列表按来源筛选是从这里
    // json_extract 推导的，专用 GET 也只认它。受理返回时它就必须在盘上。
    expect(
      JSON.parse(
        (
          sqlite.prepare("select imports from runs where id = ?").get(startedRun.runId) as {
            imports: string;
          }
        ).imports,
      ),
    ).toMatchObject({ invocation: { source: "resume-match-api", contractVersion: 1 } });

    await vi.waitFor(() => {
      const run = sqlite
        .prepare("select status, imports from runs where id = ?")
        .get(startedRun.runId) as { status: string; imports: string };
      expect(run.status).toBe("success");
      expect(JSON.parse(run.imports)).toMatchObject({
        invocation: { source: "resume-match-api", contractVersion: 1 },
        completion: { kind: "test-contract", digest: "abc123" },
      });
    });
    expect(completionGate).toHaveBeenCalledWith(startedRun.runId);
    expect(
      sqlite
        .prepare("select kind, content, sha256 from run_results where run_id = ?")
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
      const run = sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(startedRun.runId) as {
        status: string;
      };
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
    // 产物只在轮次行上：输出节点最后一轮成功的那份才是定稿。
    const output = sqlite
      .prepare(
        "SELECT status, outputs FROM run_node_rounds WHERE run_id = ? AND node_id = 'output-node'" +
          " ORDER BY round DESC LIMIT 1",
      )
      .get(startedRun.runId) as { status: string; outputs: string };
    expect(output.status).toBe("success");
    expect(output.outputs).toContain("验收通过的脚本");
  });
});

describe("冻结图与轮次行", () => {
  it("受理把图冻进 runs.graph；输入与输出各得一行零时长的成功轮次", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    controls.resolveWorkflow.mockResolvedValue(passthroughWorkflow());

    const startedRun = await startRun("workflow-passthrough", {
      "input-node": { kind: "text", text: "直通" },
    });
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;

    // 受理返回 runId 时图已经在库里，不等执行器启动（与 runs 行同一事务）。
    const graph = JSON.parse(
      (
        sqlite.prepare("select graph from runs where id = ?").get(startedRun.runId) as {
          graph: string;
        }
      ).graph,
    );
    expect(graph.version).toBe(1);
    expect(graph.nodes.map((n: { id: string; x: number }) => [n.id, n.x])).toEqual([
      ["input-node", 12],
      ["output-node", 56],
    ]);
    expect(graph.edges.map((e: { id: string }) => e.id)).toEqual(["edge-passthrough"]);

    await vi.waitFor(() => {
      const run = sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(startedRun.runId) as {
        status: string;
      };
      expect(run.status).toBe("success");
    });

    const rows = roundRows(startedRun.runId);
    expect(rows.map((r) => [r.nodeId, r.round, r.status])).toEqual([
      ["input-node", 0, "success"],
      ["output-node", 0, "success"],
    ]);
    for (const row of rows) {
      // 零时长：这两种节点从不进 action.ts，起止同一时刻，也没有会话与快照。
      expect(row.startedAt).toBe(row.finishedAt);
      expect(row.sessionId).toBeNull();
      // 抽屉的「输入输出」页签靠这两列，输入节点记的是发起时提交的值
      //（已按 ADR-0012 物化成工作区文件，所以这里是文件引用而不是正文）。
      expect(JSON.parse(row.inputs!).value[0].file.name).toBe("输入.md");
      expect(JSON.parse(row.outputs!).value.file.name).toBe("输入.md");
    }
  });

  it("回边重入让输出节点得到两行轮次：先跳过、后成功", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    controls.resolveWorkflow.mockResolvedValue(loopWorkflow());
    controls.runActionNode.mockImplementation(
      async (ctx: { node: { id: string }; round: number }) => {
        if (ctx.node.id === "writer-node") {
          return { outputs: { 脚本: { kind: "text", text: "脚本" } }, selectedExit: null };
        }
        return ctx.round === 0
          ? { outputs: { 意见: { kind: "text", text: "有用例失败" } }, selectedExit: "不通过" }
          : { outputs: { 定稿: { kind: "text", text: "通过的脚本" } }, selectedExit: "通过" };
      },
    );

    const startedRun = await startRun("workflow-loop", {
      "input-node": { kind: "text", text: "两数之和" },
    });
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;
    await vi.waitFor(() => {
      const run = sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(startedRun.runId) as {
        status: string;
      };
      expect(run.status).toBe("success");
    });

    // run_nodes 只留最后一轮，只看它回放不出「第 1 轮打回、第 2 轮通过」。
    expect(
      roundRows(startedRun.runId)
        .filter((r) => r.nodeId === "output-node")
        .map((r) => [r.round, r.status]),
    ).toEqual([
      [0, "skipped"],
      [1, "success"],
    ]);
  });

  it("嵌套回边下轮次号按节点单调递增，不撞唯一键", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    controls.resolveWorkflow.mockResolvedValue(nestedLoopWorkflow());

    const calls: Array<{ node: string; round: number }> = [];
    const seen = new Map<string, number>();
    controls.runActionNode.mockImplementation(
      async (ctx: { runId: string; node: { id: string }; round: number }) => {
        calls.push({ node: ctx.node.id, round: ctx.round });
        // 复刻 action.ts 的落库：唯一键由数据库把关，轮次号一旦重复这里就抛，
        // 运行随之失败——正是本用例要挡住的回归。
        sqlite
          .prepare(
            "insert into run_node_rounds (id, run_id, node_id, round, status, started_at, finished_at) values (?, ?, ?, ?, 'success', ?, ?)",
          )
          .run(
            `${ctx.node.id}-${ctx.round}`,
            ctx.runId,
            ctx.node.id,
            ctx.round,
            Date.now(),
            Date.now(),
          );
        const times = (seen.get(ctx.node.id) ?? 0) + 1;
        seen.set(ctx.node.id, times);
        if (ctx.node.id === "c-node") {
          return times === 1
            ? { outputs: { 初审意见: { kind: "text", text: "改" } }, selectedExit: "不通过" }
            : { outputs: { 过初审: { kind: "text", text: "过" } }, selectedExit: "通过" };
        }
        if (ctx.node.id === "d-node") {
          return times === 1
            ? { outputs: { 终审意见: { kind: "text", text: "重来" } }, selectedExit: "不通过" }
            : { outputs: { 定稿: { kind: "text", text: "定稿" } }, selectedExit: "通过" };
        }
        const name = ctx.node.id === "a-node" ? "稿件" : "改稿";
        return { outputs: { [name]: { kind: "text", text: name } }, selectedExit: null };
      },
    );

    const startedRun = await startRun("workflow-nested-loop", {
      "input-node": { kind: "text", text: "选题" },
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

    const keys = calls.map((c) => `${c.node}#${c.round}`);
    expect(new Set(keys).size).toBe(keys.length);
    // 内环先把 B / C 推到第 1 轮，外环再重入时它们只能继续往上走，不能回到第 1 轮。
    expect(calls.filter((c) => c.node === "b-node").map((c) => c.round)).toEqual([0, 1, 2]);
    expect(calls.filter((c) => c.node === "d-node").map((c) => c.round)).toEqual([1, 2]);
  });

  it("重入耗尽把节点写成 failed 并补上 finishedAt", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    const graph = loopWorkflow();
    const writer = graph.nodes.find((n) => n.id === "writer-node")!;
    writer.maxReentries = 1;
    controls.resolveWorkflow.mockResolvedValue(graph);
    controls.runActionNode.mockImplementation(async (ctx: { node: { id: string } }) =>
      ctx.node.id === "writer-node"
        ? { outputs: { 脚本: { kind: "text", text: "脚本" } }, selectedExit: null }
        : { outputs: { 意见: { kind: "text", text: "还是不行" } }, selectedExit: "不通过" },
    );

    const startedRun = await startRun("workflow-loop", {
      "input-node": { kind: "text", text: "两数之和" },
    });
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;
    await vi.waitFor(() => {
      const run = sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(startedRun.runId) as {
        status: string;
      };
      expect(run.status).toBe("failed");
    });

    // 重入耗尽不是一轮，只在 run_nodes 上留终态与时刻：回放据此在最后一轮成功之后翻成失败。
    const node = sqlite
      .prepare(
        "select status, error, finished_at as finishedAt from run_nodes where run_id = ? and node_id = 'writer-node'",
      )
      .get(startedRun.runId) as { status: string; error: string; finishedAt: number | null };
    expect(node.status).toBe("failed");
    expect(node.error).toContain("重入次数已达上限");
    expect(node.finishedAt).not.toBeNull();
  });

  it("Action 抛出时本轮写成 failed，下游节点各得一行 skipped 轮次", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    controls.resolveWorkflow.mockResolvedValue(resolvedWorkflow());
    controls.runActionNode.mockRejectedValue(new Error("声明的产物没有写出来：result.md"));

    const startedRun = await startRun("workflow-1", {
      "input-node": { kind: "text", text: "测试" },
    });
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;
    await vi.waitFor(() => {
      const run = sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(startedRun.runId) as {
        status: string;
      };
      expect(run.status).toBe("failed");
    });

    const rows = roundRows(startedRun.runId);
    expect(rows.map((r) => [r.nodeId, r.round, r.status])).toEqual([
      ["action-node", 0, "failed"],
      ["input-node", 0, "success"],
      ["output-node", 0, "skipped"],
    ]);
    const failed = rows.find((r) => r.nodeId === "action-node")!;
    expect(failed.error).toContain("result.md");
    expect(failed.finishedAt).not.toBeNull();
    expect(rows.every((r) => r.status !== "running")).toBe(true);
  });

  it("会话还没开就失败时，一进门开出的骨架行被收口成 failed 并留住本轮输入", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    controls.resolveWorkflow.mockResolvedValue(resolvedWorkflow());
    // 复刻 action.ts 的入口顺序：先开骨架行，再做会抛的准备（校验产物路径、读技能投影）。
    controls.runActionNode.mockImplementation(
      async (ctx: {
        runId: string;
        node: { id: string };
        round: number;
        inputs: Record<string, unknown>;
      }) => {
        beginRound({
          runId: ctx.runId,
          nodeId: ctx.node.id,
          round: ctx.round,
          sessionId: ctx.node.id,
          startedAt: new Date(),
          inputs: ctx.inputs,
        });
        throw new Error("Action「测试 Action」的输出端口「result」没有产物路径");
      },
    );

    const startedRun = await startRun("workflow-1", {
      "input-node": { kind: "text", text: "测试" },
    });
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;
    await vi.waitFor(() => {
      const run = sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(startedRun.runId) as {
        status: string;
      };
      expect(run.status).toBe("failed");
    });

    const row = roundRows(startedRun.runId).find((r) => r.nodeId === "action-node")!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("没有产物路径");
    expect(row.finishedAt).not.toBeNull();
    // 收口只写终态列：骨架行带着的会话与本轮输入原样保留。
    expect(row.sessionId).toBe("action-node");
    expect(JSON.parse(row.inputs!).source[0].kind).toBe("file");
    // 起止不同一时刻：这一轮真的开过，不是补出来的零时长行。
    expect(row.startedAt).toBeLessThanOrEqual(row.finishedAt!);
  });

  it("Action 已把本轮写成 success、取消随后才到时，轮次行仍被改回 cancelled", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    controls.resolveWorkflow.mockResolvedValue(resolvedWorkflow());

    let release: (() => void) | undefined;
    let markSettled: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 反向次序：action.ts 已经把这一轮收口成 success（此刻取消还没到，条件更新写得进去），
    // 取消随后才落下——`closeRunningRounds` 找不到 running 的行，只有 runner 的取消分支能纠正。
    // 这一轮走的是具名出口，照 action.ts 的收束原样写下 exitName，用来盯住取消不会把它清成 null。
    controls.runActionNode.mockImplementation(
      async (ctx: { runId: string; node: { id: string }; round: number }) => {
        const key = { runId: ctx.runId, nodeId: ctx.node.id, round: ctx.round };
        beginRound({ ...key, sessionId: ctx.node.id, startedAt: new Date() });
        settleRoundIfRunning({
          ...key,
          status: "success",
          finishedAt: new Date(),
          exitName: "通过",
          outputs: { result: { kind: "text", text: "已收口的成功" } },
        });
        markSettled?.();
        await gate;
        return {
          outputs: { result: { kind: "text", text: "已收口的成功" } },
          selectedExit: "通过",
        };
      },
    );

    const startedRun = await startRun("workflow-1", {
      "input-node": { kind: "text", text: "测试" },
    });
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;

    await settled;
    expect(roundRows(startedRun.runId).find((r) => r.nodeId === "action-node")?.status).toBe(
      "success",
    );
    await expect(cancelRun(startedRun.runId)).resolves.toEqual({ ok: true });
    // 取消只收口仍 running 的行，这一行已经是 success，它动不了。
    expect(roundRows(startedRun.runId).find((r) => r.nodeId === "action-node")?.status).toBe(
      "success",
    );
    release?.();

    // 等执行器真正收束：cancelRun 早就把 runs 写成 cancelled，只看它会在任务恢复前就通过。
    await vi.waitFor(() => {
      expect(isRunExecutionActive(startedRun.runId)).toBe(false);
    });
    expect(
      (
        sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(startedRun.runId) as {
          status: string;
        }
      ).status,
    ).toBe("cancelled");

    // 节点与轮次的终态必须一致，否则回放会在一段成功上叠一个取消的节点。
    const node = sqlite
      .prepare("select status from run_nodes where run_id = ? and node_id = 'action-node'")
      .get(startedRun.runId) as { status: string };
    const row = roundRows(startedRun.runId).find((r) => r.nodeId === "action-node")!;
    expect(node.status).toBe("cancelled");
    expect(row.status).toBe("cancelled");
    expect(row.finishedAt).not.toBeNull();
    // 收口只改终态列：这一轮真跑出来的产物与走过的出口都留着，抽屉仍看得到。
    expect(row.outputs).toContain("已收口的成功");
    expect(row.exitName).toBe("通过");
  });

  it("取消赶在 Action 收束之前落下时，Action 侧的成功不覆盖 cancelled", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    controls.resolveWorkflow.mockResolvedValue(resolvedWorkflow());

    let release: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 取消可能在 Action 正等最后一次 sessionOutput / closeSession 时到达；这里复刻
    // action.ts 的顺序：先 beginRound，收束时只在行仍是 running 时写成功。
    let statusAfterActionSettle: string | undefined;
    controls.runActionNode.mockImplementation(
      async (ctx: { runId: string; node: { id: string }; round: number }) => {
        beginRound({
          runId: ctx.runId,
          nodeId: ctx.node.id,
          round: ctx.round,
          sessionId: ctx.node.id,
          startedAt: new Date(),
        });
        markStarted?.();
        await gate;
        settleRoundIfRunning({
          runId: ctx.runId,
          nodeId: ctx.node.id,
          round: ctx.round,
          status: "success",
          finishedAt: new Date(),
          outputs: { result: { kind: "text", text: "晚到的成功" } },
        });
        statusAfterActionSettle = (
          sqlite
            .prepare("select status from run_node_rounds where run_id = ? and node_id = ?")
            .get(ctx.runId, ctx.node.id) as { status: string }
        ).status;
        return { outputs: { result: { kind: "text", text: "晚到的成功" } }, selectedExit: null };
      },
    );

    const startedRun = await startRun("workflow-1", {
      "input-node": { kind: "text", text: "测试" },
    });
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;

    await started;
    await expect(cancelRun(startedRun.runId)).resolves.toEqual({ ok: true });
    release?.();

    await vi.waitFor(() => {
      const run = sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(startedRun.runId) as {
        status: string;
      };
      expect(run.status).toBe("cancelled");
    });
    // 先到的终态赢：Action 侧那次条件更新一行都没改到。
    expect(statusAfterActionSettle).toBe("cancelled");
    const rows = roundRows(startedRun.runId);
    expect(rows.find((r) => r.nodeId === "action-node")?.status).toBe("cancelled");
    expect(rows.find((r) => r.nodeId === "output-node")?.status).toBe("skipped");
    expect(rows.every((r) => r.status !== "running")).toBe(true);
  });

  it("整运行失败（executeRun 自身抛出）给未开始的节点补齐 skipped 轮次", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    controls.resolveWorkflow.mockResolvedValue(resolvedWorkflow());
    controls.createRunWorkspace.mockRejectedValueOnce(new Error("工作区创建失败"));

    const startedRun = await startRun("workflow-1", {
      "input-node": { kind: "text", text: "测试" },
    });
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;
    await vi.waitFor(() => {
      const run = sqlite
        .prepare("SELECT status, error FROM runs WHERE id = ?")
        .get(startedRun.runId) as { status: string; error: string };
      expect(run.status).toBe("failed");
      expect(run.error).toContain("工作区创建失败");
    });

    expect(roundRows(startedRun.runId).map((r) => [r.nodeId, r.round, r.status])).toEqual([
      ["action-node", 0, "skipped"],
      ["input-node", 0, "skipped"],
      ["output-node", 0, "skipped"],
    ]);
  });

  it("启动对账收口仍在跑的轮次行，并给未开始的节点补 skipped 轮次", () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    const now = Date.now();
    sqlite
      .prepare(
        "insert into runs (id, workflow_id, status, started_at) values ('orphan-run', 'workflow-1', 'running', ?)",
      )
      .run(now);
    sqlite.exec(`
      INSERT INTO run_nodes (id, run_id, node_id, label, status)
        VALUES ('rn-1', 'orphan-run', 'action-node', '测试 Action', 'running'),
               ('rn-2', 'orphan-run', 'output-node', '输出', 'pending');
      INSERT INTO run_node_rounds (id, run_id, node_id, round, session_id, status, started_at)
        VALUES ('rr-1', 'orphan-run', 'action-node', 0, 'action-node', 'running', ${now});
    `);

    reconcileOrphanRuns();

    expect(roundRows("orphan-run").map((r) => [r.nodeId, r.round, r.status])).toEqual([
      ["action-node", 0, "failed"],
      ["output-node", 0, "skipped"],
    ]);
    const closed = roundRows("orphan-run")[0];
    expect(closed.finishedAt).not.toBeNull();
    expect(closed.error).toBe("进程重启，运行被中断");
  });
});

describe("每节点总轮次上限", () => {
  it("嵌套环体把下游节点推过上限时整条运行失败，没有行残留 running", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    const graph = nestedLoopWorkflow();
    // 单个回边目标的 maxReentries 给足：本用例要撞的是**总轮次**上限，不是它。
    for (const node of graph.nodes) {
      if (node.kind === "action") node.maxReentries = MAX_NODE_ROUNDS * 2;
    }
    controls.resolveWorkflow.mockResolvedValue(graph);
    // 初审永远不通过：内环一直把改写 / 初审推向下一轮，两个节点的总轮次一路长。
    const calls = new Map<string, number>();
    // 复刻 action.ts 的落库：轮次行由它写，来源节点最后一轮到底是不是 success 才验得了。
    controls.runActionNode.mockImplementation(
      async (ctx: { runId: string; node: { id: string }; round: number }) => {
        calls.set(ctx.node.id, (calls.get(ctx.node.id) ?? 0) + 1);
        const key = { runId: ctx.runId, nodeId: ctx.node.id, round: ctx.round };
        beginRound({ ...key, sessionId: ctx.node.id, startedAt: new Date() });
        const settle = (outputs: Record<string, PortValue>, exit: string | null) => {
          settleRoundIfRunning({
            ...key,
            status: "success",
            finishedAt: new Date(),
            exitName: exit,
            outputs: outputs as unknown as Record<string, unknown>,
          });
          return { outputs, selectedExit: exit };
        };
        if (ctx.node.id === "c-node") {
          return settle({ 初审意见: { kind: "text", text: "再改" } }, "不通过");
        }
        if (ctx.node.id === "d-node") {
          return settle({ 定稿: { kind: "text", text: "定稿" } }, "通过");
        }
        const name = ctx.node.id === "a-node" ? "稿件" : "改稿";
        return settle({ [name]: { kind: "text", text: name } }, null);
      },
    );

    const startedRun = await startRun("workflow-nested-loop", {
      "input-node": { kind: "text", text: "选题" },
    });
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;
    const runId = startedRun.runId;

    await vi.waitFor(
      () => {
        const run = sqlite.prepare("select status, error from runs where id = ?").get(runId) as {
          status: string;
          error: string | null;
        };
        expect(run.status).toBe("failed");
        expect(run.error).toContain(`重入总轮次超过上限 ${MAX_NODE_ROUNDS}`);
        // 错误指名被封顶的**目标**节点（内环回边打回的是「改写」）。
        expect(run.error).toContain("改写");
      },
      { timeout: 20_000 },
    );

    const rows = roundRows(runId);
    // 上限之内的轮次都留在盘上，一个节点最多 MAX_NODE_ROUNDS 轮。
    const perNode = new Map<string, number>();
    for (const row of rows) perNode.set(row.nodeId, (perNode.get(row.nodeId) ?? 0) + 1);
    expect(Math.max(...perNode.values())).toBe(MAX_NODE_ROUNDS);
    for (const [nodeId, count] of perNode) {
      expect([nodeId, count <= MAX_NODE_ROUNDS]).toEqual([nodeId, true]);
    }
    // 上限触发后一个新节点都没再开：环内两个 Action 各正好跑满上限，没有第 101 轮。
    expect(calls.get("b-node")).toBe(MAX_NODE_ROUNDS);
    expect(calls.get("c-node")).toBe(MAX_NODE_ROUNDS);
    expect(calls.get("a-node")).toBe(1);
    // 收口：没有行残留 running，pending 的节点各得一行 skipped，节点终态里也没有 pending。
    expect(rows.filter((row) => row.status === "running")).toEqual([]);
    const nodeStates = sqlite
      .prepare("select node_id as nodeId, status, error from run_nodes where run_id = ?")
      .all(runId) as Array<{ nodeId: string; status: string; error: string | null }>;
    expect(
      nodeStates.filter((row) => row.status === "running" || row.status === "pending"),
    ).toEqual([]);
    for (const node of nodeStates.filter((row) => row.status === "skipped")) {
      expect([node.nodeId, rows.some((row) => row.nodeId === node.nodeId)]).toEqual([
        node.nodeId,
        true,
      ]);
    }
    // 只有目标节点被写成 failed，运行页有地方可指。
    const blamed = nodeStates.filter((row) => row.error?.includes("重入总轮次超过上限"));
    expect(blamed.map((row) => [row.nodeId, row.status])).toEqual([["b-node", "failed"]]);
    // 来源节点（触发回边的初审）和它最后一轮的轮次行仍是 success：那一轮确实成功了，
    // 错误不该记到它头上，更不该把它已收束的轮次改写成 failed。
    expect(nodeStates.find((row) => row.nodeId === "c-node")?.status).toBe("success");
    const sourceRounds = rows.filter((row) => row.nodeId === "c-node");
    expect(sourceRounds.length).toBe(MAX_NODE_ROUNDS);
    expect(sourceRounds.at(-1)).toMatchObject({ round: MAX_NODE_ROUNDS - 1, status: "success" });
    expect(sourceRounds.every((row) => row.status === "success")).toBe(true);
    // 被封顶的目标不新增轮次行：被拒绝的是这次重入，没有哪一轮真的开过。
    expect(rows.filter((row) => row.nodeId === "b-node").length).toBe(MAX_NODE_ROUNDS);
  }, 30_000);
});

describe("回边重入等待环体收束", () => {
  interface RoundCtx {
    runId: string;
    node: { id: string };
    round: number;
  }

  /** 复刻 action.ts 的落库次序：一进门开骨架行，收束时按本轮条件写终态。 */
  const openRound = (ctx: RoundCtx): void => {
    beginRound({
      runId: ctx.runId,
      nodeId: ctx.node.id,
      round: ctx.round,
      sessionId: ctx.round === 0 ? ctx.node.id : `${ctx.node.id}#${ctx.round + 1}`,
      startedAt: new Date(),
    });
  };
  const closeRound = (
    ctx: RoundCtx,
    outputs: Record<string, PortValue>,
    selectedExit: string | null,
  ): { outputs: Record<string, PortValue>; selectedExit: string | null } => {
    settleRoundIfRunning({
      runId: ctx.runId,
      nodeId: ctx.node.id,
      round: ctx.round,
      status: "success",
      finishedAt: new Date(),
      exitName: selectedExit,
      outputs: outputs as unknown as Record<string, unknown>,
    });
    return { outputs, selectedExit };
  };

  const nodeStatus = (runId: string, nodeId: string): string =>
    (
      sqlite
        .prepare("select status from run_nodes where run_id = ? and node_id = ?")
        .get(runId, nodeId) as { status: string }
    ).status;

  /**
   * 快评委第一轮打回、慢评委阻塞在闸门上：回边在慢评委仍在跑时触发。
   * `release` 放行慢评委，`rejected` 在快评委那次「不通过」写完轮次行后兑现。
   */
  function fanOutControls() {
    let release: (() => void) | undefined;
    let markRejected: (() => void) | undefined;
    const rejected = new Promise<void>((resolve) => {
      markRejected = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = new Map<string, number>();
    controls.resolveWorkflow.mockResolvedValue(fanOutLoopWorkflow());
    controls.runActionNode.mockImplementation(async (ctx: RoundCtx) => {
      const times = (calls.get(ctx.node.id) ?? 0) + 1;
      calls.set(ctx.node.id, times);
      openRound(ctx);
      if (ctx.node.id === "writer-node") {
        return closeRound(ctx, { 稿件: { kind: "text", text: `第${times}版稿件` } }, null);
      }
      if (ctx.node.id === "fast-node") {
        if (times === 1) {
          const result = closeRound(ctx, { 意见: { kind: "text", text: "打回" } }, "不通过");
          markRejected?.();
          return result;
        }
        return closeRound(ctx, { 定稿: { kind: "text", text: "定稿" } }, "通过");
      }
      if (ctx.node.id === "slow-node") {
        // 只有第一次慢：回边就在这段等待里触发。
        if (times === 1) await gate;
        return closeRound(ctx, { 报告: { kind: "text", text: `报告-第${times}次` } }, null);
      }
      return closeRound(ctx, { 结论: { kind: "text", text: "结论" } }, null);
    });
    return { rejected, release: () => release?.(), calls };
  }

  it("环体里还有节点在跑时，回边重入挂起到它收束之后", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    const fan = fanOutControls();

    const startedRun = await startRun("workflow-fanout-loop", {
      "input-node": { kind: "text", text: "两数之和" },
    });
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;
    const runId = startedRun.runId;

    // 快评委已经打回并落库，回边此刻已满足；慢评委仍卡在闸门上。
    await fan.rejected;
    await vi.waitFor(() => {
      expect(nodeStatus(runId, "fast-node")).toBe("success");
    });
    // 重入被挂起：环体一个节点都没被重置，也没有任何第 2 轮开工。
    expect(nodeStatus(runId, "writer-node")).toBe("success");
    expect(roundRows(runId).find((r) => r.nodeId === "slow-node" && r.round === 0)?.status).toBe(
      "running",
    );
    expect(roundRows(runId).filter((r) => r.round > 0)).toEqual([]);

    fan.release();
    await vi.waitFor(() => {
      const run = sqlite.prepare("select status, error from runs where id = ?").get(runId) as {
        status: string;
        error: string | null;
      };
      expect(run.status).toBe("success");
      expect(run.error).toBeNull();
    });

    const rows = roundRows(runId);
    // 慢评委两轮各一行，产物各归各轮——串轮的话第 0 轮会顶着第 2 次的报告。
    const slow = rows.filter((r) => r.nodeId === "slow-node");
    expect(slow.map((r) => [r.round, r.status])).toEqual([
      [0, "success"],
      [1, "success"],
    ]);
    expect(slow[0].outputs).toContain("报告-第1次");
    expect(slow[1].outputs).toContain("报告-第2次");
    // 第 2 轮的任何一段都不早于慢评委第 1 轮的收束时刻。
    const slowFinished = slow[0].finishedAt!;
    expect(slowFinished).not.toBeNull();
    for (const row of rows.filter((r) => r.round > 0)) {
      expect(row.startedAt).toBeGreaterThanOrEqual(slowFinished);
    }
    // 评审循环里输出节点第 1 轮被跳过、第 2 轮成功；每个 (节点, 轮次) 只有一行。
    expect(rows.filter((r) => r.nodeId === "output-node").map((r) => [r.round, r.status])).toEqual([
      [0, "skipped"],
      [1, "success"],
    ]);
    expect(new Set(rows.map((r) => `${r.nodeId}#${r.round}`)).size).toBe(rows.length);
    expect(rows.every((r) => r.status !== "running")).toBe(true);
    for (const nodeId of [
      "input-node",
      "writer-node",
      "fast-node",
      "slow-node",
      "merge-node",
      "output-node",
    ]) {
      expect([nodeId, nodeStatus(runId, nodeId)]).toEqual([nodeId, "success"]);
    }
    // 环体只推进了一轮：每个 Action 各跑两次。
    expect([...fan.calls.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))).toEqual([
      ["fast-node", 2],
      ["merge-node", 1],
      ["slow-node", 2],
      ["writer-node", 2],
    ]);
  });

  it("挂起期间被取消：这次重入作废，没有任何第 2 轮", async () => {
    sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
    const fan = fanOutControls();

    const startedRun = await startRun("workflow-fanout-loop", {
      "input-node": { kind: "text", text: "两数之和" },
    });
    expect(startedRun.ok).toBe(true);
    if (!startedRun.ok) return;
    const runId = startedRun.runId;

    await fan.rejected;
    await vi.waitFor(() => {
      expect(nodeStatus(runId, "fast-node")).toBe("success");
    });
    await expect(cancelRun(runId)).resolves.toEqual({ ok: true });
    fan.release();

    await vi.waitFor(() => {
      expect(isRunExecutionActive(runId)).toBe(false);
    });

    const run = sqlite.prepare("select status, error from runs where id = ?").get(runId) as {
      status: string;
      error: string | null;
    };
    expect(run.status).toBe("cancelled");
    expect(run.error).toBeNull();
    const rows = roundRows(runId);
    // 挂起的重入随取消作废：环体一个节点都没有第 2 轮。
    expect(rows.filter((r) => r.round > 0)).toEqual([]);
    const slow = rows.find((r) => r.nodeId === "slow-node")!;
    expect(slow.status).toBe("cancelled");
    expect(slow.finishedAt).not.toBeNull();
    expect(rows.every((r) => r.status !== "running")).toBe(true);
    expect(nodeStatus(runId, "slow-node")).toBe("cancelled");
    expect(nodeStatus(runId, "writer-node")).toBe("success");
    expect(fan.calls.get("merge-node")).toBeUndefined();
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
      const run = sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(startedRun.runId) as {
        status: string;
      };
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
