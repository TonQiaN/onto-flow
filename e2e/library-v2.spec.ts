import { expect, test } from "@playwright/test";
import {
  assignToFolder,
  cleanupByPrefix,
  cleanupFoldersByPrefix,
  cleanupRevisions,
  createAction,
  createFolder,
  createSkill,
  createWorkflow,
  type RevisionOwner,
  uniqueSuffix,
} from "./helpers";

/**
 * OntoFlow v2 阶段一新能力的验收：文件夹树筛选（ADR-0005，单归属含子孙语义）、
 * 树上的文件夹管理（新建/重命名/删除）、编辑面板的「修订历史」与「被引用」。
 *
 * `db:seed` 只种平台基线，所以每个用例都自建 `e2e-` 前缀夹具（文件夹、Action、
 * Skill、工作流），收尾时经 cleanupByPrefix / cleanupFoldersByPrefix /
 * cleanupRevisions 收走；断言只落在这些夹具或 API 载荷上。
 */
const PREFIX = "e2e-库v2-";
const FOLDER_PREFIX = "e2e-文件夹-";

test.describe("库 v2 新能力", () => {
  const owners: RevisionOwner[] = [];

  test.afterEach(async ({ request }) => {
    // 先删工作流（它引用技能集），再删各库实体，最后收文件夹与修订
    await cleanupByPrefix(request, "/api/workflows", PREFIX);
    await cleanupByPrefix(request, "/api/actions", PREFIX);
    await cleanupByPrefix(request, "/api/skills", PREFIX);
    await cleanupFoldersByPrefix(request, FOLDER_PREFIX);
    cleanupRevisions(owners);
    owners.length = 0;
  });

  test("文件夹树点自建的二级文件夹：Action 列表收窄且 URL 出现 ?folder=", async ({
    page,
    request,
  }) => {
    const suffix = uniqueSuffix();
    // 两级文件夹：<一级>/<二级甲> 放两个 Action，<一级>/<二级乙> 放一个
    const rootName = `${FOLDER_PREFIX}一级-${suffix}`;
    const rootId = await createFolder(request, rootName);
    const leftId = await createFolder(request, `${FOLDER_PREFIX}二级甲-${suffix}`, rootId);
    const rightId = await createFolder(request, `${FOLDER_PREFIX}二级乙-${suffix}`, rootId);
    const leftPath = `${rootName}/${FOLDER_PREFIX}二级甲-${suffix}`;

    const inLeft = [`${PREFIX}甲一-${suffix}`, `${PREFIX}甲二-${suffix}`];
    const inRight = `${PREFIX}乙一-${suffix}`;
    for (const name of inLeft) {
      await assignToFolder(
        request,
        "action",
        await createAction(request, { name }, owners),
        leftId,
      );
    }
    await assignToFolder(
      request,
      "action",
      await createAction(request, { name: inRight }, owners),
      rightId,
    );

    await page.goto("/actions");

    // 未筛选的总数随真实使用增长，写死会红——从 API 取当前值再比对 DOM
    // （这一类断言在本仓库已经踩过两次，见 AGENTS.md）。
    const total = (
      (await (await page.request.get("/api/actions?page=1")).json()) as { total: number }
    ).total;
    await expect(page.getByText(`共 ${total} 条`)).toBeVisible();

    // 树上文件夹行的 title 是完整路径；卡片上的文件夹徽章 title 是
    // 「进入文件夹「…」」，用 exact 把两者区分开。
    await page.getByTitle(leftPath, { exact: true }).click();

    // URL 同步出 folder 参数（值是文件夹 uuid）
    await expect(page).toHaveURL(/[?&]folder=[0-9a-f-]{36}/);

    // 收窄到自建的二级甲：只剩本用例放进去的两个 Action，兄弟文件夹里的那个消失
    const filtered = (
      (await (await page.request.get(`/api/actions?folder=${leftId}&page=1`)).json()) as {
        total: number;
      }
    ).total;
    expect(filtered, "二级甲里只有本用例放进去的两个 Action").toBe(inLeft.length);
    await expect(page.getByText(`共 ${filtered} 条`)).toBeVisible();
    for (const kept of inLeft) {
      await expect(page.getByRole("heading", { name: kept, exact: true })).toBeVisible();
    }
    await expect(page.getByRole("heading", { name: inRight, exact: true })).toHaveCount(0);

    // 点树顶部的「全部」清空筛选（筛选中该按钮带「清空筛选」副标，
    // 与「全部折叠」区分开），URL 里的 folder 参数消失，列表恢复
    await page.getByRole("button", { name: "全部 清空筛选" }).click();
    await expect(page).not.toHaveURL(/[?&]folder=/);
    await expect(page.getByText(`共 ${total} 条`)).toBeVisible();
  });

  test("树上管理文件夹：「＋」新建根文件夹 → 右键重命名 → 右键删除", async ({ page }) => {
    const name = `${FOLDER_PREFIX}${uniqueSuffix()}`;
    const renamed = `${name}-改`;
    await page.goto("/actions");

    // 树顶「＋」新建根文件夹：行内输入，Enter 提交
    await page.getByRole("button", { name: "新建根文件夹" }).click();
    await page.getByPlaceholder("文件夹名").fill(name);
    await page.getByPlaceholder("文件夹名").press("Enter");
    // 根文件夹的完整路径就是名字本身
    await expect(page.getByTitle(name, { exact: true })).toBeVisible();

    // 右键 → 重命名：行内输入预填原名，改名后 Enter 提交
    await page.getByTitle(name, { exact: true }).click({ button: "right" });
    await page.getByRole("button", { name: "重命名" }).click();
    await page.getByPlaceholder("文件夹名").fill(renamed);
    await page.getByPlaceholder("文件夹名").press("Enter");
    await expect(page.getByTitle(renamed, { exact: true })).toBeVisible();
    await expect(page.getByTitle(name, { exact: true })).toHaveCount(0);

    // 右键 → 删除文件夹：window.confirm 说明内容去向，接受后行消失
    await page.getByTitle(renamed, { exact: true }).click({ button: "right" });
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "删除文件夹" }).click();
    await expect(page.getByTitle(renamed, { exact: true })).toHaveCount(0);
    // 用例中途失败时由 afterEach 的 cleanupFoldersByPrefix 兜底
  });

  test("编辑面板「修订历史」显示自建实体的 v1，且与当前定义无差异", async ({ page, request }) => {
    const name = `${PREFIX}修订-${uniqueSuffix()}`;
    await createSkill(request, { name, description: "修订历史验收" }, owners);

    await page.goto(`/skills?q=${encodeURIComponent(name)}`);
    const card = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
    await expect(card).toHaveCount(1);
    await card.getByRole("button", { name: "编辑" }).click();
    await expect(page.getByRole("heading", { name: "编辑 Skill" })).toBeVisible();

    await page.getByRole("button", { name: "修订历史", exact: true }).click();

    const panel = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "修订历史" }) });
    await expect(panel).toHaveCount(1);
    // 刚建出来的实体恰好一版：这是本用例自己造的事实，不是库里的存量
    await expect(panel.getByText("共 1 版")).toBeVisible();
    await expect(panel.getByText("v1", { exact: true })).toBeVisible();
    // 写入口记录的 v1 没有备注（备注要么由回滚写，要么由用户手填）
    await expect(panel.getByText("（无备注）", { exact: true })).toBeVisible();

    // 展开 v1：与当前定义没有差异（建库后未改过）
    await page.getByRole("button", { name: /v1/ }).click();
    await expect(panel.getByText("与当前定义一致，无差异。")).toBeVisible();
  });

  test("编辑面板「被引用」显示引用方：自建 Skill 被自建工作流的技能集引用", async ({
    page,
    request,
  }) => {
    // 引用关系的事实源是工作流的技能集（workflow_skills，ADR-0016）：Action 的预载不是引用。
    const suffix = uniqueSuffix();
    const skillName = `${PREFIX}被引用技能-${suffix}`;
    const workflowName = `${PREFIX}引用方工作流-${suffix}`;
    const skillId = await createSkill(request, { name: skillName }, owners);
    const workflowId = await createWorkflow(
      request,
      { name: workflowName, skillIds: [skillId] },
      owners,
    );

    // 引用数从 API 取，DOM 与载荷比对；本用例只造了一处引用
    const skills = (await (
      await request.get(`/api/skills?q=${encodeURIComponent(skillName)}&pageSize=100`)
    ).json()) as { items: Array<{ id: string; name: string; refCount: number }> };
    const skill = skills.items.find((s) => s.name === skillName);
    expect(skill).toBeTruthy();
    const { refs } = (await (
      await request.get(`/api/references?kind=skill&id=${skillId}`)
    ).json()) as {
      refs: Array<{ kind: string; id: string; name: string; detail: string; href: string }>;
    };
    expect(
      refs.every((r) => r.kind === "workflow"),
      "Skill 只会被工作流引用",
    ).toBe(true);
    expect(refs.map((r) => r.id)).toEqual([workflowId]);
    expect(refs[0].name).toBe(workflowName);
    expect(refs[0].detail).toBe("技能集");
    expect(refs[0].href).toBe(`/workflows/${workflowId}/settings`);
    expect(skill!.refCount).toBe(refs.length);

    await page.goto(`/skills?q=${encodeURIComponent(skillName)}`);
    const card = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name: skillName, exact: true }) });
    await expect(card.getByText(`${refs.length} 处引用`)).toBeVisible();
    await card.getByRole("button", { name: "编辑" }).click();
    await expect(page.getByRole("heading", { name: "编辑 Skill" })).toBeVisible();

    await page.getByRole("button", { name: "被引用", exact: true }).click();

    const panel = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "被引用" }) });
    await expect(panel).toHaveCount(1);
    await expect(panel.getByText(`被 ${refs.length} 处引用`)).toBeVisible();
    await expect(panel.getByText(`工作流（${refs.length}）`)).toBeVisible();
    await expect(panel.getByText("Action（")).toHaveCount(0);

    const ref = panel.getByRole("link", { name: new RegExp(workflowName) });
    await expect(ref).toHaveCount(1);
    await expect(ref).toContainText("技能集");
    await expect(ref).toHaveAttribute("href", `/workflows/${workflowId}/settings`);

    // 点进去跳到该工作流的设置页——技能集就在那里编辑
    await ref.click();
    await page.waitForURL(new RegExp(`/workflows/${workflowId}/settings$`));
    await expect(page.getByRole("heading", { name: "工作流设置", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^技能集（\d+）$/ })).toBeVisible();
  });
});
