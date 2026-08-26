import { expect, test } from "@playwright/test";
import { cleanupByPrefix } from "./helpers";

const PREFIX = "e2e-类型-";
const SCHEMA_PLACEHOLDER = '{"type":"object","properties":{...},"required":[...]}';

test.describe("对象类型", () => {
  test.afterEach(async ({ request }) => {
    await cleanupByPrefix(request, "/api/object-types", PREFIX);
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

  test("非法 JSON Schema 被阻止；合法 schema 创建成功后可删除", async ({
    page,
  }) => {
    const name = `${PREFIX}${Date.now()}`;
    await page.goto("/object-types");

    await page.getByRole("button", { name: "新建类型" }).click();
    await expect(
      page.getByRole("heading", { name: "新建对象类型" }),
    ).toBeVisible();
    await page.getByPlaceholder("如：需求文件、集采计划").fill(name);
    // v2 顶部工具条也有一个 select（排序），按标签定位到抽屉里的「基础形态」
    await page.getByLabel("基础形态").selectOption("json");

    // 非法 schema：被阻止，出现错误提示，弹层不关闭
    await page.getByPlaceholder(SCHEMA_PLACEHOLDER).fill("{这不是合法的 JSON");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("JSON Schema 不是合法 JSON")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "新建对象类型" }),
    ).toBeVisible();

    // 合法 schema：创建成功
    await page
      .getByPlaceholder(SCHEMA_PLACEHOLDER)
      .fill('{"type":"object","properties":{"name":{"type":"string"}}}');
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "新建对象类型" }),
    ).toBeHidden();

    const row = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
    await expect(row).toHaveCount(1);
    await expect(row.getByText("含 Schema")).toBeVisible();

    // 删除（接受 confirm 弹窗）
    page.once("dialog", (dialog) => void dialog.accept());
    await row.getByRole("button", { name: "删除" }).click();
    await expect(row).toHaveCount(0);
  });

  test("文件类型可保存并回显 PDF 输入预处理", async ({ page }) => {
    const name = `${PREFIX}PDF-${Date.now()}`;
    await page.goto("/object-types");

    await page.getByRole("button", { name: "新建类型" }).click();
    await page.getByPlaceholder("如：需求文件、集采计划").fill(name);
    await page.getByLabel("基础形态").selectOption("file");
    await page.getByLabel("输入预处理").selectOption("pdf");
    await page.getByRole("button", { name: "保存", exact: true }).click();

    const row = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
    await expect(row.getByText("PDF 预处理", { exact: true })).toBeVisible();

    await row.getByRole("button", { name: "编辑" }).click();
    await expect(page.getByLabel("输入预处理")).toHaveValue("pdf");
    await page.getByRole("button", { name: "取消", exact: true }).click();
  });

  test("删除被引用的「集采计划」类型：显示 409 引用信息且实体保留", async ({
    page,
  }) => {
    await page.goto("/object-types");
    const row = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name: "集采计划", exact: true }) });
    await expect(row).toHaveCount(1);

    page.once("dialog", (dialog) => void dialog.accept());
    await row.getByRole("button", { name: "删除" }).click();

    // 409：错误提示带 usedBy 引用方
    await expect(
      row.getByText("该对象类型正被引用，无法删除"),
    ).toBeVisible();
    await expect(row.getByText(/引用方：.*集采计划审核/)).toBeVisible();

    // 实体仍在列表（刷新后依旧存在）
    await page.reload();
    await expect(
      page
        .locator("li")
        .filter({ has: page.getByRole("heading", { name: "集采计划", exact: true }) }),
    ).toHaveCount(1);
  });
});
