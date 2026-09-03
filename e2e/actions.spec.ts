import { expect, test } from "@playwright/test";
import {
  cleanupByPrefix,
  cleanupRevisions,
  createAction,
  createObjectType,
  createSkill,
  createTool,
  inputPort,
  outputPort,
  type RevisionOwner,
  uniqueSuffix,
} from "./helpers";

/**
 * Action 库。`db:seed` 只种平台基线（内置对象类型与模型表），业务实体一律由用例
 * 自建 `e2e-` 前缀夹具：列表页带 `?q=<前缀>` 打开，断言只落在自己造的那几张卡片上
 * （不断言库里总数，也不断言「首页恰好含某一行」）。
 */
const PREFIX = "e2e-Action-";

interface ActionListItem {
  id: string;
  name: string;
  preloadSkillIds: string[];
  toolIds: string[];
}

test.describe("Action 库", () => {
  const owners: RevisionOwner[] = [];

  test.afterEach(async ({ request }) => {
    // 引用方向：Action → 技能 / Tool / 对象类型
    await cleanupByPrefix(request, "/api/actions", PREFIX);
    await cleanupByPrefix(request, "/api/skills", PREFIX);
    await cleanupByPrefix(request, "/api/tools", PREFIX);
    await cleanupByPrefix(request, "/api/object-types", PREFIX);
    cleanupRevisions(owners);
    owners.length = 0;
  });

  test("自建三个 Action 都显示；带端口的那张卡片可见端口签名与预载 / 可见 Tool 计数", async ({
    page,
    request,
  }) => {
    const suffix = uniqueSuffix();
    const materialType = `${PREFIX}素材-${suffix}`;
    const verdictType = `${PREFIX}评语-${suffix}`;
    const skillName = `${PREFIX}评审要点-${suffix}`;
    const richName = `${PREFIX}评审-${suffix}`;
    const plainNames = [`${PREFIX}起草-${suffix}`, `${PREFIX}归档-${suffix}`];

    const materialTypeId = await createObjectType(request, { name: materialType }, owners);
    const verdictTypeId = await createObjectType(request, { name: verdictType }, owners);
    const skillId = await createSkill(
      request,
      {
        name: skillName,
        description: "评审要点",
        content: `# ${skillName}\n\n逐条核对，给出评语。\n`,
      },
      owners,
    );
    const toolId = await createTool(
      request,
      { name: `${PREFIX}归档入库-${suffix}`, publicName: `e2e_action_${suffix}` },
      owners,
    );

    // 端口签名：素材 → 评语 + 素材（输入与输出各出现一次「素材」徽章）
    await createAction(
      request,
      {
        name: richName,
        description: "带端口、预载技能与可见 Tool",
        ports: [
          inputPort("素材", materialTypeId),
          outputPort("评语", verdictTypeId, "verdict.md", 0),
          outputPort("素材", materialTypeId, "material.md", 1),
        ],
        preloadSkillIds: [skillId],
        toolIds: [toolId],
      },
      owners,
    );
    for (const name of plainNames) await createAction(request, { name }, owners);

    // 列表按本 spec 的前缀收窄：断言只对自建夹具，不碰库里其余行
    await page.goto(`/actions?q=${encodeURIComponent(PREFIX)}`);
    for (const name of [richName, ...plainNames]) {
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    }

    const card = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name: richName, exact: true }) });
    await expect(card).toHaveCount(1);
    await expect(card.getByText("→")).toBeVisible();
    await expect(card.getByText(verdictType, { exact: true })).toBeVisible();
    await expect(card.getByText(materialType, { exact: true })).toHaveCount(2);

    // 卡片上的两个计数与 DTO 的 preloadSkillIds / toolIds 对齐（ADR-0016：预载与可见，不再是「引用」）
    const listed = (await (
      await request.get(`/api/actions?q=${encodeURIComponent(richName)}&pageSize=100`)
    ).json()) as { items: ActionListItem[] };
    const dto = listed.items.find((item) => item.name === richName);
    expect(dto).toBeTruthy();
    expect(dto!.preloadSkillIds).toEqual([skillId]);
    expect(dto!.toolIds).toEqual([toolId]);
    await expect(card.getByText(`预载技能 × ${dto!.preloadSkillIds.length}`)).toBeVisible();
    await expect(card.getByText(`可见 Tool × ${dto!.toolIds.length}`)).toBeVisible();

    await card.getByRole("button", { name: "编辑" }).click();
    const effort = page.getByLabel("思考强度");
    await expect(effort.locator("option")).toHaveText([
      "off（关闭）",
      "low（低）",
      "high（高）",
      "max（最大）",
    ]);

    // 编辑器里两个分区是「预载技能」与「可见 Tool」，旧的「强制注入」说法不再出现
    await expect(page.getByRole("heading", { name: "编辑 Action", exact: true })).toBeVisible();
    await expect(page.getByText("预载技能", { exact: true })).toBeVisible();
    await expect(page.getByText("可见 Tool", { exact: true })).toBeVisible();
    await expect(page.getByText("强制注入")).toHaveCount(0);
    await expect(page.getByText("引用 Skill")).toHaveCount(0);

    // 从库页打开候选是全库：预载项按 DTO 勾选，旁边给出 token 估算，底部汇总预载数
    const preloadRow = page
      .locator("label")
      .filter({ has: page.getByText(skillName, { exact: true }) });
    await expect(preloadRow).toHaveCount(1);
    await expect(preloadRow.getByRole("checkbox")).toBeChecked();
    await expect(preloadRow.getByText(/约 \d+ token/)).toBeVisible();
    await expect(page.getByText(`预载 ${dto!.preloadSkillIds.length} 个，合计约`)).toBeVisible();
  });
});
