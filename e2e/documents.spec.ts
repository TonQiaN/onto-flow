import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { openDb } from "./helpers";

/**
 * 归档文档页（/documents）。
 *
 * purchase_plans 由采购工作流里的 save_purchase_plan Tool 在真实（付费）运行中写入，
 * CI 的种子库里一行都没有。所以 beforeAll 直接写一行本 spec 自己的计划——标题带 e2e- 前缀、
 * 编号带 E2E- 前缀、正文与审核评价各埋一个哨兵——断言只针对这一行；表格行数则与
 * /api/documents 载荷比对，不假设首行是哪一次运行归档的。
 * purchase_plans 不挂在任何运行上、也没有删除接口，afterAll 直接按标题前缀删掉这行。
 */

const PREFIX = "e2e-归档-";

interface PlanFixture {
  planNo: string;
  planTitle: string;
  contentSentinel: string;
  feedbackSentinel: string;
}

interface PlanRow {
  planNo: string;
  planTitle: string;
}

function removeFixtures(): void {
  const database = openDb();
  try {
    database.prepare("delete from purchase_plans where plan_title like ?").run(`${PREFIX}%`);
  } finally {
    database.close();
  }
}

function createFixture(): PlanFixture {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const fixture: PlanFixture = {
    // 页面按「大写字母数字段 - 段」的编号格式展示，与真实归档的 CPP-2027-001 同形
    planNo: `E2E-${suffix}-001`,
    planTitle: `${PREFIX}${suffix}`,
    contentSentinel: `E2E_PLAN_CONTENT_${suffix}`,
    feedbackSentinel: `E2E_REVIEW_${suffix}`,
  };
  const database = openDb();
  try {
    database
      .prepare(
        "insert into purchase_plans (plan_no, plan_title, plan_type, plan_year, org_units, category_summary, item_count, total_budget, budget_note, schedule_summary, review_conclusion, review_feedback, plan_content, pending_issues, backup_path, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, ?)",
      )
      .run(
        fixture.planNo,
        fixture.planTitle,
        "一级集采",
        "2026 年度",
        "行政部,信息技术部",
        "办公设备 2 类",
        2,
        123456.78,
        "含税",
        "第三季度完成",
        "通过",
        JSON.stringify({ conclusion: "通过", sentinel: fixture.feedbackSentinel, items: [] }),
        `# ${fixture.planTitle}\n\n## 一、计划概述\n\n${fixture.contentSentinel}\n`,
        new Date().toISOString(),
      );
  } finally {
    database.close();
  }
  return fixture;
}

test.describe("归档文档", () => {
  let fixture: PlanFixture | null = null;

  test.beforeAll(() => {
    removeFixtures();
    fixture = createFixture();
  });

  test.afterAll(() => {
    removeFixtures();
    fixture = null;
  });

  test("表格行数与 /api/documents 载荷一致；夹具计划行可展开查看计划全文与审核评价", async ({
    page,
  }) => {
    const current = fixture!;
    // 截获页面自己消费的那次载荷：表格行数只跟它比，不假设库里有多少归档
    const responded = page.waitForResponse(
      (res) => res.request().method() === "GET" && new URL(res.url()).pathname === "/api/documents",
      { timeout: 15_000 },
    );
    await page.goto("/documents");
    const res = await responded;
    expect(res.ok(), `归档接口应成功（HTTP ${res.status()}）`).toBe(true);
    const plans = (await res.json()) as PlanRow[];
    expect(plans.some((plan) => plan.planNo === current.planNo)).toBe(true);

    const rows = page.locator("tbody tr");
    await expect(rows).toHaveCount(plans.length);

    const row = rows.filter({ hasText: current.planNo });
    await expect(row).toHaveCount(1);
    await expect(row.locator("td").first()).toHaveText(current.planNo);
    await expect(row.locator("td").first()).toHaveText(/^[A-Z0-9]+(-[A-Z0-9]+)+$/);
    await expect(row).toContainText(current.planTitle);
    await expect(row).toContainText("2026 年度");
    await expect(row).toContainText("123,456.78 元");
    await expect(row).toContainText("通过");

    // 点击行展开：展开区是紧随其后的第二个 tr，表格因此多一行
    await row.click();
    await expect(page.getByRole("heading", { name: "计划全文" })).toBeVisible();
    await expect(rows).toHaveCount(plans.length + 1);

    // 计划全文包含 Markdown 内容片段与本夹具的哨兵
    const content = page.locator("pre").filter({ hasText: "计划概述" }).first();
    await expect(content).toBeVisible();
    await expect(content).toContainText(current.contentSentinel);

    // 审核评价区块同时展开，显示的是这一行自己的评价
    await expect(page.getByRole("heading", { name: "审核评价" })).toBeVisible();
    await expect(page.locator("pre").filter({ hasText: current.feedbackSentinel })).toHaveCount(1);
    await expect(page.getByText("（无备份）")).toBeVisible();

    // 再次点击收起
    await row.click();
    await expect(page.getByRole("heading", { name: "计划全文" })).toHaveCount(0);
    await expect(rows).toHaveCount(plans.length);
  });

  test("接口返回空数组时显示明确的空态，而不是空表", async ({ page }) => {
    // 空态是 CI 种子库的常态；本机有历史时用路由拦截把它造出来，两边都验同一份 UI 契约
    await page.route("**/api/documents", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );
    await page.goto("/documents");
    await expect(page.getByText("暂无归档文档")).toBeVisible();
    await expect(page.locator("table")).toHaveCount(0);
  });
});
