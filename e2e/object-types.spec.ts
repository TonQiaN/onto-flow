import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  cleanupByPrefix,
  cleanupRevisions,
  createAction,
  createObjectType,
  inputPort,
  outputPort,
  type RevisionOwner,
  uniqueSuffix,
} from "./helpers";

/**
 * 对象类型库。`db:seed` 只种平台基线（内置的 text / file / json 与模型表），
 * 业务类型一律由用例自建 `e2e-` 前缀夹具并在 afterEach 收走。
 */
const PREFIX = "e2e-类型-";
const SCHEMA_PLACEHOLDER = '{"type":"object","properties":{...},"required":[...]}';

test.describe("对象类型", () => {
  const owners: RevisionOwner[] = [];

  /** 经界面建出来的类型没有返回体，回查一次把 id 记进 owners，修订才收得干净 */
  async function recordCreated(request: APIRequestContext, name: string): Promise<void> {
    const res = await request.get(`/api/object-types?q=${encodeURIComponent(name)}&pageSize=100`);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { items: Array<{ id: string; name: string }> };
    const row = body.items.find((item) => item.name === name);
    expect(row).toBeTruthy();
    owners.push({ kind: "object_type", id: row!.id });
  }

  test.afterEach(async ({ request }) => {
    // 先删 Action：对象类型被 Action 端口引用时 DELETE 会 409
    await cleanupByPrefix(request, "/api/actions", PREFIX);
    await cleanupByPrefix(request, "/api/object-types", PREFIX);
    cleanupRevisions(owners);
    owners.length = 0;
  });

  test("内置类型显示「内置」徽章且无编辑/删除按钮", async ({ page }) => {
    await page.goto("/object-types");
    for (const name of ["text", "file", "json"]) {
      const row = page
        .locator("li")
        .filter({ has: page.getByRole("heading", { name, exact: true }) });
      await expect(row).toHaveCount(1);
      const builtinBadge = row.getByText("内置", { exact: true });
      await expect(builtinBadge).toHaveCount(1);
      await expect(builtinBadge).toBeVisible();
      await expect(row.getByRole("button", { name: "删除" })).toHaveCount(0);
      await expect(row.getByRole("button", { name: "编辑" })).toHaveCount(0);
    }
  });

  test("非法 JSON Schema 被阻止；合法 schema 创建成功后可删除", async ({ page, request }) => {
    const name = `${PREFIX}${uniqueSuffix()}`;
    await page.goto("/object-types");

    await page.getByRole("button", { name: "新建类型" }).click();
    await expect(page.getByRole("heading", { name: "新建对象类型" })).toBeVisible();
    await page.getByPlaceholder("如：岗位JD文件、简历Markdown").fill(name);
    // v2 顶部工具条也有一个 select（排序），按标签定位到抽屉里的「基础形态」
    await page.getByLabel("基础形态").selectOption("json");

    // 非法 schema：被阻止，出现错误提示，弹层不关闭
    await page.getByPlaceholder(SCHEMA_PLACEHOLDER).fill("{这不是合法的 JSON");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("JSON Schema 不是合法 JSON")).toBeVisible();
    await expect(page.getByRole("heading", { name: "新建对象类型" })).toBeVisible();

    // 合法 schema：创建成功
    await page
      .getByPlaceholder(SCHEMA_PLACEHOLDER)
      .fill('{"type":"object","properties":{"name":{"type":"string"}}}');
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("heading", { name: "新建对象类型" })).toBeHidden();

    const row = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
    await expect(row).toHaveCount(1);
    await expect(row.getByText("含 Schema")).toBeVisible();
    await recordCreated(request, name);

    // 删除（接受 confirm 弹窗）
    page.once("dialog", (dialog) => void dialog.accept());
    await row.getByRole("button", { name: "删除" }).click();
    await expect(row).toHaveCount(0);
  });

  test("文件类型可保存并回显基础形态", async ({ page, request }) => {
    const name = `${PREFIX}文件-${uniqueSuffix()}`;
    await page.goto("/object-types");

    await page.getByRole("button", { name: "新建类型" }).click();
    await page.getByPlaceholder("如：岗位JD文件、简历Markdown").fill(name);
    await page.getByLabel("基础形态").selectOption("file");
    await page.getByRole("button", { name: "保存", exact: true }).click();

    const row = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
    await expect(row).toHaveCount(1);
    await recordCreated(request, name);

    await row.getByRole("button", { name: "编辑" }).click();
    await expect(page.getByLabel("基础形态")).toHaveValue("file");
    await page.getByRole("button", { name: "取消", exact: true }).click();
  });

  test("删除被自建 Action 端口引用的类型：显示 409 引用信息且实体保留", async ({
    page,
    request,
  }) => {
    const suffix = uniqueSuffix();
    const typeName = `${PREFIX}被引用-${suffix}`;
    const actionName = `${PREFIX}引用方-${suffix}`;
    const objectTypeId = await createObjectType(request, { name: typeName }, owners);
    await createAction(
      request,
      {
        name: actionName,
        ports: [inputPort("素材", objectTypeId), outputPort("成品", objectTypeId, "out.md")],
      },
      owners,
    );

    await page.goto("/object-types");
    const row = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name: typeName, exact: true }) });
    await expect(row).toHaveCount(1);

    page.once("dialog", (dialog) => void dialog.accept());
    await row.getByRole("button", { name: "删除" }).click();

    // 409：错误提示带 usedBy 引用方
    await expect(row.getByText("该对象类型正被引用，无法删除")).toBeVisible();
    await expect(row.getByText(`引用方：${actionName}`)).toBeVisible();

    // 实体仍在列表（刷新后依旧存在）
    await page.reload();
    await expect(
      page
        .locator("li")
        .filter({ has: page.getByRole("heading", { name: typeName, exact: true }) }),
    ).toHaveCount(1);
  });
});
