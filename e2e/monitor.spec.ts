import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page, type Route } from "@playwright/test";
import { cleanupByPrefix, DATA_DIR, openDb } from "./helpers";

/**
 * 系统健康页 `/monitor` 的端到端覆盖——监控台收口后这里只剩这一页（DESIGN-V3 第 4 批）。
 *
 * 只读纪律：本文件**绝不**点击「执行清理」/「确认删除」，也不发起任何工作流运行
 * （真实调模型，昂贵）。清理面板只走 dryRun 预览路径。
 *
 * 磁盘行必须能断言出非零，所以 beforeAll 合成一条已结束的运行，并真的在 data/runs 下落一份
 * 产物——CI 的库只有平台基线，一次运行都没有。断言只针对这份夹具，其余一律取页面自己消费的
 * `/api/monitor/health` 载荷、断言 DOM 与之一致；从不假设「库里本来就有什么」。
 * afterAll 经 DELETE /api/runs/[id] 与 cleanupByPrefix 收走，运行目录一并删除。
 */

const PREFIX = "e2e-监控-";
const RUNS_ROOT = path.join(DATA_DIR, "runs");
/** 夹具工作区里产物的体积：磁盘占用行要能显示出非零、且不止几字节的 data/runs 体积 */
const WORKSPACE_BYTES = 4096;
const RUN_ERROR = "e2e 合成的会话错误";

interface MonitorFixture {
  workflowId: string;
  workflowName: string;
  runId: string;
  runDir: string;
}

interface HealthPayload {
  disk: { runsDir: { bytes: number; dirs: number } };
}

/* ------------------------------ 展示格式的镜像 ------------------------------ */

/** 与 src/app/monitor/lib.ts 的 formatBytes / formatCount 同款：按载荷算出 DOM 应显示的文本 */
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

function formatCount(n: number): string {
  return Math.round(n).toLocaleString("zh-CN");
}

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

/** 合成一条已结束（failed）的运行，并把它的工作区目录真的写到磁盘上。 */
async function createFixture(request: APIRequestContext): Promise<MonitorFixture> {
  const suffix = randomUUID().slice(0, 8);
  const workflowId = randomUUID();
  const runId = randomUUID();
  const workflowName = `${PREFIX}${suffix}`;
  const runDir = path.join(RUNS_ROOT, workflowId, runId);
  const runStart = Date.now() - 60_000;
  const fixture: MonitorFixture = { workflowId, workflowName, runId, runDir };

  try {
    await mkdir(path.join(runDir, "workspace"), { recursive: true });
    await writeFile(
      path.join(runDir, "workspace", "report.md"),
      `# e2e 监控夹具 ${suffix}\n${"x".repeat(WORKSPACE_BYTES)}\n`,
      "utf8",
    );

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

/**
 * 执行 action 并截获页面自己发出的那次 GET 响应，把它的 JSON 交给断言——
 * DOM 与「页面实际拿到的载荷」比对，而不是测试另拉一份可能已经变化的数据。
 *
 * 用请求拦截而不是 waitForResponse + json()：页面 15 秒自动刷新一次，紧接着再发一次同样的请求时
 * 浏览器会丢掉上一份响应体，Playwright 报 `Network.getResponseBody` 协议错误。这里由测试
 * 自己取回响应、留下正文、再交给页面，页面渲染的就是断言拿到的那一份。dev 模式下页面会对
 * 同一接口连发两次（strict mode），两次各自用自己取回的响应 fulfill；捕获之后不 unroute——
 * 请求还在 fetch 时 unroute 会被 Playwright 按 fallback 放行，随后的 fulfill 就撞上「已处理」。
 */
async function captureJson<T>(
  page: Page,
  matches: (url: URL) => boolean,
  action: () => Promise<unknown>,
): Promise<T> {
  let captured = null as { value: T; body: string } | null;
  let settle!: () => void;
  const first = new Promise<void>((resolve) => {
    settle = resolve;
  });
  await page.route(
    (url) => matches(url),
    async (route: Route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      // 捕获之后的每一次匹配请求（strict mode 的第二次、自动刷新）都回同一份正文：页面无论哪次
      // 请求的状态更新胜出，渲染的都是断言拿到的那一份，不会被中途变化的真实数据替换。
      if (!captured) {
        const res = await route.fetch();
        const body = await res.text();
        if (!captured) {
          expect(res.ok(), `接口 ${res.url()} 应成功（HTTP ${res.status()}）`).toBe(true);
          captured = { value: JSON.parse(body) as T, body };
          settle();
        }
      }
      // 只回传状态与内容类型：原响应头里的 content-encoding 与已解码的正文对不上
      await route.fulfill({ status: 200, contentType: "application/json", body: captured.body });
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await action();
    await Promise.race([
      first,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("15s 内没有截获到匹配的 GET 请求")), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return captured!.value;
}

test.describe("系统健康 · 导航", () => {
  test("左下角「系统健康」入口进入 /monitor，页面没有标签栏", async ({ page }) => {
    await page.goto("/workflows");

    // 主导航底部的开发者面入口
    const entry = page.getByRole("link", { name: "系统健康", exact: true });
    await expect(entry).toBeVisible();
    await entry.click();
    await page.waitForURL(/\/monitor$/);
    await expect(page.getByRole("heading", { name: "系统健康", exact: true })).toBeVisible();

    // 收口成一页：页面自己的顶栏里没有任何导航，也没有旧标签的入口
    await expect(page.locator("header nav")).toHaveCount(0);
    for (const label of ["总览", "实时会话", "日志检索", "Trace", "成本分析"]) {
      await expect(page.getByRole("link", { name: label, exact: true })).toHaveCount(0);
    }
  });
});

test.describe("系统健康", () => {
  test("执行引擎状态卡出现，运行子进程与数据库卡同在", async ({ page }) => {
    await page.goto("/monitor");

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
      () => page.goto("/monitor"),
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
    await page.goto("/monitor");

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
