import { expect, test } from "@playwright/test";

test.describe("归档文档", () => {
  test("CPP-2027-001 行可展开查看计划全文", async ({ page }) => {
    await page.goto("/documents");

    const row = page
      .getByRole("row")
      .filter({ hasText: "CPP-2027-001" })
      .first();
    await expect(row).toBeVisible();

    // 点击行展开
    await row.click();
    await expect(
      page.getByRole("heading", { name: "计划全文" }),
    ).toBeVisible();

    // 计划全文包含 Markdown 内容片段
    const content = page.locator("pre").filter({ hasText: "计划概述" }).first();
    await expect(content).toBeVisible();
  });
});
