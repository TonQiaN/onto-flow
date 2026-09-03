import { expect, test } from "@playwright/test";

const FOLDER_PREFIX = "e2e-文件夹-";

/** 兜底清理：删除树上残留的 e2e 前缀文件夹（正常流程里用例自己已删干净） */
async function cleanupFoldersByPrefix(
  request: import("@playwright/test").APIRequestContext,
  prefix: string,
): Promise<void> {
  const res = await request.get("/api/folders");
  if (!res.ok()) return;
  const body = (await res.json()) as {
    folders?: Array<{ id: string; name: string }>;
  };
  for (const folder of body.folders ?? []) {
    if (!folder.name.startsWith(prefix)) continue;
    await request.delete(`/api/folders/${folder.id}`);
  }
}

/**
 * OntoFlow v2 阶段一新能力的验收：文件夹树筛选（ADR-0005，单归属含子孙语义）、
 * 树上的文件夹管理（新建/重命名/删除）、编辑面板的「修订历史」与「被引用」。
 * 筛选与面板用例只读种子数据；管理用例自建 e2e 前缀文件夹并在用例内删除。
 */
test.describe("库 v2 新能力", () => {
  test("文件夹树点「采购/集采」：Action 列表收窄且 URL 出现 ?folder=", async ({ page }) => {
    await page.goto("/actions");

    // 未筛选的总数随真实使用增长，写死会红——从 API 取当前值再比对 DOM
    // （这一类断言在本仓库已经踩过两次，见 AGENTS.md）。
    const total = (
      (await (await page.request.get("/api/actions?page=1")).json()) as { total: number }
    ).total;
    await expect(page.getByRole("heading", { name: "集采计划生成", exact: true })).toBeVisible();
    await expect(page.getByText(`共 ${total} 条`)).toBeVisible();

    // 树上文件夹行的 title 是完整路径；卡片上的文件夹徽章 title 是
    // 「进入文件夹「…」」，用 exact 把两者区分开。
    await page.getByTitle("采购/集采", { exact: true }).click();

    // URL 同步出 folder 参数（值是文件夹 uuid）
    await expect(page).toHaveURL(/[?&]folder=[0-9a-f-]{36}/);

    // 列表收窄到「采购/集采」下的 3 个 Action，「采购/需求」下的需求整理消失
    await expect(page.getByText("共 3 条")).toBeVisible();
    expect(total, "筛选后应比未筛选少").toBeGreaterThanOrEqual(3);
    await expect(page.getByRole("heading", { name: "需求整理", exact: true })).toHaveCount(0);
    for (const kept of ["集采计划生成", "集采计划审核", "集采计划归档"]) {
      await expect(page.getByRole("heading", { name: kept, exact: true })).toBeVisible();
    }

    // 点树顶部的「全部」清空筛选（筛选中该按钮带「清空筛选」副标，
    // 与「全部折叠」区分开），URL 里的 folder 参数消失，列表恢复
    await page.getByRole("button", { name: "全部 清空筛选" }).click();
    await expect(page).not.toHaveURL(/[?&]folder=/);
    await expect(page.getByText(`共 ${total} 条`)).toBeVisible();
  });

  test("树上管理文件夹：「＋」新建根文件夹 → 右键重命名 → 右键删除", async ({ page, request }) => {
    const name = `${FOLDER_PREFIX}${Date.now()}`;
    const renamed = `${name}-改`;
    try {
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
    } finally {
      // 用例中途失败时兜底清掉残留的 e2e 文件夹
      await cleanupFoldersByPrefix(request, FOLDER_PREFIX);
    }
  });

  test("编辑面板「修订历史」显示 v1「种子初始版本」", async ({ page }) => {
    await page.goto("/skills");

    const card = page.locator("li").filter({
      has: page.getByRole("heading", { name: "集采计划审核要点", exact: true }),
    });
    await expect(card).toHaveCount(1);
    await card.getByRole("button", { name: "编辑" }).click();
    await expect(page.getByRole("heading", { name: "编辑 Skill" })).toBeVisible();

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

  test("编辑面板「被引用」显示引用方：Skill「集采计划审核要点」被工作流「采购集采计划生成」的技能集引用", async ({
    page,
    request,
  }) => {
    // 引用关系的事实源是工作流的技能集（workflow_skills，ADR-0016）：Action 的预载不是引用。
    // 引用数会随真实使用增长（别的工作流也可以把它加进技能集），所以从 API 取当前值再比对 DOM。
    const skills = (await (await request.get("/api/skills?pageSize=100")).json()) as {
      items: Array<{ id: string; name: string; refCount: number }>;
    };
    const skill = skills.items.find((s) => s.name === "集采计划审核要点");
    expect(skill).toBeTruthy();
    const { refs } = (await (
      await request.get(`/api/references?kind=skill&id=${skill!.id}`)
    ).json()) as {
      refs: Array<{ kind: string; id: string; name: string; detail: string; href: string }>;
    };
    expect(refs.length).toBeGreaterThan(0);
    expect(
      refs.every((r) => r.kind === "workflow"),
      "Skill 只会被工作流引用",
    ).toBe(true);
    const seedRef = refs.find((r) => r.name === "采购集采计划生成");
    expect(seedRef, "种子工作流的技能集含《集采计划审核要点》").toBeTruthy();
    expect(seedRef!.detail).toBe("技能集");
    expect(seedRef!.href).toBe(`/workflows/${seedRef!.id}/settings`);
    expect(skill!.refCount).toBe(refs.length);

    await page.goto("/skills");
    const card = page.locator("li").filter({
      has: page.getByRole("heading", { name: "集采计划审核要点", exact: true }),
    });
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

    const ref = panel.getByRole("link", { name: /采购集采计划生成/ });
    await expect(ref).toHaveCount(1);
    await expect(ref).toContainText("技能集");
    await expect(ref).toHaveAttribute("href", seedRef!.href);

    // 点进去跳到该工作流的设置页——技能集就在那里编辑
    await ref.click();
    await page.waitForURL(new RegExp(`/workflows/${seedRef!.id}/settings$`));
    await expect(page.getByRole("heading", { name: "工作流设置", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^技能集（\d+）$/ })).toBeVisible();
  });
});
