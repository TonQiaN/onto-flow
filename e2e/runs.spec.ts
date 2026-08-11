import { expect, test } from "@playwright/test";

test.describe("运行历史", () => {
  test("至少 2 条成功记录；详情页有「归档回执」节点卡片与「运行详情」标题", async ({
    page,
  }) => {
    await page.goto("/runs");

    const successRows = page
      .locator("tbody tr")
      .filter({ has: page.getByText("成功", { exact: true }) });
    // 至少 2 条状态为成功的记录
    await expect(successRows.nth(1)).toBeVisible();
    expect(await successRows.count()).toBeGreaterThanOrEqual(2);

    // 打开最新一条成功运行的详情
    await successRows.first().click();
    await page.waitForURL(/\/runs\/[0-9a-f-]{36}/);
    await expect(
      page.getByRole("heading", { name: "运行详情", exact: true }),
    ).toBeVisible();

    // 节点时间线中出现「归档回执」节点卡片
    const timeline = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "节点时间线" }) });
    await expect(
      timeline.getByText("归档回执", { exact: true }).first(),
    ).toBeVisible();
  });
});
