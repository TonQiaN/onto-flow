import { expect, test } from "@playwright/test";

test.describe("运行历史", () => {
  test("成功记录可进入详情：「运行详情」标题 + 全链路节点时间线（含「归档回执」）", async ({
    page,
  }) => {
    await page.goto("/runs");

    const successRows = page
      .locator("tbody tr")
      .filter({ has: page.getByText("成功", { exact: true }) });
    // 库里至少有一条成功运行（真实调模型很贵，e2e 不触发新运行，只消费既有记录）
    await expect(successRows.first()).toBeVisible();
    expect(await successRows.count()).toBeGreaterThanOrEqual(1);

    // 打开最新一条成功运行的详情
    await successRows.first().click();
    await page.waitForURL(/\/runs\/[0-9a-f-]{36}/);
    await expect(
      page.getByRole("heading", { name: "运行详情", exact: true }),
    ).toBeVisible();

    // 节点时间线覆盖整条链路：四个 Action 节点 + 出参「归档回执」节点卡片
    const timeline = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "节点时间线" }) });
    for (const label of [
      "需求整理",
      "集采计划生成",
      "集采计划审核",
      "集采计划归档",
      "归档回执",
    ]) {
      await expect(
        timeline.getByText(label, { exact: true }).first(),
      ).toBeVisible();
    }

    // 归档节点跑成功，卡片上有输出区
    await expect(timeline.getByText("输出", { exact: true }).first()).toBeVisible();
  });
});
