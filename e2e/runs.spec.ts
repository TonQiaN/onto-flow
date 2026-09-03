import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { expect, test, type APIRequestContext } from "@playwright/test";
import Database from "better-sqlite3";
import { cleanupByPrefix } from "./helpers";

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
