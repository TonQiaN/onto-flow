import { expect, test } from "@playwright/test";
import { cleanupByPrefix } from "./helpers";

const PREFIX = "e2e-技能-";

test.describe("Skill 库", () => {
  test.afterEach(async ({ request }) => {
    await cleanupByPrefix(request, "/api/skills", PREFIX);
  });

  test("列表显示种子 Skill「集采计划编制规范」", async ({ page }) => {
    await page.goto("/skills");
    await expect(
      page.getByRole("heading", { name: "集采计划编制规范", exact: true }),
    ).toBeVisible();
  });

  test("新建 → 出现在列表 → 编辑描述 → 删除消失", async ({ page }) => {
    const name = `${PREFIX}${Date.now()}`;
    await page.goto("/skills");

    // 新建
    await page.getByRole("button", { name: "新建 Skill" }).click();
    await expect(
      page.getByRole("heading", { name: "新建 Skill" }),
    ).toBeVisible();
    await page.getByPlaceholder("如：集采计划编制规范").fill(name);
    await page
      .getByPlaceholder("一句话说明这个 Skill 的用途")
      .fill("e2e 初始描述");
    await page.getByPlaceholder("Skill 全文…").fill("# e2e 测试内容\n仅供测试。");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("heading", { name: "新建 Skill" })).toBeHidden();

    const card = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
    await expect(card).toHaveCount(1);
    await expect(card.getByText("e2e 初始描述")).toBeVisible();

    // 编辑描述
    await card.getByRole("button", { name: "编辑" }).click();
    await expect(
      page.getByRole("heading", { name: "编辑 Skill" }),
    ).toBeVisible();
    await page
      .getByPlaceholder("一句话说明这个 Skill 的用途")
      .fill("e2e 修改后的描述");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("heading", { name: "编辑 Skill" })).toBeHidden();
    await expect(card.getByText("e2e 修改后的描述")).toBeVisible();

    // 删除（接受 confirm 弹窗）
    page.once("dialog", (dialog) => void dialog.accept());
    await card.getByRole("button", { name: "删除" }).click();
    await expect(card).toHaveCount(0);
  });
});
