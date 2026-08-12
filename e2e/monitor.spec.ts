import { expect, test, type Page } from "@playwright/test";

/**
 * 监控台（/monitor 六个标签页）的端到端覆盖。
 *
 * 只读纪律：本文件**绝不**点击「执行清理」/「确认删除」/「中止该运行」，
 * 也不发起任何工作流运行（真实调模型，昂贵）。清理面板只走 dryRun 预览路径。
 * 断言全部消费库里既有的种子数据与历史运行记录。
 */

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
  page
    .locator(`[data-testid="metric-card"][data-label="${label}"]`)
    .getByTestId("metric-value");

/** 指标卡渲染出真实数值（不是加载态的「—」，也不是空） */
async function expectMetricHasValue(page: Page, label: string): Promise<string> {
  const value = metricValue(page, label);
  await expect(value).toBeVisible();
  await expect(value).not.toHaveText("—", { timeout: 15_000 });
  const text = (await value.innerText()).trim();
  expect(text.length, `指标卡「${label}」应有数值`).toBeGreaterThan(0);
  // 数字 / 千分位 / $0.0283 / <$0.0001 / 0
  expect(text, `指标卡「${label}」的值应是数值`).toMatch(/^(<?\$)?[\d,.]+/);
  return text;
}

test.describe("监控台 · 导航", () => {
  test("左下角「监控台」入口进入 /monitor，顶栏六个标签逐个切换且 URL 变化", async ({
    page,
  }) => {
    await page.goto("/workflows");

    // 主导航底部的监控台入口
    const entry = page.getByRole("link", { name: "监控台", exact: true });
    await expect(entry).toBeVisible();
    await entry.click();
    await page.waitForURL(/\/monitor$/);
    await expect(
      page.getByRole("heading", { name: "监控台", exact: true }),
    ).toBeVisible();

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

  test("近 24 小时两张图渲染出 svg（运行量柱状图 + token 折线图）", async ({
    page,
  }) => {
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
  test("SSE 会话帧到达：列出进行中的会话，或明确的空态", async ({ page }) => {
    await page.goto("/monitor/sessions");

    await expect(
      page.getByRole("heading", { name: "进行中的会话" }),
    ).toBeVisible();

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

    if ((await rows.count()) > 0) {
      // 有会话时，表头列齐全且行里带模型信息
      await expect(page.getByText("模型 · 强度")).toBeVisible();
      await expect(rows.first()).toContainText("采购");
    }
  });
});

test.describe("监控台 · Trace", () => {
  test("默认选中最近一次运行，甘特图渲染出 span 行、节点名与耗时", async ({
    page,
  }) => {
    await page.goto("/monitor/trace");

    // 下拉默认选中最近一次运行
    const select = page.locator("select");
    await expect(select).toBeEnabled({ timeout: 15_000 });
    const runId = await select.inputValue();
    expect(runId, "库里应有历史运行（e2e 不发起新运行）").toMatch(
      /^[0-9a-f-]{36}$/,
    );

    // 甘特图有 span 行
    const spans = page.getByTestId("trace-span-row");
    await expect(spans.first()).toBeVisible({ timeout: 15_000 });
    const count = await spans.count();
    expect(count, "甘特图应至少有一条 span").toBeGreaterThan(0);
    await expect(page.getByText(`span（${count} 条）`)).toBeVisible();

    // 摘要条：运行名 + span/节点/耗时等字段（下拉 option 里的同名文本不算）
    await expect(
      page.getByText("采购集采计划生成").filter({ visible: true }).first(),
    ).toBeVisible();
    for (const field of ["开始", "总耗时", "span", "节点", "token", "费用"]) {
      await expect(page.getByText(field, { exact: true }).first()).toBeVisible();
    }
    // 链路里的节点名（工作流固定含该审核节点）
    await expect(
      page.getByTestId("trace-span-row").filter({ hasText: "集采计划审核" }),
    ).toHaveCount(1);

    // 每行右侧的耗时列：至少有一行是「N 秒 / N 分 N 秒 / N 毫秒」
    await expect(
      spans.filter({ hasText: /\d+(\.\d+)?\s*(毫秒|秒|分)/ }).first(),
    ).toBeVisible();

    // 行可展开看详情
    const first = spans.first();
    await first.click();
    await expect(first).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText(/起点 \+\d+ ms/).first()).toBeVisible();
  });
});

test.describe("监控台 · 日志检索", () => {
  test("默认列出事件行，「只看错误」收窄结果", async ({ page }) => {
    await page.goto("/monitor/logs");

    const rows = page.getByTestId("log-row");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    const before = await rows.count();
    expect(before, "库里应有历史事件").toBeGreaterThan(0);

    await page.getByText("只看错误").click();
    await expect(page).toHaveURL(/errors=1/);

    // 行数变少，或者干脆空态（当前库里没有错误事件）
    const empty = page.getByText("没有匹配的事件");
    await expect(rows.first().or(empty)).toBeVisible({ timeout: 15_000 });
    const after = await rows.count();
    expect(after, "「只看错误」后行数应变化").toBeLessThan(before);
    if (after > 0) {
      // 剩下的都应是错误类事件（session.error 或 tool 的 error 状态）
      for (let i = 0; i < after; i += 1) {
        await expect(rows.nth(i)).toContainText(/session\.error|error/);
      }
    }
  });

  test("关键词 save_purchase_plan 过滤：结果收窄且每行都与该词相关", async ({
    page,
  }) => {
    await page.goto("/monitor/logs");

    const rows = page.getByTestId("log-row");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    const before = await rows.count();

    await page
      .getByPlaceholder("关键词：匹配 payload 全文")
      .fill("save_purchase_plan");
    await expect(page).toHaveURL(/q=save_purchase_plan/, { timeout: 15_000 });

    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => rows.count(), { timeout: 15_000 })
      .toBeLessThan(before);

    const after = await rows.count();
    expect(after, "该工具确实被调用过，应有命中").toBeGreaterThan(0);
    // 逐行核对：命中的都真的与这个词有关，不是把全部事件都捞回来了。
    // 折叠行的摘要在 JS 里截断过，长消息的命中点可能在截断之后——
    // 摘要里找不到就展开行，对完整 payload 核对。
    for (let i = 0; i < after; i += 1) {
      const row = rows.nth(i);
      const summary = (await row.textContent()) ?? "";
      if (summary.includes("save_purchase_plan")) continue;
      await row.click();
      await expect(page.getByTestId("log-row-detail")).toContainText(
        "save_purchase_plan",
      );
      await row.click();
    }
  });

  test("LIKE 通配符按字面匹配：save%plan 不应命中 save_purchase_plan", async ({
    page,
  }) => {
    await page.goto("/monitor/logs");
    await expect(page.getByTestId("log-row").first()).toBeVisible({
      timeout: 15_000,
    });

    // 服务端已转义 LIKE 通配符：% 是普通字符，不能当成「任意字符」用
    await page.getByPlaceholder("关键词：匹配 payload 全文").fill("save%plan");
    await expect(page).toHaveURL(/q=save%25plan/, { timeout: 15_000 });

    await expect(page.getByText("没有匹配的事件")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("log-row")).toHaveCount(0);

    // 清除筛选后结果回来，证明上一步的空结果是过滤造成的
    await page.getByText("清除全部筛选").click();
    await expect(page.getByTestId("log-row").first()).toBeVisible({
      timeout: 15_000,
    });
  });
});

test.describe("监控台 · 成本分析", () => {
  test("总费用 / 总 token 卡有数值，日均与消息数同在", async ({ page }) => {
    await page.goto("/monitor/cost");

    const cost = await expectMetricHasValue(page, "总费用");
    const tokens = await expectMetricHasValue(page, "总 token");
    await expectMetricHasValue(page, "assistant 消息");
    await expectMetricHasValue(page, "日均费用");

    expect(cost, "总费用应是美元金额").toMatch(/^(<?\$)/);
    expect(
      Number(tokens.replace(/[^\d]/g, "")),
      "近 7 天应有 token 消耗",
    ).toBeGreaterThan(0);

    // 两张图
    await expect(page.getByText("每日费用")).toBeVisible();
    await expect(page.getByText("每日 token")).toBeVisible();
  });

  test("按模型排行至少一行且包含 deepseek", async ({ page }) => {
    await page.goto("/monitor/cost");

    const panel = page.locator('section:has(h2:text-is("按模型"))');
    await expect(panel).toBeVisible();
    const rows = panel.locator("tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    expect(await rows.count()).toBeGreaterThanOrEqual(1);
    await expect(panel).toContainText("deepseek");

    // 行里带 token 与费用（不是空表头）
    await expect(rows.first()).toContainText(/\$\d|<\$/);
  });
});

test.describe("监控台 · 系统健康", () => {
  test("opencode 状态卡出现，事件泵与数据库卡同在", async ({ page }) => {
    await page.goto("/monitor/health");

    const panel = page.locator('section:has(h2:text-is("opencode server"))');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    // 探活结论明确（可达 / 不可达），且带地址
    await expect(panel.getByText(/^(可达|不可达)$/)).toBeVisible();
    await expect(panel).toContainText("127.0.0.1:4977");

    await expect(page.getByRole("heading", { name: "事件泵" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "数据库" })).toBeVisible();
    // 数据库表统计不是空的
    await expect(
      page.locator('section:has(h2:text-is("数据库"))').locator("tbody tr").first(),
    ).toBeVisible();
  });

  test("磁盘占用显示 data/runs 的非零体积与目录数（字段名回归防护）", async ({
    page,
  }) => {
    await page.goto("/monitor/health");

    const panel = page.locator('section:has(h2:text-is("磁盘占用"))');
    await expect(panel).toBeVisible({ timeout: 15_000 });

    const runsRow = panel.locator("tr").filter({ hasText: "data/runs 运行工作区" });
    await expect(runsRow).toHaveCount(1);
    const text = (await runsRow.innerText()).replace(/\s+/g, " ");

    // 目录数非零（曾经因读错字段名恒显示 0）
    const dirs = text.match(/([\d,]+)\s*个目录/);
    expect(dirs, `磁盘行应显示目录数：${text}`).not.toBeNull();
    expect(Number(dirs![1].replace(/,/g, "")), "data/runs 目录数应非零").toBeGreaterThan(0);

    // 体积非零，且不是「0 B」
    const size = text.match(/([\d.]+)\s*(B|KB|MB|GB|TB)\s*$/);
    expect(size, `磁盘行应显示体积：${text}`).not.toBeNull();
    expect(Number(size![1]), "data/runs 体积应非零").toBeGreaterThan(0);
    expect(size![2], "data/runs 已物化工作区，体积不该只有几字节").not.toBe("B");

    // 合计与另外两个目录也在
    await expect(panel).toContainText("合计");
    await expect(panel).toContainText("data/uploads 上传");
    await expect(panel).toContainText("data/documents 归档");
  });

  test("清理面板三项「预览影响」都返回成功并显示影响面（不点执行清理）", async ({
    page,
  }) => {
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
