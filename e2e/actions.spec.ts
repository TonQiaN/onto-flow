import { expect, test } from "@playwright/test";

interface ActionListItem {
  id: string;
  name: string;
  preloadSkillIds: string[];
  toolIds: string[];
}

test.describe("Action 库", () => {
  test("4 个种子 Action 均显示，「集采计划审核」卡片可见端口签名与预载 / 可见 Tool 计数", async ({
    page,
    request,
  }) => {
    await page.goto("/actions");

    for (const name of ["需求整理", "集采计划生成", "集采计划审核", "集采计划归档"]) {
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
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

    // 卡片上的两个计数与 DTO 的 preloadSkillIds / toolIds 对齐（ADR-0016：预载与可见，不再是「引用」）
    const listed = (await (
      await request.get("/api/actions?q=集采计划审核&pageSize=100")
    ).json()) as { items: ActionListItem[] };
    const dto = listed.items.find((item) => item.name === "集采计划审核");
    expect(dto).toBeTruthy();
    await expect(card.getByText(`预载技能 × ${dto!.preloadSkillIds.length}`)).toBeVisible();
    await expect(card.getByText(`可见 Tool × ${dto!.toolIds.length}`)).toBeVisible();
    // 种子把《集采计划审核要点》设为这个 Action 的预载
    const skills = (await (await request.get("/api/skills?pageSize=100")).json()) as {
      items: Array<{ id: string; name: string }>;
    };
    const reviewSkill = skills.items.find((s) => s.name === "集采计划审核要点");
    expect(reviewSkill).toBeTruthy();
    expect(dto!.preloadSkillIds).toContain(reviewSkill!.id);

    await card.getByRole("button", { name: "编辑" }).click();
    const effort = page.getByLabel("思考强度");
    await expect(effort.locator("option")).toHaveText([
      "off（关闭）",
      "low（低）",
      "high（高）",
      "max（最大）",
    ]);

    // 编辑器里两个分区改名为「预载技能」与「可见 Tool」，旧的「强制注入」说法不再出现
    await expect(page.getByRole("heading", { name: "编辑 Action", exact: true })).toBeVisible();
    await expect(page.getByText("预载技能", { exact: true })).toBeVisible();
    await expect(page.getByText("可见 Tool", { exact: true })).toBeVisible();
    await expect(page.getByText("强制注入")).toHaveCount(0);
    await expect(page.getByText("引用 Skill")).toHaveCount(0);

    // 从库页打开候选是全库：预载项按 DTO 勾选，旁边给出 token 估算，底部汇总预载数
    const preloadRow = page
      .locator("label")
      .filter({ has: page.getByText("集采计划审核要点", { exact: true }) });
    await expect(preloadRow).toHaveCount(1);
    await expect(preloadRow.getByRole("checkbox")).toBeChecked();
    await expect(preloadRow.getByText(/约 \d+ token/)).toBeVisible();
    await expect(page.getByText(`预载 ${dto!.preloadSkillIds.length} 个，合计约`)).toBeVisible();
  });
});
