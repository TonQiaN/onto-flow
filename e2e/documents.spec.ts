import { expect, test } from "@playwright/test";

test.describe("归档文档", () => {
  test("归档计划行可展开查看计划全文与审核评价", async ({ page }) => {
    await page.goto("/documents");

    // 归档记录由工作流真实运行写入，编号随运行生成，故按「首行 + 编号格式」定位，
    // 不硬编码某一次运行的具体编号。
    const row = page.locator("tbody tr").first();
    await expect(row).toBeVisible();
    await expect(row.locator("td").first()).toHaveText(
      /^[A-Z0-9]+(-[A-Z0-9]+)+$/,
    );

    // 点击行展开
    await row.click();
    await expect(
      page.getByRole("heading", { name: "计划全文" }),
    ).toBeVisible();

    // 计划全文包含 Markdown 内容片段
    const content = page.locator("pre").filter({ hasText: "计划概述" }).first();
    await expect(content).toBeVisible();

    // 审核评价区块同时展开
    await expect(
      page.getByRole("heading", { name: "审核评价" }),
    ).toBeVisible();

    // 再次点击收起
    await row.click();
    await expect(page.getByRole("heading", { name: "计划全文" })).toHaveCount(0);
  });
});
