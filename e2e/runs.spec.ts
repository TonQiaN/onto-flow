import { expect, test } from "@playwright/test";

/**
 * 运行历史的详情页。
 *
 * 断言只跟**这次打开的那条运行自己的 API 载荷**比对，不假设最新一条是哪个
 * 工作流——真实使用会不断产生新运行，写死节点名的断言早晚会因为换了个工作流
 * 而红掉（这个坑在本仓库已经踩过两次，见 AGENTS.md）。
 */
test.describe("运行历史", () => {
  test("成功记录可进入详情：节点时间线与该次运行的 API 载荷一致", async ({ page }) => {
    await page.goto("/runs");

    const successRows = page
      .locator("tbody tr")
      .filter({ has: page.getByText("成功", { exact: true }) });
    // 库里至少有一条成功运行（真实调模型很贵，e2e 不触发新运行，只消费既有记录）
    await expect(successRows.first()).toBeVisible();

    await successRows.first().click();
    await page.waitForURL(/\/runs\/[0-9a-f-]{36}/);
    await expect(
      page.getByRole("heading", { name: "运行详情", exact: true }),
    ).toBeVisible();

    const runId = page.url().split("/").pop()!;
    const payload = (await (await page.request.get(`/api/runs/${runId}`)).json()) as {
      run: { status: string };
      nodes: Array<{ label: string; status: string }>;
    };
    expect(payload.run.status).toBe("success");
    expect(payload.nodes.length).toBeGreaterThan(0);

    // 时间线覆盖这次运行的每一个节点，一个不少
    const timeline = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "节点时间线" }) });
    for (const node of payload.nodes) {
      await expect(
        timeline.getByText(node.label, { exact: true }).first(),
        `时间线应出现节点「${node.label}」`,
      ).toBeVisible();
    }

    // 成功的节点带输出区
    if (payload.nodes.some((n) => n.status === "success")) {
      await expect(timeline.getByText("输出", { exact: true }).first()).toBeVisible();
    }
  });
});
