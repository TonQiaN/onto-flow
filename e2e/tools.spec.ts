import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  cleanupByPrefix,
  cleanupRevisions,
  createTool,
  createWorkflow,
  type RevisionOwner,
  TOOL_EXECUTE_MODULE,
  uniqueSuffix,
} from "./helpers";

/**
 * Tool 库：Tool 是 OntoFlow 契约（ADR-0017）——展示名、公名、描述、参数 schema、可选返回值
 * schema 与超时、一个 execute 模块；cordis 包装归平台，编辑器与 API 都不再出现
 * name / inject / apply。引用方是工作流的 Tool 集（ADR-0016）。
 *
 * `db:seed` 只种平台基线：用例自建 `e2e-` 前缀 Tool，afterEach 收走。
 */
const PREFIX = "e2e-Tool-";

/** 公名也要唯一，且只能是小写字母数字下划线；带随机尾巴保证与库里任何现有 Tool 不撞 */
function uniquePublicName(): string {
  return `e2e_tool_${uniqueSuffix()}`;
}

interface ToolRow {
  id: string;
  name: string;
  publicName: string;
  description: string;
  parameters: Record<string, unknown>;
  output: Record<string, unknown> | null;
  timeoutMs: number | null;
  code: string;
}

async function findTool(request: APIRequestContext, name: string): Promise<ToolRow | undefined> {
  const res = await request.get(`/api/tools?q=${encodeURIComponent(name)}&pageSize=100`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: ToolRow[] };
  return body.items.find((item) => item.name === name);
}

test.describe("Tool 库", () => {
  const owners: RevisionOwner[] = [];

  test.afterEach(async ({ request }) => {
    // 先删工作流：Tool 被工作流的 Tool 集引用时 DELETE 会 409
    await cleanupByPrefix(request, "/api/workflows", PREFIX);
    await cleanupByPrefix(request, "/api/tools", PREFIX);
    cleanupRevisions(owners);
    owners.length = 0;
  });

  test("自建 Tool 出现在列表，并显示描述与公名徽章", async ({ page, request }) => {
    const name = `${PREFIX}列表-${uniqueSuffix()}`;
    const publicName = uniquePublicName();
    const description = `e2e 列表描述 ${name}`;
    owners.push({
      kind: "tool",
      id: await createTool(request, { name, publicName, description }),
    });

    await page.goto("/tools");
    const card = page.locator("li").filter({ has: page.getByText(name, { exact: true }) });
    await expect(card).toHaveCount(1);
    await expect(card.getByText(publicName, { exact: true })).toBeVisible();
    await expect(card.getByText(description)).toBeVisible();
    // 契约形态下 Tool 不再是裸插件，列表页与副标题不能再这么介绍它
    await expect(page.getByText("cordis 插件")).toHaveCount(0);
  });

  test("编辑器按契约建 Tool：非法公名在客户端被拦下，合法保存后 API 行含完整契约；编辑与删除", async ({
    page,
    request,
  }) => {
    const name = `${PREFIX}${uniqueSuffix()}`;
    const publicName = uniquePublicName();
    await page.goto("/tools");

    await page.getByRole("button", { name: "新建 Tool" }).click();
    await expect(page.getByRole("heading", { name: "新建 Tool" })).toBeVisible();
    await page.getByPlaceholder("如：校验评分结果").fill(name);
    await page.getByPlaceholder("如：validate_resume_match_result").fill("Bad-Name");
    await page
      .getByPlaceholder("一句话说明这个 Tool 的用途（模型据此决定何时调用）")
      .fill("e2e 契约 Tool");
    await page.getByPlaceholder("留空即不限").fill("30000");

    // 公名不合法：客户端先拦，不发请求
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("模型可见的工具名「Bad-Name」非法")).toBeVisible();
    await expect(page.getByRole("heading", { name: "新建 Tool" })).toBeVisible();

    await page.getByPlaceholder("如：validate_resume_match_result").fill(publicName);
    const post = page.waitForResponse(
      (r) => r.url().endsWith("/api/tools") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "保存", exact: true }).click();
    expect((await post).ok()).toBeTruthy();
    await expect(page.getByRole("heading", { name: "新建 Tool" })).toBeHidden();

    const card = page.locator("li").filter({ has: page.getByText(name, { exact: true }) });
    await expect(card).toHaveCount(1);
    await expect(card.getByText(publicName, { exact: true })).toBeVisible();
    await expect(card.getByText("e2e 契约 Tool")).toBeVisible();

    // API 行是完整契约：模板 parameters 是对象根 schema，output 留空即 null，超时进 timeoutMs，
    // code 是 execute 模块而不是 cordis 插件
    const row = await findTool(request, name);
    expect(row).toBeTruthy();
    owners.push({ kind: "tool", id: row!.id });
    expect(row!.publicName).toBe(publicName);
    expect(row!.parameters.type).toBe("object");
    expect(row!.output).toBeNull();
    expect(row!.timeoutMs).toBe(30_000);
    expect(row!.code).toContain("export default async function execute");
    expect(row!.code).not.toContain("ctx.tools.register");

    // 编辑：重开时各字段回填；改描述后保存
    await card.getByRole("button", { name: "编辑" }).click();
    await expect(page.getByRole("heading", { name: "编辑 Tool" })).toBeVisible();
    await expect(page.getByPlaceholder("如：validate_resume_match_result")).toHaveValue(publicName);
    await expect(page.getByPlaceholder("留空即不限")).toHaveValue("30000");
    await page
      .getByPlaceholder("一句话说明这个 Tool 的用途（模型据此决定何时调用）")
      .fill("e2e 修改后的描述");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("heading", { name: "编辑 Tool" })).toBeHidden();
    await expect(card.getByText("e2e 修改后的描述")).toBeVisible();

    // 删除（接受 confirm 弹窗）
    page.once("dialog", (dialog) => void dialog.accept());
    await card.getByRole("button", { name: "删除" }).click();
    await expect(card).toHaveCount(0);
  });

  test("写入口校验：type 数组、@deepseek-ai 引用与非法超时都 400，公名重复 409", async ({
    request,
  }) => {
    const name = `${PREFIX}校验-${uniqueSuffix()}`;
    const publicName = uniquePublicName();
    const base = {
      name,
      publicName,
      description: "",
      parameters: { type: "object", properties: { input: { type: "string" } } },
      output: null,
      timeoutMs: null,
      code: TOOL_EXECUTE_MODULE,
    };

    const typeArray = await request.post("/api/tools", {
      data: {
        ...base,
        parameters: {
          type: "object",
          properties: { count: { type: ["integer", "null"] } },
        },
      },
    });
    expect(typeArray.status()).toBe(400);
    expect(await typeArray.text()).toContain("parameters.properties.count.type 不能是数组");

    const upstreamImport = await request.post("/api/tools", {
      data: { ...base, code: `import { x } from "@deepseek-ai/dsh-core";\n${TOOL_EXECUTE_MODULE}` },
    });
    expect(upstreamImport.status()).toBe(400);
    expect(await upstreamImport.text()).toContain("@deepseek-ai/");

    const badTimeout = await request.post("/api/tools", {
      data: { ...base, timeoutMs: 0 },
    });
    expect(badTimeout.status()).toBe(400);
    expect(await badTimeout.text()).toContain("timeoutMs");

    const badPublicName = await request.post("/api/tools", {
      data: { ...base, publicName: "Bad-Name" },
    });
    expect(badPublicName.status()).toBe(400);

    const ok = await request.post("/api/tools", { data: base });
    expect(ok.ok()).toBeTruthy();
    const created = (await ok.json()) as { id: string };
    owners.push({ kind: "tool", id: created.id });

    // 公名唯一交给数据库：同公名、不同展示名 → 409
    const duplicate = await request.post("/api/tools", {
      data: { ...base, name: `${name}-副本` },
    });
    expect(duplicate.status()).toBe(409);
  });

  test("被工作流 Tool 集引用的 Tool 不能删除（409 列出工作流名），面板「被引用」指向工作流设置页", async ({
    page,
    request,
  }) => {
    const suffix = uniqueSuffix();
    const toolName = `${PREFIX}引用-${suffix}`;
    const workflowName = `${PREFIX}工作流-${suffix}`;

    const toolId = await createTool(
      request,
      {
        name: toolName,
        publicName: uniquePublicName(),
        description: "被工作流引用",
        parameters: { type: "object", properties: {} },
      },
      owners,
    );
    const workflowId = await createWorkflow(
      request,
      { name: workflowName, description: "Tool 集引用验收", toolIds: [toolId] },
      owners,
    );

    const detail = (await (await request.get(`/api/workflows/${workflowId}`)).json()) as {
      workflow: { toolIds: string[] };
    };
    expect(detail.workflow.toolIds).toEqual([toolId]);

    const blocked = await request.delete(`/api/tools/${toolId}`);
    expect(blocked.status()).toBe(409);
    const body = (await blocked.json()) as { error: string; usedBy: string[] };
    expect(body.error).toBe("该 Tool 正被工作流引用，无法删除");
    expect(body.usedBy).toContain(workflowName);

    // 引用面板：分组标题是「工作流」，链接落到 /workflows/<id>/settings
    await page.goto("/tools");
    const card = page.locator("li").filter({ has: page.getByText(toolName, { exact: true }) });
    await expect(card.getByText("1 处引用")).toBeVisible();
    await card.getByRole("button", { name: "编辑" }).click();
    await page.getByRole("button", { name: "被引用", exact: true }).click();
    const panel = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "被引用" }) });
    await expect(panel.getByText("工作流（1）")).toBeVisible();
    const ref = panel.getByRole("link", { name: new RegExp(workflowName) });
    await expect(ref).toHaveAttribute("href", `/workflows/${workflowId}/settings`);
    await expect(ref).toContainText("Tool 集");

    // 工作流删掉之后 Tool 才能删
    expect((await request.delete(`/api/workflows/${workflowId}`)).ok()).toBeTruthy();
    expect((await request.delete(`/api/tools/${toolId}`)).ok()).toBeTruthy();
  });
});
