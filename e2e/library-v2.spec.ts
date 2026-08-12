import { expect, test } from "@playwright/test";

/**
 * FlowForge v2 阶段一新能力的验收：层级标签树筛选、编辑面板的「修订历史」与「被引用」。
 * 全部只读种子数据，不新建实体、不改种子、不触发工作流运行，因此无需 afterEach 清理。
 */
test.describe("库 v2 新能力", () => {
  test("标签树点「能力/审核」：Action 列表收窄且 URL 出现 ?tags=", async ({
    page,
  }) => {
    await page.goto("/actions");

    // 未筛选时 4 个种子 Action 都在
    await expect(
      page.getByRole("heading", { name: "集采计划生成", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("共 4 条")).toBeVisible();

    // 标签树节点的 title 是完整路径；卡片上的标签徽章 title 是「按标签「…」筛选」，
    // 用 exact 把两者区分开。
    await page.getByTitle("能力/审核", { exact: true }).click();

    // URL 同步出 tags 参数（值是标签 uuid）
    await expect(page).toHaveURL(/[?&]tags=[0-9a-f-]{36}/);

    // 列表收窄到唯一一个带「能力/审核」标签的 Action
    await expect(page.getByText("共 1 条")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "集采计划审核", exact: true }),
    ).toBeVisible();
    for (const gone of ["需求整理", "集采计划生成", "集采计划归档"]) {
      await expect(
        page.getByRole("heading", { name: gone, exact: true }),
      ).toHaveCount(0);
    }

    // 点树顶部的「全部」清空筛选（筛选中该按钮带「清空筛选」副标，
    // 与「全部折叠」区分开），URL 里的 tags 参数消失，列表恢复
    await page.getByRole("button", { name: "全部 清空筛选" }).click();
    await expect(page).not.toHaveURL(/[?&]tags=/);
    await expect(page.getByText("共 4 条")).toBeVisible();
  });

  test("编辑面板「修订历史」显示 v1「种子初始版本」", async ({ page }) => {
    await page.goto("/skills");

    const card = page.locator("li").filter({
      has: page.getByRole("heading", { name: "集采计划审核要点", exact: true }),
    });
    await expect(card).toHaveCount(1);
    await card.getByRole("button", { name: "编辑" }).click();
    await expect(
      page.getByRole("heading", { name: "编辑 Skill" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "修订历史", exact: true }).click();

    const panel = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "修订历史" }) });
    await expect(panel).toHaveCount(1);
    await expect(panel.getByText("共 1 版")).toBeVisible();
    await expect(panel.getByText("v1", { exact: true })).toBeVisible();
    await expect(panel.getByText("种子初始版本", { exact: true })).toBeVisible();

    // 展开 v1：与当前定义没有差异（种子建库后未改过）
    await page.getByRole("button", { name: /v1/ }).click();
    await expect(panel.getByText("与当前定义一致，无差异。")).toBeVisible();
  });

  test("编辑面板「被引用」显示引用方：Skill「集采计划审核要点」被 Action「集采计划审核」引用", async ({
    page,
  }) => {
    await page.goto("/skills");

    const card = page.locator("li").filter({
      has: page.getByRole("heading", { name: "集采计划审核要点", exact: true }),
    });
    await expect(card.getByText("1 处引用")).toBeVisible();
    await card.getByRole("button", { name: "编辑" }).click();
    await expect(
      page.getByRole("heading", { name: "编辑 Skill" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "被引用", exact: true }).click();

    const panel = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "被引用" }) });
    await expect(panel).toHaveCount(1);
    await expect(panel.getByText("被 1 处引用")).toBeVisible();
    await expect(panel.getByText("Action（1）")).toBeVisible();

    const ref = panel.getByRole("link", { name: /集采计划审核/ });
    await expect(ref).toHaveCount(1);
    await expect(ref).toHaveAttribute("href", /^\/actions\?highlight=[0-9a-f-]{36}$/);

    // 点进去跳到 Action 库并高亮该 Action
    await ref.click();
    await page.waitForURL(/\/actions\?highlight=[0-9a-f-]{36}/);
    await expect(
      page.getByRole("heading", { name: "集采计划审核", exact: true }),
    ).toBeVisible();
  });
});
