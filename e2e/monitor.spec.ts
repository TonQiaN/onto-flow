import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { cleanupByPrefix, DATA_DIR, openDb } from "./helpers";

/**
 * 监控台（/monitor 六个标签页）的端到端覆盖。
 *
 * 只读纪律：本文件**绝不**点击「执行清理」/「确认删除」/「中止该运行」，
 * 也不发起任何工作流运行（真实调模型，昂贵）。清理面板只走 dryRun 预览路径。
 *
 * 历史数据不靠库里既有的付费运行：CI 的库只有 db:seed 的五个库，一次运行都没有。
 * beforeAll 用与 runs.spec.ts 相同的模式合成一份本 spec 自己的运行历史——e2e- 前缀的
 * 工作流、一条已结束的运行、两个 Action 节点、十条 run_events、三条 node_usage，
 * 外加一个真实落盘的运行目录。断言只针对这份夹具，其余一律取页面自己消费的 API 载荷、
 * 断言 DOM 与之一致（含空态）；从不假设「最近一次运行是哪一条」这类会随真实使用漂移的事。
 * afterAll 经 DELETE /api/runs/[id] 与 cleanupByPrefix 收走，运行目录一并删除。
 */

const PREFIX = "e2e-监控-";
const RUNS_ROOT = path.join(DATA_DIR, "runs");
/** 夹具工作区里产物的体积：磁盘占用行要能显示出非零、且不止几字节的 data/runs 体积 */
const WORKSPACE_BYTES = 4096;
const PROVIDER_ID = "deepseek-official";
const MODEL_ID = "deepseek-v4-flash";
const RUN_ERROR = "e2e 合成的会话错误";

interface MonitorFixture {
  workflowId: string;
  workflowName: string;
  runId: string;
  runDir: string;
  nodeA: string;
  nodeB: string;
  labelA: string;
  labelB: string;
  /** 只出现在本夹具 payload 里的检索词；含下划线，专门验 LIKE 转义 */
  keyword: string;
  /** 把 keyword 的下划线换成连字符的诱饵：`_` 若被当成单字符通配符就会误命中它 */
  keywordDecoy: string;
  /** 把 keyword 的下划线换成 `%` 的探针：`%` 若被当成通配符就会命中 keyword 行 */
  keywordProbe: string;
  /** payload 含 keyword 的事件数（一条 text + 一条 tool 输出） */
  keywordEvents: number;
  /** 错误类事件数（一条 tool error + 一条 session.error） */
  errorEvents: number;
  /** 本运行写入的事件总数 */
  events: number;
}

interface LogsPayload {
  items: Array<{ id: number; payload: Record<string, unknown> | null }>;
}

interface TracePayload {
  run: { workflowName: string; tokens: number; cost: number };
  spans: Array<{ id: string; kind: string; label: string }>;
}

interface CostPayload {
  days: number;
  byModel: Array<{
    modelId: string;
    providerId: string;
    messages: number;
    tokens: number;
    cost: number;
  }>;
}

interface HealthPayload {
  disk: { runsDir: { bytes: number; dirs: number } };
}

interface SessionsPayload {
  items: Array<{ sessionId: string; workflowName: string }>;
}

/* ------------------------------ 展示格式的镜像 ------------------------------ */

/** 与 src/app/runs/lib.ts 的 formatCost / formatTokens 同款：按载荷算出 DOM 应显示的文本 */
function formatCost(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "¥0";
  if (n < 0.0001) return "<¥0.0001";
  return `¥${n.toFixed(4)}`;
}

function formatTokens(n: number): string {
  return Math.round(n).toLocaleString("zh-CN");
}

/** 与 src/app/monitor/health/lib.ts 的 formatBytes / formatCount 同款 */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

const formatCount = formatTokens;

/* --------------------------------- 夹具 --------------------------------- */

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

/**
 * 合成一条已结束（failed）的运行：节点甲成功，节点乙以会话错误失败。
 * 事件与用量的时间都落在「现在」之前一分钟内，因此成本页近 7 天窗口、总览近 24 小时桶都能看到它。
 */
async function createFixture(request: APIRequestContext): Promise<MonitorFixture> {
  const suffix = randomUUID().slice(0, 8);
  const workflowId = randomUUID();
  const runId = randomUUID();
  const nodeA = randomUUID();
  const nodeB = randomUUID();
  const workflowName = `${PREFIX}${suffix}`;
  const keyword = `e2e_monitor_kw_${suffix}`;
  const runDir = path.join(RUNS_ROOT, workflowId, runId);
  const runStart = Date.now() - 60_000;
  const fixture: MonitorFixture = {
    workflowId,
    workflowName,
    runId,
    runDir,
    nodeA,
    nodeB,
    labelA: "e2e-监控·甲",
    labelB: "e2e-监控·乙",
    keyword,
    keywordDecoy: keyword.replaceAll("_", "-"),
    keywordProbe: keyword.replaceAll("_", "%"),
    keywordEvents: 2,
    errorEvents: 2,
    events: 10,
  };

  try {
    await mkdir(path.join(runDir, "workspace"), { recursive: true });
    await writeFile(
      path.join(runDir, "workspace", "report.md"),
      `# e2e 监控夹具 ${suffix}\n${"x".repeat(WORKSPACE_BYTES)}\n`,
      "utf8",
    );

    const snapshot = JSON.stringify({
      actionName: "e2e-监控 Action",
      prompt: "合成监控测试",
      rule: "只使用测试数据",
      model: {
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        displayName: "DeepSeek V4 Flash",
      },
      reasoningEffort: "high",
      skills: [],
      tools: [],
      ports: { inputs: [], outputs: [] },
    });

    const events: Array<[string, number, string, Record<string, unknown>]> = [
      [nodeA, runStart + 2_000, "text", { text: `开始读取输入，标记 ${keyword}` }],
      [
        nodeA,
        runStart + 2_500,
        "tool",
        {
          tool: "bash",
          status: "running",
          callId: "call-a1",
          sessionId: nodeA,
          input: JSON.stringify({ command: "pdftotext inputs/a.pdf -" }),
        },
      ],
      [
        nodeA,
        runStart + 3_000,
        "tool",
        {
          tool: "bash",
          status: "ok",
          callId: "call-a1",
          sessionId: nodeA,
          output: `TOOL_OUTPUT ${keyword}`,
        },
      ],
      [
        nodeA,
        runStart + 3_200,
        "tool",
        {
          tool: "read",
          status: "running",
          callId: "call-a2",
          sessionId: nodeA,
          input: JSON.stringify({ path: "workspace/missing.md" }),
        },
      ],
      [
        nodeA,
        runStart + 3_400,
        "tool",
        {
          tool: "read",
          status: "error",
          callId: "call-a2",
          sessionId: nodeA,
          error: "Error: cannot read workspace/missing.md: not found",
        },
      ],
      [nodeA, runStart + 3_600, "text", { text: `诱饵：${fixture.keywordDecoy}` }],
      [nodeA, runStart + 5_500, "session.idle", { reason: "completed" }],
      [nodeB, runStart + 8_000, "text", { text: "汇总六份结论…" }],
      [nodeB, runStart + 9_000, "session.error", { error: RUN_ERROR }],
      [nodeB, runStart + 9_001, "session.idle", { reason: "error" }],
    ];
    expect(events.length).toBe(fixture.events);

    const database = openDb();
    try {
      const insert = database.transaction(() => {
        database
          .prepare(
            "insert into workflows (id, name, description, created_at, updated_at) values (?, ?, '', ?, ?)",
          )
          .run(workflowId, workflowName, runStart, runStart);
        database
          .prepare(
            "insert into runs (id, workflow_id, status, workflow_name, error, run_dir, started_at, finished_at) values (?, ?, 'failed', ?, ?, ?, ?, ?)",
          )
          .run(
            runId,
            workflowId,
            workflowName,
            RUN_ERROR,
            path.relative(process.cwd(), runDir),
            runStart,
            runStart + 10_000,
          );

        const node = database.prepare(
          "insert into run_nodes (id, run_id, node_id, label, status, snapshot, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost, session_id, error, started_at, finished_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)",
        );
        // 节点汇总 = 该节点各条 node_usage 之和（与引擎的结算口径一致）
        node.run(
          randomUUID(),
          runId,
          nodeA,
          fixture.labelA,
          "success",
          snapshot,
          1600,
          420,
          70,
          2300,
          0.003,
          nodeA,
          null,
          runStart + 1_000,
          runStart + 6_000,
        );
        node.run(
          randomUUID(),
          runId,
          nodeB,
          fixture.labelB,
          "failed",
          snapshot,
          300,
          50,
          10,
          0,
          0.0004,
          nodeB,
          RUN_ERROR,
          runStart + 7_000,
          runStart + 9_500,
        );

        const event = database.prepare(
          "insert into run_events (run_id, node_id, ts, type, payload) values (?, ?, ?, ?, ?)",
        );
        for (const [nodeId, ts, type, payload] of events) {
          event.run(runId, nodeId, ts, type, JSON.stringify(payload));
        }

        const usage = database.prepare(
          "insert into node_usage (id, run_id, node_id, session_id, message_id, provider_id, model_id, variant, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost, ts) values (?, ?, ?, ?, ?, ?, ?, 'high', ?, ?, ?, ?, 0, ?, ?)",
        );
        usage.run(
          randomUUID(),
          runId,
          nodeA,
          nodeA,
          "turn1-step1",
          PROVIDER_ID,
          MODEL_ID,
          1200,
          300,
          50,
          800,
          0.0021,
          runStart + 3_400,
        );
        usage.run(
          randomUUID(),
          runId,
          nodeA,
          nodeA,
          "turn1-step2",
          PROVIDER_ID,
          MODEL_ID,
          400,
          120,
          20,
          1500,
          0.0009,
          runStart + 5_400,
        );
        usage.run(
          randomUUID(),
          runId,
          nodeB,
          nodeB,
          "turn1-step1",
          PROVIDER_ID,
          MODEL_ID,
          300,
          50,
          10,
          0,
          0.0004,
          runStart + 8_500,
        );
      });
      insert();
    } finally {
      database.close();
    }
    return fixture;
  } catch (error) {
    await removeFixture(fixture, request).catch(() => undefined);
    throw error;
  }
}

/** 收尾即验收删除：运行经 DELETE /api/runs/[id] 收走（级联行 + 叶子目录），工作流走 cleanupByPrefix。 */
async function removeFixture(fixture: MonitorFixture, request: APIRequestContext): Promise<void> {
  try {
    const del = await request.delete(`/api/runs/${fixture.runId}`);
    if (!del.ok() && del.status() !== 404) {
      throw new Error(`删除夹具运行 ${fixture.runId} 失败：HTTP ${del.status()}`);
    }
    await cleanupByPrefix(request, "/api/workflows", PREFIX);
  } finally {
    // deleteRun 只删叶子 <runId>，工作流层目录由夹具自己收；只动 data/runs/<wf>/<run> 形状的路径
    const workflowDir = fixtureWorkflowDir(fixture.runDir);
    if (workflowDir) await rm(workflowDir, { recursive: true, force: true });
  }
}

/** 清掉上次进程被中断时遗留的本 spec 数据；前缀与 data/runs 双重收敛。 */
async function removeStaleFixtures(request: APIRequestContext): Promise<void> {
  const database = openDb();
  let stale: Array<{ id: string; runDir: string | null }> = [];
  try {
    stale = database
      .prepare(
        "select id, run_dir as runDir from runs where workflow_name like ? or workflow_id in (select id from workflows where name like ?)",
      )
      .all(`${PREFIX}%`, `${PREFIX}%`) as Array<{ id: string; runDir: string | null }>;
    // 夹具从不处于 running，但中断时留下的行仍先失败化，让正式 DELETE 的运行中保护照常生效
    database
      .prepare(
        "update runs set status = 'failed', finished_at = ? where status = 'running' and (workflow_name like ? or workflow_id in (select id from workflows where name like ?))",
      )
      .run(Date.now(), `${PREFIX}%`, `${PREFIX}%`);
  } finally {
    database.close();
  }
  for (const row of stale) await request.delete(`/api/runs/${row.id}`);
  await cleanupByPrefix(request, "/api/workflows", PREFIX);
  for (const row of stale) {
    if (!row.runDir) continue;
    const workflowDir = fixtureWorkflowDir(path.resolve(process.cwd(), row.runDir));
    if (workflowDir) await rm(workflowDir, { recursive: true, force: true });
  }
}

let fixture: MonitorFixture | null = null;

test.beforeAll(async ({ request }) => {
  await removeStaleFixtures(request);
  fixture = await createFixture(request);
});

test.afterAll(async ({ request }) => {
  if (fixture) await removeFixture(fixture, request);
  fixture = null;
});

/* --------------------------------- 工具 --------------------------------- */

const TABS: Array<{ label: string; url: RegExp }> = [
  { label: "总览", url: /\/monitor$/ },
  { label: "实时会话", url: /\/monitor\/sessions$/ },
  { label: "Trace", url: /\/monitor\/trace(\?.*)?$/ },
  { label: "日志检索", url: /\/monitor\/logs(\?.*)?$/ },
  { label: "成本分析", url: /\/monitor\/cost(\?.*)?$/ },
  { label: "系统健康", url: /\/monitor\/health$/ },
];

/** 顶栏标签导航（与左侧主导航区分开） */
const tab = (page: Page, label: string) =>
  page.locator("header").getByRole("link", { name: label, exact: true });

/** 指标卡取值：<div data-testid="metric-card" data-label="…"> 里的 metric-value */
const metricValue = (page: Page, label: string) =>
  page.locator(`[data-testid="metric-card"][data-label="${label}"]`).getByTestId("metric-value");

/** 指标卡渲染出真实数值（不是加载态的「—」，也不是空） */
async function expectMetricHasValue(page: Page, label: string): Promise<string> {
  const value = metricValue(page, label);
  await expect(value).toBeVisible();
  await expect(value).not.toHaveText("—", { timeout: 15_000 });
  const text = (await value.innerText()).trim();
  expect(text.length, `指标卡「${label}」应有数值`).toBeGreaterThan(0);
  // 数字 / 千分位 / ¥0.5180 / <¥0.0001 / 0（费用以人民币计价，ADR-0011 的 pricing）
  expect(text, `指标卡「${label}」的值应是数值`).toMatch(/^(<?[¥$])?[\d,.]+/);
  return text;
}

/**
 * 执行 action 并截获页面自己发出的那次 GET 响应，把它的 JSON 交给断言——
 * DOM 与「页面实际拿到的载荷」比对，而不是测试另拉一份可能已经变化的数据。
 */
async function captureJson<T>(
  page: Page,
  matches: (url: URL) => boolean,
  action: () => Promise<unknown>,
): Promise<T> {
  const responded = page.waitForResponse(
    (res) => res.request().method() === "GET" && matches(new URL(res.url())),
    { timeout: 15_000 },
  );
  await action();
  const res = await responded;
  expect(res.ok(), `接口 ${res.url()} 应成功（HTTP ${res.status()}）`).toBe(true);
  return (await res.json()) as T;
}

const isLogs = (url: URL) => url.pathname === "/api/monitor/logs";

test.describe("监控台 · 导航", () => {
  test("左下角「监控台」入口进入 /monitor，顶栏六个标签逐个切换且 URL 变化", async ({ page }) => {
    await page.goto("/workflows");

    // 主导航底部的监控台入口
    const entry = page.getByRole("link", { name: "监控台", exact: true });
    await expect(entry).toBeVisible();
    await entry.click();
    await page.waitForURL(/\/monitor$/);
    await expect(page.getByRole("heading", { name: "监控台", exact: true })).toBeVisible();

    // 六个标签都在，且逐个点过去 URL 都变
    for (const item of TABS) {
      await expect(tab(page, item.label)).toBeVisible();
    }
    for (const item of TABS.slice(1)) {
      await tab(page, item.label).click();
      await expect(page).toHaveURL(item.url);
      await expect(tab(page, item.label)).toHaveAttribute("aria-current", "page");
    }
    // 回到总览
    await tab(page, "总览").click();
    await expect(page).toHaveURL(/\/monitor$/);
    await expect(tab(page, "总览")).toHaveAttribute("aria-current", "page");
  });
});

test.describe("监控台 · 总览", () => {
  test("六张指标卡都渲染出数值（不是「—」）", async ({ page }) => {
    await page.goto("/monitor");
    for (const label of [
      "活跃运行",
      "活跃会话",
      "今日运行",
      "今日 token",
      "今日费用",
      "近 1 小时错误",
    ]) {
      await expectMetricHasValue(page, label);
    }
    // 六张，不多不少
    await expect(page.locator('[data-testid="metric-card"]')).toHaveCount(6);
  });

  test("近 24 小时两张图渲染出 svg（运行量柱状图 + token 折线图）", async ({ page }) => {
    await page.goto("/monitor");

    const bars = page.locator('svg[aria-label="近 24 小时运行量"]');
    const line = page.locator('svg[aria-label="近 24 小时 token 消耗"]');
    await expect(bars).toBeVisible();
    await expect(line).toBeVisible();

    // 服务端保证 24 个整点桶：柱状图 24 组、折线图 24 个热区
    expect(await bars.locator("g").count()).toBeGreaterThanOrEqual(24);
    expect(await line.locator("rect").count()).toBeGreaterThanOrEqual(24);
    // 面板标题与实时连接徽标
    await expect(page.getByText("近 24 小时运行量")).toBeVisible();
    await expect(page.getByText("按运行开始时间归入整点桶")).toBeVisible();
  });
});

test.describe("监控台 · 实时会话", () => {
  test("SSE 会话帧到达：表格与 /api/monitor/sessions 载荷逐项一致，或明确的空态", async ({
    page,
    request,
  }) => {
    await page.goto("/monitor/sessions");

    await expect(page.getByRole("heading", { name: "进行中的会话" })).toBeVisible();

    // 连接活着：面板头里的连接徽标显示「实时 HH:MM:SS」，会话计数不再是加载态的「—」
    const panelHeader = page.locator("header").filter({ hasText: "进行中的会话" });
    await expect(panelHeader).toHaveCount(1);
    await expect(panelHeader).toContainText(/实时\s*\d{1,2}:\d{2}:\d{2}/, {
      timeout: 15_000,
    });
    await expect(panelHeader.getByText("—")).toHaveCount(0);

    // 收到 sessions 帧后，要么有行、要么是空态文案——都不能停在「等待实时数据…」
    const rows = page.locator("tbody tr");
    const empty = page.getByText("当前没有进行中的会话");
    await expect(rows.first().or(empty)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("等待实时数据…")).toHaveCount(0);

    // e2e 从不发起含 Action 的运行，本夹具也是已结束的运行，所以这里通常是空态；
    // 本机若恰有真实运行在跑，表格必须与接口载荷逐项对得上，不能假定它属于某个具体工作流。
    const payload = (await (await request.get("/api/monitor/sessions")).json()) as SessionsPayload;
    if (payload.items.length === 0) {
      await expect(empty).toBeVisible();
      await expect(rows).toHaveCount(0);
      return;
    }
    await expect(rows).toHaveCount(payload.items.length);
    await expect(page.getByText("模型 · 强度")).toBeVisible();
    for (const item of payload.items) {
      const row = rows.filter({ hasText: item.sessionId.slice(0, 8) });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(item.workflowName);
    }
  });
});

test.describe("监控台 · Trace", () => {
  test("下拉默认选中 /api/runs 的第一条；夹具运行的甘特图与 trace 载荷一致：span 行、节点名与耗时", async ({
    page,
  }) => {
    const current = fixture!;

    // 默认选中项 = 运行列表接口的第一条（倒序即最近一次）。哪次运行最近会随真实使用变化，
    // 所以对着页面自己拉到的载荷比对，而不是写死某个工作流。
    const runs = await captureJson<Array<{ id: string }>>(
      page,
      (url) => url.pathname === "/api/runs" && url.search === "",
      () => page.goto("/monitor/trace"),
    );
    expect(runs.length, "夹具已写入一条运行，列表不该为空").toBeGreaterThan(0);
    const select = page.locator("select");
    await expect(select).toBeEnabled({ timeout: 15_000 });
    await expect(select).toHaveValue(runs[0].id);

    // 深链到夹具运行：span 行数、摘要条、节点名都与 trace 载荷比对
    const trace = await captureJson<TracePayload>(
      page,
      (url) => url.pathname === `/api/monitor/trace/${current.runId}`,
      () => page.goto(`/monitor/trace?runId=${current.runId}`),
    );
    await expect(select).toHaveValue(current.runId);
    const spans = page.getByTestId("trace-span-row");
    await expect(spans).toHaveCount(trace.spans.length, { timeout: 15_000 });
    expect(trace.spans.length, "两个节点各有会话，span 树不该只剩根").toBeGreaterThan(3);
    await expect(page.getByText(`span（${trace.spans.length} 条）`)).toBeVisible();
    expect(trace.run.workflowName).toBe(current.workflowName);
    await expect(
      page.getByText(current.workflowName).filter({ visible: true }).first(),
    ).toBeVisible();
    for (const field of ["开始", "总耗时", "span", "节点", "token", "费用"]) {
      await expect(page.getByText(field, { exact: true }).first()).toBeVisible();
    }

    // 两个节点的名字都在链路里；节点 span 的 detail 是 actionName、session span 的 label 是会话 id
    for (const label of [current.labelA, current.labelB]) {
      await expect(spans.filter({ hasText: label }).first()).toBeVisible();
    }
    await expect(spans.filter({ hasText: current.nodeA }).first()).toBeVisible();

    // 根 span 是整次运行：右侧显示 trace 载荷里的总 token 与费用（夹具用量非零，不是「—」）
    expect(trace.run.tokens).toBeGreaterThan(0);
    expect(trace.run.cost).toBeGreaterThan(0);
    await expect(spans.first()).toContainText(formatTokens(trace.run.tokens));
    await expect(spans.first()).toContainText(formatCost(trace.run.cost));

    // 每行右侧的耗时列：至少有一行是「N 秒 / N 分 N 秒 / N 毫秒」
    await expect(spans.filter({ hasText: /\d+(\.\d+)?\s*(毫秒|秒|分)/ }).first()).toBeVisible();

    // 行可展开看详情
    const first = spans.first();
    await first.click();
    await expect(first).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText(/起点 \+\d+ ms/).first()).toBeVisible();
  });
});

/**
 * 日志页每次筛选变化都会清空列表再拉第一页（PAGE_SIZE=50）。「筛选生效」不能靠
 * 「行数比筛选前少」判断：命中数一旦 ≥ 一页，筛选前后都是满页。所以一律截获页面自己
 * 发出的那次接口响应，以响应里的条数为准等 DOM 渲染出同样多的行；夹具自己的事件
 * 条数是确定的，可以进一步断言精确值。
 */
test.describe("监控台 · 日志检索", () => {
  test("首屏与载荷一致；按夹具运行筛选后列出它的全部事件，「只看错误」只剩两条错误事件", async ({
    page,
  }) => {
    const current = fixture!;
    const rows = page.getByTestId("log-row");

    const all = await captureJson<LogsPayload>(
      page,
      (url) => isLogs(url) && !url.searchParams.has("runId") && !url.searchParams.has("cursor"),
      () => page.goto("/monitor/logs"),
    );
    await expect(rows).toHaveCount(all.items.length, { timeout: 15_000 });
    expect(all.items.length, "夹具已写入事件，首屏不该为空").toBeGreaterThan(0);

    // ?runId= 只留夹具自己的事件：条数就是夹具写入的条数
    const scoped = await captureJson<LogsPayload>(
      page,
      (url) =>
        isLogs(url) &&
        url.searchParams.get("runId") === current.runId &&
        !url.searchParams.has("onlyErrors"),
      () => page.goto(`/monitor/logs?runId=${current.runId}`),
    );
    expect(scoped.items.length).toBe(current.events);
    await expect(rows).toHaveCount(current.events, { timeout: 15_000 });
    await expect(rows.first()).toContainText(current.workflowName);

    const errors = await captureJson<LogsPayload>(
      page,
      (url) =>
        isLogs(url) &&
        url.searchParams.get("runId") === current.runId &&
        url.searchParams.get("onlyErrors") === "true",
      async () => {
        await page.getByText("只看错误").click();
        await expect(page).toHaveURL(/errors=1/);
      },
    );
    expect(errors.items.length).toBe(current.errorEvents);
    await expect(rows).toHaveCount(current.errorEvents, { timeout: 15_000 });
    // 剩下的都应是错误类事件（session.error 或 tool 的 error 状态）
    for (let i = 0; i < current.errorEvents; i += 1) {
      await expect(rows.nth(i)).toContainText(/session\.error|error/);
    }
  });

  test("关键词按字面匹配 payload 全文：只命中夹具里含该词的两条，下划线不是单字符通配符", async ({
    page,
  }) => {
    const current = fixture!;
    await page.goto("/monitor/logs");
    const rows = page.getByTestId("log-row");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });

    const hits = await captureJson<LogsPayload>(
      page,
      (url) => isLogs(url) && url.searchParams.get("q") === current.keyword,
      async () => {
        await page.getByPlaceholder("关键词：匹配 payload 全文").fill(current.keyword);
        await expect(page).toHaveURL(new RegExp(`q=${current.keyword}`), {
          timeout: 15_000,
        });
      },
    );
    // 夹具里恰有两条事件的 payload 含该词；另有一条把下划线换成连字符的诱饵，
    // `_` 若没被转义成字面量就会多命中它。
    expect(hits.items.length).toBe(current.keywordEvents);
    await expect(rows).toHaveCount(current.keywordEvents, { timeout: 15_000 });
    for (const item of hits.items) {
      expect(JSON.stringify(item.payload)).toContain(current.keyword);
    }
    // 逐行核对：折叠行的摘要在 JS 里截断过，长消息的命中点可能在截断之后——
    // 摘要里找不到就展开行，对完整 payload 核对。
    for (let i = 0; i < current.keywordEvents; i += 1) {
      const row = rows.nth(i);
      const summary = (await row.textContent()) ?? "";
      if (summary.includes(current.keyword)) continue;
      await row.click();
      await expect(page.getByTestId("log-row-detail")).toContainText(current.keyword);
      await row.click();
    }
  });

  test("LIKE 通配符按字面匹配：把下划线换成 % 的探针不应命中夹具关键词", async ({ page }) => {
    const current = fixture!;
    await page.goto("/monitor/logs");
    const rows = page.getByTestId("log-row");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });

    // 服务端已转义 LIKE 通配符：% 是普通字符，不能当成「任意字符」用
    const miss = await captureJson<LogsPayload>(
      page,
      (url) => isLogs(url) && url.searchParams.get("q") === current.keywordProbe,
      async () => {
        await page.getByPlaceholder("关键词：匹配 payload 全文").fill(current.keywordProbe);
        await expect(page).toHaveURL(/q=e2e%25monitor%25kw/, { timeout: 15_000 });
      },
    );
    expect(miss.items.length, "% 若被当成通配符会命中夹具的关键词行").toBe(0);
    await expect(page.getByText("没有匹配的事件")).toBeVisible({ timeout: 15_000 });
    await expect(rows).toHaveCount(0);

    // 清除筛选后结果回来，证明上一步的空结果是过滤造成的
    const restored = await captureJson<LogsPayload>(
      page,
      (url) => isLogs(url) && !url.searchParams.has("q"),
      () => page.getByText("清除全部筛选").click(),
    );
    expect(restored.items.length).toBeGreaterThan(0);
    await expect(rows).toHaveCount(restored.items.length, { timeout: 15_000 });
  });
});

test.describe("监控台 · 成本分析", () => {
  const isCost = (url: URL) =>
    url.pathname === "/api/monitor/cost" && url.searchParams.get("days") === "7";

  test("四张指标卡与 /api/monitor/cost 载荷一致；夹具用量让近 7 天有非零费用与 token", async ({
    page,
  }) => {
    const cost = await captureJson<CostPayload>(page, isCost, () => page.goto("/monitor/cost"));
    // 与页面同一口径：四张卡都从 byModel 求和
    const totals = cost.byModel.reduce(
      (acc, m) => ({
        cost: acc.cost + m.cost,
        tokens: acc.tokens + m.tokens,
        messages: acc.messages + m.messages,
      }),
      { cost: 0, tokens: 0, messages: 0 },
    );
    expect(totals.tokens, "夹具的 node_usage 落在近 7 天窗口内").toBeGreaterThan(0);
    expect(totals.cost).toBeGreaterThan(0);

    expect(await expectMetricHasValue(page, "总费用")).toBe(formatCost(totals.cost));
    expect(await expectMetricHasValue(page, "总 token")).toBe(formatTokens(totals.tokens));
    expect(await expectMetricHasValue(page, "assistant 消息")).toBe(formatTokens(totals.messages));
    expect(await expectMetricHasValue(page, "日均费用")).toBe(formatCost(totals.cost / cost.days));

    // 两张图
    await expect(page.getByText("每日费用")).toBeVisible();
    await expect(page.getByText("每日 token")).toBeVisible();
  });

  test("按模型排行与载荷行数一致，夹具的 deepseek 路由在榜上且 token / 费用对得上", async ({
    page,
  }) => {
    const cost = await captureJson<CostPayload>(page, isCost, () => page.goto("/monitor/cost"));

    const panel = page.locator('section:has(h2:text-is("按模型"))');
    await expect(panel).toBeVisible();
    const rows = panel.locator("tbody tr");
    await expect(rows).toHaveCount(cost.byModel.length, { timeout: 15_000 });

    const mine = cost.byModel.find((m) => m.providerId === PROVIDER_ID && m.modelId === MODEL_ID);
    expect(mine, "夹具的 node_usage 走 deepseek-official/deepseek-v4-flash").toBeTruthy();
    // 名称单元格的 title 就是 modelId；同一模型经不同 provider 会是两行，再按 provider 收窄
    const row = rows
      .filter({ has: page.locator(`[title="${MODEL_ID}"]`) })
      .filter({ hasText: PROVIDER_ID });
    await expect(row).toHaveCount(1);
    await expect(row.locator("td").nth(1)).toHaveText(String(mine!.messages));
    await expect(row.locator("td").nth(2)).toHaveText(formatTokens(mine!.tokens));
    // 费用以人民币计价
    await expect(row.locator("td").nth(3)).toHaveText(formatCost(mine!.cost));
    await expect(row).toContainText(/[¥$]\d|<[¥$]/);
  });
});

test.describe("监控台 · 系统健康", () => {
  test("执行引擎状态卡出现，运行子进程与数据库卡同在", async ({ page }) => {
    await page.goto("/monitor/health");

    // 换成 dsh 引擎后没有常驻外部服务可探（ADR-0006）：就绪只取决于 runner 入口
    // 与凭据引用，卡片报的是这两样而不是某个地址的可达性。
    const panel = page.locator('section:has(h2:text-is("执行引擎"))');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText(/^(就绪|未就绪)$/)).toBeVisible();
    await expect(panel).toContainText("runner.ts");
    await expect(panel).toContainText("DEEPSEEK_API_KEY");

    await expect(page.getByRole("heading", { name: "运行子进程" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "数据库" })).toBeVisible();
    // 数据库表统计不是空的
    await expect(
      page.locator('section:has(h2:text-is("数据库"))').locator("tbody tr").first(),
    ).toBeVisible();
  });

  test("磁盘占用行与 /api/monitor/health 载荷一致：夹具工作区让 data/runs 目录数与体积都非零（字段名回归防护）", async ({
    page,
  }) => {
    const health = await captureJson<HealthPayload>(
      page,
      (url) => url.pathname === "/api/monitor/health",
      () => page.goto("/monitor/health"),
    );

    const panel = page.locator('section:has(h2:text-is("磁盘占用"))');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    const runsRow = panel.locator("tr").filter({ hasText: "data/runs 运行工作区" });
    await expect(runsRow).toHaveCount(1);

    // 夹具已物化 data/runs/<wf>/<run>/workspace/report.md：目录数至少 1、体积至少那份产物
    const { dirs, bytes } = health.disk.runsDir;
    expect(dirs, "data/runs 目录数应非零").toBeGreaterThanOrEqual(1);
    expect(bytes, "data/runs 体积应至少含夹具产物").toBeGreaterThanOrEqual(WORKSPACE_BYTES);
    // DOM 按载荷算出的文本显示（曾经因读错字段名恒显示 0）
    await expect(runsRow).toContainText(`${formatCount(dirs)} 个目录`);
    await expect(runsRow).toContainText(formatBytes(bytes));
    await expect(runsRow).not.toContainText(/\b0 个目录/);

    // 合计与另一个目录也在
    await expect(panel).toContainText("合计");
    await expect(panel).toContainText("data/uploads 上传");
  });

  test("清理面板三项「预览影响」都返回成功并显示影响面（不点执行清理）", async ({ page }) => {
    await page.goto("/monitor/health");

    const items = page.getByTestId("cleanup-item");
    await expect(items).toHaveCount(3, { timeout: 15_000 });

    for (const target of ["workspaces", "events", "runs"]) {
      const item = page.locator(`[data-testid="cleanup-item"][data-target="${target}"]`);
      await expect(item).toHaveCount(1);

      await item.getByRole("button", { name: "预览影响" }).click();

      // 必须出现「预览：…」结果文案（曾经六条路径全 400，只会出现红色错误条）
      await expect(item.getByText(/^预览：将删除/)).toBeVisible({
        timeout: 30_000,
      });
      // 请求体字段名写错时服务端返回「beforeDays 必须是正整数」
      await expect(item).not.toContainText("beforeDays");
      await expect(item).not.toContainText("预览影响失败");
      await expect(item).not.toContainText("HTTP 400");

      // 确认危险按钮还在原地、没有被误触发（没有确认弹窗）
      await expect(item.getByRole("button", { name: "执行清理" })).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }

    // 三项都预览过之后，页面上应有三条预览结论
    await expect(page.getByText(/^预览：将删除/)).toHaveCount(3);
  });
});
