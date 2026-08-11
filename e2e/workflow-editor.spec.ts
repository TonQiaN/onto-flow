import { expect, test } from "@playwright/test";

test.describe("工作流画布", () => {
  test("打开「采购集采计划生成」：7 节点 7 连线，保存成功且无校验问题", async ({
    page,
  }) => {
    await page.goto("/workflows");
    await page
      .getByRole("heading", { name: "采购集采计划生成", exact: true })
      .click();
    await page.waitForURL(/\/workflows\/[0-9a-f-]{36}/);

    // 画布加载完成：7 节点 / 7 连线
    await expect(page.locator(".react-flow__node")).toHaveCount(7, {
      timeout: 20_000,
    });
    await expect(page.locator(".react-flow__edge")).toHaveCount(7);

    // 保存：PUT 整图成功（不点「运行」）
    const putResponse = page.waitForResponse(
      (res) =>
        res.request().method() === "PUT" &&
        /\/api\/workflows\//.test(res.url()),
    );
    await page.getByRole("button", { name: "保存", exact: true }).click();
    const res = await putResponse;
    expect(res.ok()).toBeTruthy();

    // 保存按钮恢复可用，无错误横幅、无校验问题横幅
    await expect(
      page.getByRole("button", { name: "保存", exact: true }),
    ).toBeEnabled();
    await expect(page.getByText("保存失败")).toBeHidden();
    await expect(page.getByText(/校验问题（\d+）/)).toBeHidden();

    // 图形未被改动：节点与连线数量不变
    await expect(page.locator(".react-flow__node")).toHaveCount(7);
    await expect(page.locator(".react-flow__edge")).toHaveCount(7);
  });
});
