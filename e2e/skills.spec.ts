import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { cleanupByPrefix, cleanupRevisions, DATA_DIR } from "./helpers";

const PREFIX = "e2e-技能-";

/** 技能目录投影根（src/server/skill-library.ts）：data/skills/<slug>/ */
const SKILLS_ROOT = path.join(DATA_DIR, "skills");

/** 在投影根下找到含指定资源文件且内容一致的技能目录；找不到返回 null */
function findProjectionDir(relativePath: string, content: string): string | null {
  if (!fs.existsSync(SKILLS_ROOT)) return null;
  for (const entry of fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(SKILLS_ROOT, entry.name, relativePath);
    if (fs.existsSync(candidate) && fs.readFileSync(candidate, "utf8") === content)
      return path.join(SKILLS_ROOT, entry.name);
  }
  return null;
}

test.describe("Skill 库", () => {
  const created: Array<{ kind: "skill"; id: string }> = [];

  test.afterEach(async ({ request }) => {
    await cleanupByPrefix(request, "/api/skills", PREFIX);
    cleanupRevisions(created);
    created.length = 0;
  });

  test("列表显示种子 Skill「集采计划编制规范」", async ({ page }) => {
    await page.goto("/skills");
    await expect(
      page.getByRole("heading", { name: "集采计划编制规范", exact: true }),
    ).toBeVisible();
    // 第一批的「强制注入」语义已经不存在：页面上不能再出现这个说法（ADR-0016）
    await expect(page.getByText("强制注入")).toHaveCount(0);
  });

  test("新建 → 出现在列表 → 编辑描述 → 删除消失", async ({ page, request }) => {
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
    const listed = (await (
      await request.get(`/api/skills?q=${encodeURIComponent(name)}&pageSize=100`)
    ).json()) as { items: Array<{ id: string; name: string }> };
    const row = listed.items.find((item) => item.name === name);
    expect(row).toBeTruthy();
    created.push({ kind: "skill", id: row!.id });

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

  test("资源文件随技能整份提交：上传并改路径 → API 返回 files 且投影落盘 → 删除后清空", async ({
    page,
    request,
  }) => {
    const name = `${PREFIX}资源-${Date.now()}`;
    const fileContent = `e2e 资源文件 ${Date.now()}\n`;
    await page.goto("/skills");

    await page.getByRole("button", { name: "新建 Skill" }).click();
    await page.getByPlaceholder("如：集采计划编制规范").fill(name);
    await page.getByPlaceholder("Skill 全文…").fill("# 带资源文件的技能\n看 references/guide.md。");

    // 上传走隐藏的 <input type=file>；默认路径是文件名，改成带子目录的相对路径
    await page.locator('input[type="file"]').setInputFiles({
      name: "guide.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(fileContent, "utf8"),
    });
    const pathInput = page.getByLabel("资源文件路径");
    await expect(pathInput).toHaveValue("guide.md");
    await pathInput.fill("references/guide.md");
    await expect(page.getByText("1 / 32 个")).toBeVisible();

    const post = page.waitForResponse(
      (r) => r.url().endsWith("/api/skills") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "保存", exact: true }).click();
    const postRes = await post;
    expect(postRes.ok()).toBeTruthy();
    const createdSkill = (await postRes.json()) as {
      id: string;
      files: Array<{ path: string; contentBase64: string; size: number }>;
    };
    created.push({ kind: "skill", id: createdSkill.id });

    // 写入口把 files 原样收下：路径、大小、内容都能从 GET 取回
    const detail = (await (await request.get(`/api/skills/${createdSkill.id}`)).json()) as {
      files: Array<{ path: string; contentBase64: string; size: number }>;
    };
    expect(detail.files).toHaveLength(1);
    expect(detail.files[0].path).toBe("references/guide.md");
    expect(detail.files[0].size).toBe(Buffer.byteLength(fileContent, "utf8"));
    expect(Buffer.from(detail.files[0].contentBase64, "base64").toString("utf8")).toBe(
      fileContent,
    );

    // 投影是目录：data/skills/<slug>/references/guide.md 与 SKILL.md 同在
    const dir = findProjectionDir("references/guide.md", fileContent);
    expect(dir, "资源文件应投影到 data/skills/<slug>/ 下").toBeTruthy();
    expect(fs.existsSync(path.join(dir!, "SKILL.md"))).toBe(true);

    // 重开编辑器：清单从服务端拉回，路径与大小如实显示；删掉文件再保存 → files 清空、投影里也没了
    const card = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
    await card.getByRole("button", { name: "编辑" }).click();
    await expect(page.getByRole("heading", { name: "编辑 Skill" })).toBeVisible();
    await expect(page.getByLabel("资源文件路径")).toHaveValue("references/guide.md");
    await expect(page.getByText("1 / 32 个")).toBeVisible();
    await page.getByTitle("从技能目录移除此文件").click();
    await expect(page.getByText("（没有资源文件）")).toBeVisible();

    const put = page.waitForResponse(
      (r) => r.url().endsWith(`/api/skills/${createdSkill.id}`) && r.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "保存", exact: true }).click();
    expect((await put).ok()).toBeTruthy();
    await expect(page.getByRole("heading", { name: "编辑 Skill" })).toBeHidden();

    const after = (await (await request.get(`/api/skills/${createdSkill.id}`)).json()) as {
      files: unknown[];
    };
    expect(after.files).toEqual([]);
    expect(fs.existsSync(path.join(dir!, "references", "guide.md"))).toBe(false);
    expect(fs.existsSync(path.join(dir!, "SKILL.md"))).toBe(true);

    // 写入口拒绝越界路径与 SKILL.md 本身
    for (const badPath of ["../escape.md", "/abs.md", "SKILL.md"]) {
      const res = await request.put(`/api/skills/${createdSkill.id}`, {
        data: {
          name,
          description: "",
          content: "# x",
          files: [{ path: badPath, contentBase64: Buffer.from("x").toString("base64") }],
        },
      });
      expect(res.status(), `路径「${badPath}」应被 400 拒绝`).toBe(400);
    }
  });
});
