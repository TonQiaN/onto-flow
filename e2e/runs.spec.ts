import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { cleanupByPrefix, openDb } from "./helpers";

interface RunFixture {
  workflowId: string;
  workflowName: string;
  runId: string;
  runDir: string;
  nodeA: string;
  nodeB: string;
}

interface FixtureEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
  surfaceOp?: "append";
}

const PREFIX = "e2e-轨迹-";
const RUNS_ROOT = path.join(process.cwd(), "data", "runs");

/** 与 dsh-session-persistence-jsonl rc.2 相同的单段编码，覆盖回合会话里的 #。 */
function encodeSessionSegment(raw: string): string {
  let encoded = "";
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);
    const character = String.fromCharCode(code);
    encoded +=
      character !== "~" && /^[A-Za-z0-9._-]$/.test(character)
        ? character
        : `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return encoded;
}

function eventLog(sessionId: string, startedAt: number, marker: string, withTool: boolean): string {
  const events: FixtureEvent[] = [];
  const push = (type: string, offset: number, data: Record<string, unknown>) => {
    const surface = ["user/message", "assistant/message", "tool/result"].includes(type);
    events.push({
      type,
      seq: events.length,
      time: startedAt + offset,
      data,
      ...(surface ? { surfaceOp: "append" as const } : {}),
    });
  };

  push("turn/start", 0, { turn: 1 });
  push("step/start", 1, { turn: 1, step: 1 });
  push("user/message", 2, {
    role: "user",
    id: `user-${marker}`,
    content: [{ type: "text", text: `USER_${marker}` }],
    source: { kind: "user" },
  });
  push("user/message", 3, {
    role: "user",
    id: `context-${marker}`,
    content: [{ type: "text", text: `CONTEXT_${marker}` }],
    source: { kind: "agent-instructions" },
  });
  push("request/header", 4, {
    reason: "initial",
    header: {
      config: {
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        reasoningEffort: "low",
      },
      system: `SYSTEM_${marker}`,
      tools: withTool
        ? [
            {
              name: "read",
              description: "读取合成测试文件",
              parameters: {
                type: "object",
                properties: { path: { type: "string" } },
              },
            },
          ]
        : [],
    },
  });
  push("request/context", 5, {
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    contextWindow: 1_000_000,
  });

  if (withTool) {
    push("assistant/message", 20, {
      turn: 1,
      step: 1,
      message: {
        role: "assistant",
        id: `assistant-${marker}`,
        source: {
          kind: "model",
          provider: "deepseek-official",
          model: "deepseek-v4-flash",
        },
        content: [
          {
            type: "tool-call",
            id: `call-${marker}`,
            name: "read",
            arguments: JSON.stringify({ path: "inputs/sample.md" }),
          },
        ],
      },
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        reasoningTokens: 2,
        cacheReadTokens: 50,
        cacheWriteTokens: 0,
      },
    });
    push("tool/call", 21, {
      turn: 1,
      step: 1,
      callId: `call-${marker}`,
      name: "read",
      arguments: JSON.stringify({ path: "inputs/sample.md", marker }),
    });
    push("tool/result", 30, {
      turn: 1,
      step: 1,
      message: {
        role: "user",
        id: `tool-result-${marker}`,
        source: { kind: "tool", callId: `call-${marker}` },
        content: [
          {
            type: "tool-result",
            toolCallId: `call-${marker}`,
            isError: false,
            content: [{ type: "text", text: `TOOL_OUTPUT_${marker}` }],
          },
        ],
      },
      meta: { fixture: true },
    });
  } else {
    push("assistant/message", 20, {
      turn: 1,
      step: 1,
      message: {
        role: "assistant",
        id: `assistant-${marker}`,
        source: {
          kind: "model",
          provider: "deepseek-official",
          model: "deepseek-v4-flash",
        },
        content: [
          { type: "reasoning", text: `REASONING_${marker}` },
          { type: "text", text: `ANSWER_${marker}` },
        ],
      },
      usage: {
        inputTokens: 80,
        outputTokens: 20,
        reasoningTokens: 4,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });
  }

  push("step/end", 35, { turn: 1, step: 1 });
  push("turn/end", 36, { turn: 1, reason: { kind: "completed" } });

  return [
    JSON.stringify({
      type: "session",
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: startedAt,
      cwd: "/e2e/workspace",
      delegationDepth: 0,
    }),
    ...events.map((event) => JSON.stringify(event)),
    "",
  ].join("\n");
}

async function writeSession(runDir: string, sessionId: string, contents: string): Promise<void> {
  const dir = path.join(runDir, "sessions", "--e2e-workspace--", encodeSessionSegment(sessionId));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "session.jsonl"), contents, "utf8");
}

function fixtureWorkflowDir(runDir: string): string | null {
  const candidate = path.resolve(runDir);
  const relative = path.relative(RUNS_ROOT, candidate);
  const segments = relative.split(path.sep);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    segments.length !== 2 ||
    segments.some((segment) => segment === "")
  ) {
    return null;
  }
  return path.dirname(candidate);
}

async function createFixture(request: APIRequestContext): Promise<RunFixture> {
  const workflowId = randomUUID();
  const runId = randomUUID();
  const nodeA = randomUUID();
  const nodeB = randomUUID();
  const runDir = path.join(process.cwd(), "data", "runs", workflowId, runId);
  const now = Date.now() - 10_000;
  const workflowName = `${PREFIX}${workflowId.slice(0, 8)}`;
  const fixture = { workflowId, workflowName, runId, runDir, nodeA, nodeB };
  const dataRoot = path.join(process.cwd(), "data");
  const artifactA = path.join(runDir, "workspace", "trajectory-a.md");
  const artifactB = path.join(runDir, "workspace", "trajectory-b.md");

  try {
    await mkdir(path.dirname(artifactA), { recursive: true });
    await Promise.all([
      writeFile(artifactA, "合成轨迹产物 A", "utf8"),
      writeFile(artifactB, "合成轨迹产物 B", "utf8"),
    ]);
    await writeSession(runDir, nodeA, eventLog(nodeA, now, "A_ROUND_1", true));
    await writeSession(runDir, `${nodeA}#2`, eventLog(`${nodeA}#2`, now + 100, "A_ROUND_2", false));
    await writeSession(runDir, nodeB, eventLog(nodeB, now + 200, "B_ONLY_SENTINEL", false));

    const database = new Database(path.join(process.cwd(), "data", "ontoflow.db"));
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    const snapshot = JSON.stringify({
      actionName: "合成 Action",
      prompt: "合成轨迹测试",
      rule: "只使用测试数据",
      model: {
        providerId: "deepseek-official",
        modelId: "deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
      },
      reasoningEffort: "low",
      skills: [],
      tools: [],
      ports: { inputs: [], outputs: [] },
    });
    try {
      const insert = database.transaction(() => {
        database
          .prepare(
            "insert into workflows (id, name, description, created_at, updated_at) values (?, ?, '', ?, ?)",
          )
          .run(workflowId, workflowName, now, now);
        database
          .prepare(
            "insert into runs (id, workflow_id, status, workflow_name, started_at, finished_at, run_dir) values (?, ?, 'success', ?, ?, ?, ?)",
          )
          .run(
            runId,
            workflowId,
            workflowName,
            now,
            now + 1_000,
            path.relative(process.cwd(), runDir),
          );
        const statement = database.prepare(
          "insert into run_nodes (id, run_id, node_id, label, status, snapshot, outputs, session_id, started_at, finished_at) values (?, ?, ?, ?, 'success', ?, ?, ?, ?, ?)",
        );
        statement.run(
          randomUUID(),
          runId,
          nodeA,
          "e2e-Agent甲",
          snapshot,
          JSON.stringify({
            结果: {
              kind: "file",
              file: {
                path: path.relative(dataRoot, artifactA),
                name: path.basename(artifactA),
                mime: "text/markdown",
              },
            },
          }),
          `${nodeA}#2`,
          now,
          now + 136,
        );
        statement.run(
          randomUUID(),
          runId,
          nodeB,
          "e2e-Agent乙",
          snapshot,
          JSON.stringify({
            结果: {
              kind: "file",
              file: {
                path: path.relative(dataRoot, artifactB),
                name: path.basename(artifactB),
                mime: "text/markdown",
              },
            },
          }),
          nodeB,
          now + 200,
          now + 236,
        );
      });
      insert();
    } finally {
      database.close();
    }
    return fixture;
  } catch (error) {
    await removeFixture(fixture, request);
    throw error;
  }
}

async function removeFixture(
  fixture: RunFixture | null,
  request: APIRequestContext,
): Promise<void> {
  if (!fixture) return;
  try {
    const database = new Database(path.join(process.cwd(), "data", "ontoflow.db"));
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    try {
      // 测试中断在模拟运行态时先结束这条合成 run，让正式 DELETE 的运行中保护
      // 仍然生效；实体删除本身统一走 cleanupByPrefix。
      database
        .prepare(
          "update runs set status = 'failed', finished_at = ? where id = ? and status = 'running'",
        )
        .run(Date.now(), fixture.runId);
    } finally {
      database.close();
    }
    await cleanupByPrefix(request, "/api/workflows", PREFIX);
  } finally {
    const workflowDir = fixtureWorkflowDir(fixture.runDir);
    if (workflowDir) await rm(workflowDir, { recursive: true, force: true });
  }
}

/** 清掉上次进程被中断时遗留的本 spec 数据；前缀与 data/runs 双重收敛。 */
async function removeStaleFixtures(request: APIRequestContext): Promise<void> {
  const database = new Database(path.join(process.cwd(), "data", "ontoflow.db"));
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  let runDirs: Array<{ runDir: string | null }> = [];
  try {
    runDirs = database
      .prepare(
        "select r.run_dir as runDir from runs r join workflows w on w.id = r.workflow_id where w.name like ?",
      )
      .all(`${PREFIX}%`) as Array<{ runDir: string | null }>;
    database
      .prepare(
        "update runs set status = 'failed', finished_at = ? where status = 'running' and workflow_id in (select id from workflows where name like ?)",
      )
      .run(Date.now(), `${PREFIX}%`);
  } finally {
    database.close();
  }
  await cleanupByPrefix(request, "/api/workflows", PREFIX);
  for (const row of runDirs) {
    if (!row.runDir) continue;
    const workflowDir = fixtureWorkflowDir(path.resolve(process.cwd(), row.runDir));
    if (workflowDir) await rm(workflowDir, { recursive: true, force: true });
  }
}

function setFixtureActive(fixture: RunFixture): void {
  const database = new Database(path.join(process.cwd(), "data", "ontoflow.db"));
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  try {
    database
      .prepare("update runs set status = 'running', finished_at = null where id = ?")
      .run(fixture.runId);
    database
      .prepare(
        "update run_nodes set status = 'running', finished_at = null where run_id = ? and node_id = ?",
      )
      .run(fixture.runId, fixture.nodeA);
  } finally {
    database.close();
  }
}

function finishFixture(fixture: RunFixture): void {
  const database = new Database(path.join(process.cwd(), "data", "ontoflow.db"));
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  try {
    const finishedAt = Date.now();
    database
      .prepare("update runs set status = 'success', finished_at = ? where id = ?")
      .run(finishedAt, fixture.runId);
  } finally {
    database.close();
  }
}

async function replaceFixtureArtifact(
  fixture: RunFixture,
  relativeName: string,
  content: string,
): Promise<void> {
  const artifact = path.join(fixture.runDir, "workspace", relativeName);
  await mkdir(path.dirname(artifact), { recursive: true });
  await writeFile(artifact, content, "utf8");
  const database = new Database(path.join(process.cwd(), "data", "ontoflow.db"));
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  try {
    database.prepare("update run_nodes set outputs = ? where run_id = ? and node_id = ?").run(
      JSON.stringify({
        结果: {
          kind: "file",
          file: {
            path: path.relative(path.join(process.cwd(), "data"), artifact),
            name: path.basename(artifact),
            mime: "text/markdown",
          },
        },
      }),
      fixture.runId,
      fixture.nodeA,
    );
  } finally {
    database.close();
  }
}

/**
 * 轨迹用完全合成的本地会话日志，避免失败 trace 把真实简历或模型上下文收进去。
 * fixture 只用 e2e 专属前缀与本 case 持有的目录清理，不触碰真实运行。
 */
test.describe("运行历史", () => {
  let fixture: RunFixture | null = null;

  test.beforeAll(async ({ request }) => {
    await removeStaleFixtures(request);
  });

  test.beforeEach(async ({ request }) => {
    fixture = await createFixture(request);
  });

  test.afterEach(async ({ page, request }) => {
    try {
      await page.goto("/");
    } finally {
      await removeFixture(fixture, request);
      fixture = null;
    }
  });

  test("每个 Action 按需展示独立、可检索的会话轨迹", async ({ page }) => {
    const current = fixture!;
    setFixtureActive(current);
    const trajectoryRequests: string[] = [];
    const trajectoryResponses: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/trajectory")) trajectoryRequests.push(request.url());
    });
    page.on("response", (response) => {
      if (response.url().includes("/trajectory")) trajectoryResponses.push(response.url());
    });

    let releaseInitialRequest!: () => void;
    const initialRequestGate = new Promise<void>((resolve) => {
      releaseInitialRequest = resolve;
    });
    let holdFirstTrajectoryRequest = true;
    await page.route("**/trajectory", async (route) => {
      if (holdFirstTrajectoryRequest) {
        holdFirstTrajectoryRequest = false;
        await initialRequestGate;
      }
      await route.continue();
    });

    await page.goto(`/runs?workflowId=${current.workflowId}`);
    const runRow = page.locator("tbody tr").filter({ hasText: current.workflowName });
    await expect(runRow).toHaveCount(1);
    await runRow.click();
    await page.waitForURL(`/runs/${current.runId}`);
    await expect(page.getByRole("heading", { name: "运行详情", exact: true })).toBeVisible();
    await expect(page.getByTestId("run-workspace-path")).toHaveText(
      path.relative(process.cwd(), path.join(current.runDir, "workspace")),
    );
    await expect(page.getByRole("link", { name: "回画布看动画" })).toBeVisible();

    const cardA = page.locator(`[data-node-id="${current.nodeA}"]`);
    const cardB = page.locator(`[data-node-id="${current.nodeB}"]`);
    await expect(cardA).toContainText("e2e-Agent甲");
    await expect(cardB).toContainText("e2e-Agent乙");
    await expect(cardA).toContainText("输出");
    await expect(cardA).toContainText("trajectory-a.md");
    await cardA.getByRole("button", { name: "查看内容" }).click();
    await expect(cardA).toContainText("合成轨迹产物 A");
    await expect(cardB).toContainText("输出");
    await expect(cardB).toContainText("trajectory-b.md");
    expect(trajectoryRequests).toHaveLength(0);

    const toggleA = cardA.getByTestId("agent-trajectory-toggle");
    await expect(toggleA).toHaveAttribute("aria-expanded", "false");
    const initialRequestPromise = page.waitForRequest((request) =>
      request.url().includes(`/nodes/${current.nodeA}/trajectory`),
    );
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes(`/nodes/${current.nodeA}/trajectory`) && response.ok(),
    );
    await toggleA.click();
    await initialRequestPromise;

    // 首次读取尚未返回时只让 run 进入终态，刻意保留 node=running；这样
    // status prop 不变，只有 active 会变化。终态 effect 必须把刷新排队，且
    // 在 gate 释放前仍只能有一个请求，不能并发补拉或依赖定时轮询兜底。
    finishFixture(current);
    await expect(page.getByRole("link", { name: "回画布看动画" })).toHaveCount(0, {
      timeout: 1_000,
    });
    expect(trajectoryRequests).toHaveLength(1);
    releaseInitialRequest();
    const response = await responsePromise;
    const payload = (await response.json()) as {
      available: boolean;
      sessions: Array<{
        round: number;
        model: string;
        records: Array<{
          id: string;
          kind: string;
          callId?: string;
          details: Array<{ label: string; content: string }>;
        }>;
      }>;
    };
    expect(payload.available).toBe(true);
    expect(payload.sessions.map((session) => session.round)).toEqual([1, 2]);
    expect(payload.sessions[0]?.records[0]?.kind).toBe("system");

    await expect.poll(() => trajectoryResponses.length).toBe(2);
    expect(trajectoryRequests).toHaveLength(2);

    const panelA = cardA.getByTestId("agent-trajectory-panel");
    await expect(panelA).toBeVisible();
    await expect(panelA).toContainText("输入");
    await expect(panelA).toContainText("模型");
    await expect(panelA).toContainText("工具");
    await expect(panelA).toContainText("deepseek-official/deepseek-v4-flash");
    await expect(panelA).not.toContainText("B_ONLY_SENTINEL");

    await panelA.getByRole("button", { name: "第 1 轮", exact: true }).click();
    const roundOne = payload.sessions[0]!;
    await expect(panelA.getByTestId("trajectory-record")).toHaveCount(roundOne.records.length);

    const tool = roundOne.records.find(
      (record) => record.kind === "tool" && record.callId === "call-A_ROUND_1",
    );
    expect(tool).toBeTruthy();
    await panelA
      .getByTestId("trajectory-record")
      .filter({ has: page.getByText("工具", { exact: true }) })
      .click();
    for (const detail of tool!.details) {
      await panelA.getByRole("button", { name: detail.label, exact: true }).click();
      await expect(panelA.getByTestId("trajectory-detail")).toContainText(detail.content);
    }

    await panelA.getByRole("searchbox", { name: "搜索 Agent 轨迹" }).fill("TOOL_OUTPUT_A_ROUND_1");
    await expect(panelA.getByTestId("trajectory-record")).toHaveCount(1);
    await expect(panelA).not.toContainText("B_ONLY_SENTINEL");

    await cardB.getByTestId("agent-trajectory-toggle").click();
    const panelB = cardB.getByTestId("agent-trajectory-panel");
    await expect(panelB).toContainText("B_ONLY_SENTINEL");
    expect(trajectoryRequests).toHaveLength(3);
  });

  test("循环换轮时文件预览随产物路径重置，双点开头文件仍可读取", async ({ page, request }) => {
    const current = fixture!;
    setFixtureActive(current);
    await page.goto(`/runs/${current.runId}`);
    const cardA = page.locator(`[data-node-id="${current.nodeA}"]`);
    await cardA.getByRole("button", { name: "查看内容" }).click();
    await expect(cardA).toContainText("合成轨迹产物 A");

    await replaceFixtureArtifact(current, "rounds/2/round-two.md", "第二轮独立产物");
    await expect(cardA).toContainText("round-two.md");
    await expect(cardA).not.toContainText("合成轨迹产物 A");
    await expect(cardA.getByRole("button", { name: "查看内容" })).toBeVisible();
    await cardA.getByRole("button", { name: "查看内容" }).click();
    await expect(cardA).toContainText("第二轮独立产物");

    const dotFile = path.join(current.runDir, "workspace", "..report.md");
    await writeFile(dotFile, "双点开头是合法文件名", "utf8");
    const response = await request.get(`/api/runs/${current.runId}/files`, {
      params: { path: path.relative(path.join(process.cwd(), "data"), dotFile) },
    });
    expect(response.status()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      name: "..report.md",
      content: "双点开头是合法文件名",
    });
  });
});

/* --------------------------- 运行列表的筛选、分页与用量汇总 --------------------------- */

const LIST_PREFIX = "e2e-运行列表-";
const DAY_MS = 86_400_000;

interface ListFixture {
  workflowId: string;
  workflowName: string;
  /** 画布发起、成功、三天前；有 node_usage 明细 */
  canvasRunId: string;
  canvasStartedAt: number;
  /** 调用入口发起、失败、今天；刻意没有任何用量，用来验汇总不把零用量的运行挤掉 */
  apiRunId: string;
  apiStartedAt: number;
}

interface RunsEnvelope {
  items: Array<{ id: string; source: string; status: string; workflowId: string }>;
  total: number;
  page: number;
  pageSize: number;
  summary: {
    runs: number;
    tokens: number;
    cost: number;
    byModel: Array<{ providerId: string; modelId: string; tokens: number; cost: number }>;
  };
}

/** 与 src/app/runs/lib.ts 同口径：e2e 不从 src 引模块，格式化按同一规则复刻一份。 */
function formatTokens(n: number): string {
  return Math.round(n).toLocaleString("zh-CN");
}

function formatCost(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "¥0";
  if (n < 0.0001) return "<¥0.0001";
  return `¥${n.toFixed(4)}`;
}

/** 日期输入框的 yyyy-MM-dd：按本地时区，与页面的换算同一套 */
function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 两条合成运行：来源、状态、开始日期三处都不同，够时间范围与来源筛选各挑出一条。
 * 直接写库（runs / run_nodes / node_usage）不落磁盘目录——列表页不读运行目录；
 * 收尾删工作流即按外键级联收走这三张表的行。
 */
function createListFixture(): ListFixture {
  const workflowId = randomUUID();
  const workflowName = `${LIST_PREFIX}${workflowId.slice(0, 8)}`;
  const canvasRunId = randomUUID();
  const apiRunId = randomUUID();
  // 取「本地当天 0 点 + 1 秒」而不是 now：无论几点跑，这条运行都稳稳落在今天这一格里
  const apiStartedAt = startOfLocalDay(Date.now()) + 1_000;
  const canvasStartedAt = apiStartedAt - 3 * DAY_MS;
  const canvasNodeA = randomUUID();
  const canvasNodeB = randomUUID();

  const database = openDb();
  try {
    database.transaction(() => {
      database
        .prepare(
          "insert into workflows (id, name, description, created_at, updated_at) values (?, ?, '', ?, ?)",
        )
        .run(workflowId, workflowName, canvasStartedAt, apiStartedAt);

      const insertRun = database.prepare(
        "insert into runs (id, workflow_id, status, workflow_name, imports, started_at, finished_at) values (?, ?, ?, ?, ?, ?, ?)",
      );
      insertRun.run(
        canvasRunId,
        workflowId,
        "success",
        workflowName,
        // 来源不是列：运行列表从 imports.invocation.source 读时推导
        JSON.stringify({ invocation: { source: "workflow" } }),
        canvasStartedAt,
        canvasStartedAt + 12_000,
      );
      insertRun.run(
        apiRunId,
        workflowId,
        "failed",
        workflowName,
        JSON.stringify({ invocation: { source: "resume-match-api", contractVersion: 1 } }),
        apiStartedAt,
        apiStartedAt + 3_000,
      );

      const insertNode = database.prepare(
        "insert into run_nodes (id, run_id, node_id, label, status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, started_at, finished_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      insertNode.run(
        randomUUID(),
        canvasRunId,
        canvasNodeA,
        "e2e-列表-生成",
        "success",
        1_000,
        200,
        0,
        0,
        0.0021,
        canvasStartedAt,
        canvasStartedAt + 6_000,
      );
      insertNode.run(
        randomUUID(),
        canvasRunId,
        canvasNodeB,
        "e2e-列表-复核",
        "success",
        300,
        100,
        0,
        0,
        0.0034,
        canvasStartedAt + 6_000,
        canvasStartedAt + 12_000,
      );
      insertNode.run(
        randomUUID(),
        apiRunId,
        randomUUID(),
        "e2e-列表-匹配",
        "failed",
        0,
        0,
        0,
        0,
        0,
        apiStartedAt,
        apiStartedAt + 3_000,
      );

      const insertUsage = database.prepare(
        "insert into node_usage (id, run_id, node_id, session_id, message_id, provider_id, model_id, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost, ts) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      insertUsage.run(
        randomUUID(),
        canvasRunId,
        canvasNodeA,
        canvasNodeA,
        "turn1-step1",
        "deepseek-official",
        "deepseek-chat",
        1_000,
        200,
        0,
        0,
        0,
        0.0021,
        canvasStartedAt + 1_000,
      );
      insertUsage.run(
        randomUUID(),
        canvasRunId,
        canvasNodeB,
        canvasNodeB,
        "turn1-step1",
        "deepseek-official",
        "deepseek-reasoner",
        300,
        100,
        0,
        0,
        0,
        0.0034,
        canvasStartedAt + 7_000,
      );
    })();
  } finally {
    database.close();
  }

  return {
    workflowId,
    workflowName,
    canvasRunId,
    canvasStartedAt,
    apiRunId,
    apiStartedAt,
  };
}

function tableRunIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="runs-table"] tbody tr')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-run-id") ?? ""));
}

function byModelRows(page: Page): Promise<string[][]> {
  return page
    .locator('[data-testid="runs-summary-by-model"] tbody tr')
    .evaluateAll((rows) =>
      rows.map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? "")),
    );
}

/**
 * 断言表格与「同参数」载荷一致：URL 上的筛选参数原样发给 /api/runs，
 * 页面渲染出的 id 序列必须等于 items 的 id 序列（顺序也算）。
 * 不断言条数、不断言某一行恰好是谁——真实运行历史会长，只有载荷说了算。
 */
async function expectTableMatchesPayload(page: Page): Promise<RunsEnvelope> {
  const { search } = new URL(page.url());
  const res = await page.request.get(`/api/runs${search}`);
  expect(res.ok()).toBeTruthy();
  const payload = (await res.json()) as RunsEnvelope;
  await expect.poll(() => tableRunIds(page)).toEqual(payload.items.map((item) => item.id));
  return payload;
}

test.describe("运行列表筛选", () => {
  let listFixture: ListFixture;

  test.beforeAll(async ({ request }) => {
    // 上次进程被中断的残留：删工作流即级联收走运行、节点与用量
    await cleanupByPrefix(request, "/api/workflows", LIST_PREFIX);
    listFixture = createListFixture();
  });

  test.afterAll(async ({ request }) => {
    await cleanupByPrefix(request, "/api/workflows", LIST_PREFIX);
  });

  test("工作流与来源筛选：表格行与同参数载荷的 items 一致", async ({ page }) => {
    await page.goto("/runs");

    const workflowSelect = page.getByTestId("runs-filter-workflow");
    await expect(workflowSelect.locator(`option[value="${listFixture.workflowId}"]`)).toHaveCount(
      1,
    );
    await workflowSelect.selectOption(listFixture.workflowId);
    await page.waitForURL((url) => url.searchParams.get("workflowId") === listFixture.workflowId);
    const all = await expectTableMatchesPayload(page);
    expect(all.items.map((item) => item.id).sort()).toEqual(
      [listFixture.canvasRunId, listFixture.apiRunId].sort(),
    );

    await page.getByTestId("runs-filter-source").selectOption("resume-match-api");
    await page.waitForURL((url) => url.searchParams.get("source") === "resume-match-api");
    const viaApi = await expectTableMatchesPayload(page);
    expect(viaApi.items.map((item) => item.id)).toEqual([listFixture.apiRunId]);
    expect(viaApi.items.every((item) => item.source === "resume-match-api")).toBe(true);
    await expect(page.getByTestId("runs-table")).toContainText("resume-match-api");

    await page.getByTestId("runs-filter-source").selectOption("workflow");
    await page.waitForURL((url) => url.searchParams.get("source") === "workflow");
    const viaCanvas = await expectTableMatchesPayload(page);
    expect(viaCanvas.items.map((item) => item.id)).toEqual([listFixture.canvasRunId]);
    await expect(page.getByTestId("runs-table")).toContainText("画布发起");
  });

  test("状态筛选：表格行与同参数载荷的 items 一致", async ({ page }) => {
    await page.goto(`/runs?workflowId=${listFixture.workflowId}`);

    await page.getByTestId("runs-filter-status").selectOption("failed");
    await page.waitForURL((url) => url.searchParams.get("status") === "failed");
    const failed = await expectTableMatchesPayload(page);
    expect(failed.items.map((item) => item.id)).toEqual([listFixture.apiRunId]);

    await page.getByTestId("runs-filter-status").selectOption("success");
    await page.waitForURL((url) => url.searchParams.get("status") === "success");
    const success = await expectTableMatchesPayload(page);
    expect(success.items.map((item) => item.id)).toEqual([listFixture.canvasRunId]);
  });

  test("时间范围筛选：起止同选今天时只剩今天开始的那条运行", async ({ page }) => {
    await page.goto(`/runs?workflowId=${listFixture.workflowId}`);
    const today = localDate(listFixture.apiStartedAt);

    // 两个日期各等一次 URL 落地再填下一个：两次 router.replace 挤在同一瞬间时，
    // 后一次可能在前一次的导航尚未提交时被吞掉（CI 与本机高负载下都撞到过），人手不会这么快。
    await page.getByTestId("runs-filter-from").fill(today);
    await page.waitForURL((url) => url.searchParams.has("from"));
    await page.getByTestId("runs-filter-to").fill(today);
    await page.waitForURL((url) => url.searchParams.has("from") && url.searchParams.has("to"));

    const payload = await expectTableMatchesPayload(page);
    expect(payload.items.map((item) => item.id)).toEqual([listFixture.apiRunId]);

    // 窗口是左闭右开：结束日选今天，今天开始的运行仍在窗内，三天前那条被挡在 from 之前
    const params = new URL(page.url()).searchParams;
    const from = Number(params.get("from"));
    const to = Number(params.get("to"));
    expect(listFixture.apiStartedAt).toBeGreaterThanOrEqual(from);
    expect(listFixture.apiStartedAt).toBeLessThan(to);
    expect(listFixture.canvasStartedAt).toBeLessThan(from);

    // 毫秒住 URL，回填输入框要还原成同一天（结束日是次日 0 点，减 1 毫秒才落回当天）
    await page.reload();
    await expect(page.getByTestId("runs-filter-from")).toHaveValue(today);
    await expect(page.getByTestId("runs-filter-to")).toHaveValue(today);
    await expectTableMatchesPayload(page);
  });

  test("汇总行与按模型小表与载荷一致，零用量的运行仍计入运行数", async ({ page }) => {
    await page.goto(`/runs?workflowId=${listFixture.workflowId}`);
    const payload = await expectTableMatchesPayload(page);

    const summaryText = (await page.getByTestId("runs-summary").innerText()).replace(/\s+/g, " ");
    expect(summaryText).toContain(`运行数 ${payload.summary.runs}`);
    expect(summaryText).toContain(`总 token ${formatTokens(payload.summary.tokens)}`);
    expect(summaryText).toContain(`总费用 ${formatCost(payload.summary.cost)}`);
    // 两条运行里只有画布那条有 node_usage，汇总仍要数到两条
    expect(payload.summary.runs).toBe(2);

    expect(await byModelRows(page)).toEqual(
      payload.summary.byModel.map((m) => [
        m.providerId,
        m.modelId,
        formatTokens(m.tokens),
        formatCost(m.cost),
      ]),
    );
    expect(payload.summary.byModel.length).toBeGreaterThan(0);

    // 筛到没有任何用量的那条运行：按模型小表退化成「—」
    await page.getByTestId("runs-filter-source").selectOption("resume-match-api");
    await page.waitForURL((url) => url.searchParams.get("source") === "resume-match-api");
    const apiOnly = await expectTableMatchesPayload(page);
    expect(apiOnly.summary.byModel).toEqual([]);
    await expect(page.getByTestId("runs-summary-by-model")).toContainText("—");
  });

  test("筛选住 URL：刷新不丢，换筛选回到第 1 页", async ({ page }) => {
    await page.goto(`/runs?workflowId=${listFixture.workflowId}`);
    await page.getByTestId("runs-filter-status").selectOption("failed");
    await page.waitForURL((url) => url.searchParams.get("status") === "failed");
    await page.getByTestId("runs-filter-source").selectOption("resume-match-api");
    await page.waitForURL((url) => url.searchParams.get("source") === "resume-match-api");

    const before = new URL(page.url()).searchParams;
    expect(before.get("workflowId")).toBe(listFixture.workflowId);
    expect(before.get("status")).toBe("failed");
    expect(before.get("source")).toBe("resume-match-api");

    await page.reload();
    await expect(page.getByTestId("runs-filter-workflow")).toHaveValue(listFixture.workflowId);
    await expect(page.getByTestId("runs-filter-status")).toHaveValue("failed");
    await expect(page.getByTestId("runs-filter-source")).toHaveValue("resume-match-api");
    const payload = await expectTableMatchesPayload(page);
    expect(payload.items.map((item) => item.id)).toEqual([listFixture.apiRunId]);

    // 换筛选回到第 1 页：cancelled 一条都没有，页码不会被越界回夹改写，只可能是筛选自己清的
    await page.goto(`/runs?workflowId=${listFixture.workflowId}&status=cancelled&page=2`);
    await expect(page.getByText("没有符合筛选条件的运行记录")).toBeVisible();
    expect(new URL(page.url()).searchParams.get("page")).toBe("2");
    await page.getByTestId("runs-filter-status").selectOption("failed");
    await page.waitForURL((url) => url.searchParams.get("status") === "failed");
    expect(new URL(page.url()).searchParams.has("page")).toBe(false);
    await expectTableMatchesPayload(page);
  });
});
