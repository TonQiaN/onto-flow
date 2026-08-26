import { expect, test } from "@playwright/test";

test.describe("Action 库", () => {
  test("4 个种子 Action 均显示，「集采计划审核」卡片可见端口签名", async ({
    page,
  }) => {
    await page.goto("/actions");

    for (const name of [
      "需求整理",
      "集采计划生成",
      "集采计划审核",
      "集采计划归档",
    ]) {
      await expect(
        page.getByRole("heading", { name, exact: true }),
      ).toBeVisible();
    }

    // 「集采计划审核」端口签名：集采计划 → 审核评价、集采计划
    const card = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name: "集采计划审核", exact: true }) });
    await expect(card).toHaveCount(1);
    await expect(card.getByText("→")).toBeVisible();
    await expect(card.getByText("审核评价", { exact: true })).toBeVisible();
    // 输入与输出各出现一次「集采计划」端口徽章
    await expect(card.getByText("集采计划", { exact: true })).toHaveCount(2);

    await card.getByRole("button", { name: "编辑" }).click();
    const effort = page.getByLabel("思考强度");
    await expect(effort.locator("option")).toHaveText([
      "off（关闭）",
      "low（低）",
      "high（高）",
      "max（最大）",
    ]);
  });
});
