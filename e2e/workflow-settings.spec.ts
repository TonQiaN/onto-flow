import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { cleanupByPrefix, cleanupRevisions, type RevisionOwnerKind } from "./helpers";

/**
 * 工作流设置——三层设置的中间层（ADR-0016）：工作流指令、五个插件开关的覆盖、MCP 子集、
 * 技能集与 Tool 集；Action 的预载 ⊆ 技能集、可见 Tool ⊆ Tool 集在保存整图时校验。
 *
 * 全部夹具自造（e2e- 中文前缀），断言只对夹具或对齐 API 载荷。唯一发起的运行是
 * 输入→输出直通工作流（无 Action、零费用），用来验证受理时冻结的设置快照。
 */
const PREFIX = "e2e-工作流设置-";

const EXECUTE_MODULE = `export default async function execute(args: { input: string }) {
  return { echo: args.input };
}
`;

interface Fixture {
  suffix: number;
  objectTypeId: string;
  skillId: string;
  skillName: string;
  toolId: string;
  toolName: string;
  toolPublicName: string;
  actionId: string;
  actionName: string;
}

interface WorkflowDetail {
  workflow: {
    id: string;
    name: string;
    instructions: string;
    settings: { toggles: Record<string, boolean>; mcpServers: string[] };
    skillIds: string[];
    toolIds: string[];
  };
  nodes: Array<{ id: string; kind: string }>;
  edges: unknown[];
}

const owners: Array<{ kind: RevisionOwnerKind; id: string }> = [];

/** 一套夹具：对象类型、技能、Tool，以及预载该技能并可见该 Tool 的 Action */
async function createFixture(request: APIRequestContext): Promise<Fixture> {
  const suffix = Date.now();
  const modelRes = await request.get("/api/models");
  expect(modelRes.ok()).toBeTruthy();
  const model = ((await modelRes.json()) as Array<{ id: string }>)[0];
  expect(model).toBeDefined();

  const typeRes = await request.post("/api/object-types", {
    data: { name: `${PREFIX}文本-${suffix}`, kind: "text", description: "工作流设置验收" },
  });
  expect(typeRes.ok()).toBeTruthy();
  const objectTypeId = ((await typeRes.json()) as { id: string }).id;
  owners.push({ kind: "object_type", id: objectTypeId });

  const skillName = `${PREFIX}技能-${suffix}`;
  const skillRes = await request.post("/api/skills", {
    data: {
      name: skillName,
      description: "设置验收用技能",
      content: "# 设置验收\n\n只在 e2e 里出现。",
    },
  });
  expect(skillRes.ok()).toBeTruthy();
  const skillId = ((await skillRes.json()) as { id: string }).id;
  owners.push({ kind: "skill", id: skillId });

  const toolName = `${PREFIX}Tool-${suffix}`;
  const toolPublicName = `e2e_wf_settings_${suffix}`;
  const toolRes = await request.post("/api/tools", {
    data: {
      name: toolName,
      publicName: toolPublicName,
      description: "设置验收用 Tool",
      parameters: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      },
      code: EXECUTE_MODULE,
    },
  });
  expect(toolRes.ok()).toBeTruthy();
  const toolId = ((await toolRes.json()) as { id: string }).id;
  owners.push({ kind: "tool", id: toolId });

  const actionName = `${PREFIX}Action-${suffix}`;
  const actionRes = await request.post("/api/actions", {
    data: {
      name: actionName,
      description: "预载技能并看见 Tool",
      prompt: "读输入写输出",
      rule: "",
      modelId: model!.id,
      reasoningEffort: "low",
      maxReentries: 0,
      onExhausted: "fail",
      ports: [
        {
          direction: "input",
          name: "输入",
          objectTypeId,
          position: 0,
          artifactPath: null,
          exitName: null,
        },
        {
          direction: "output",
          name: "输出",
          objectTypeId,
          position: 0,
          artifactPath: "out.md",
          exitName: null,
        },
      ],
      preloadSkillIds: [skillId],
      toolIds: [toolId],
    },
  });
  expect(actionRes.ok()).toBeTruthy();
  const action = (await actionRes.json()) as {
    id: string;
    preloadSkillIds: string[];
    toolIds: string[];
  };
  expect(action.preloadSkillIds).toEqual([skillId]);
  expect(action.toolIds).toEqual([toolId]);
  owners.push({ kind: "action", id: action.id });

  return {
    suffix,
    objectTypeId,
    skillId,
    skillName,
    toolId,
    toolName,
    toolPublicName,
    actionId: action.id,
    actionName,
  };
}

/** 输入 → Action → 输出 三节点图 */
function actionGraph(fx: Fixture) {
  const inputId = randomUUID();
  const actionNodeId = randomUUID();
  const outputId = randomUUID();
  return {
    nodes: [
      {
        id: inputId,
        kind: "input",
        actionId: null,
        objectTypeId: fx.objectTypeId,
        label: "输入",
        x: 0,
        y: 0,
      },
      {
        id: actionNodeId,
        kind: "action",
        actionId: fx.actionId,
        objectTypeId: null,
        label: fx.actionName,
        x: 320,
        y: 0,
      },
      {
        id: outputId,
        kind: "output",
        actionId: null,
        objectTypeId: fx.objectTypeId,
        label: "输出",
        x: 640,
        y: 0,
      },
    ],
    edges: [
      {
        id: randomUUID(),
        sourceNodeId: inputId,
        sourcePort: "value",
        targetNodeId: actionNodeId,
        targetPort: "输入",
      },
      {
        id: randomUUID(),
        sourceNodeId: actionNodeId,
        sourcePort: "输出",
        targetNodeId: outputId,
        targetPort: "value",
      },
    ],
  };
}

async function createWorkflow(
  request: APIRequestContext,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await request.post("/api/workflows", {
    data: { name, description: "工作流设置验收", ...extra },
  });
  expect(res.ok()).toBeTruthy();
  const id = ((await res.json()) as { id: string }).id;
  owners.push({ kind: "workflow", id });
  return id;
}

async function getDetail(request: APIRequestContext, id: string): Promise<WorkflowDetail> {
  const res = await request.get(`/api/workflows/${id}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as WorkflowDetail;
}

async function removeAll(request: APIRequestContext): Promise<void> {
  // 先收运行，再按引用方向删：工作流 → Action → 技能 / Tool → 对象类型
  const wfRes = await request.get(`/api/workflows?q=${encodeURIComponent(PREFIX)}&pageSize=100`);
  if (wfRes.ok()) {
    const body = (await wfRes.json()) as { items?: Array<{ id: string; name: string }> };
    for (const wf of body.items ?? []) {
      if (!wf.name.startsWith(PREFIX)) continue;
      const runsRes = await request.get(`/api/runs?workflowId=${wf.id}`);
      if (!runsRes.ok()) continue;
      for (const row of (await runsRes.json()) as Array<{ id: string }>)
        await request.delete(`/api/runs/${row.id}`);
    }
  }
  await cleanupByPrefix(request, "/api/workflows", PREFIX);
  await cleanupByPrefix(request, "/api/actions", PREFIX);
  await cleanupByPrefix(request, "/api/skills", PREFIX);
  await cleanupByPrefix(request, "/api/tools", PREFIX);
  await cleanupByPrefix(request, "/api/object-types", PREFIX);
  cleanupRevisions(owners);
  owners.length = 0;
}

test.describe("工作流设置", () => {
  test.beforeAll(async ({ request }) => {
    await removeAll(request);
  });

  test.afterEach(async ({ request }) => {
    await removeAll(request);
  });

  test("保存整图时校验子集：预载技能 / 可见 Tool 不在工作流集合里 → 400 指名；集合与设置经 PUT 落库，画布只发图不会清空它们", async ({
    request,
  }) => {
    const fx = await createFixture(request);
    const workflowId = await createWorkflow(request, `${PREFIX}子集-${fx.suffix}`);
    const graph = actionGraph(fx);

    // 集合为空时放上预载该技能的 Action：400 指名 Action 与技能
    const missingSkill = await request.put(`/api/workflows/${workflowId}`, { data: graph });
    expect(missingSkill.status()).toBe(400);
    expect(await missingSkill.text()).toContain(
      `Action「${fx.actionName}」预载的技能「${fx.skillName}」不在工作流技能集里`,
    );

    // 技能集补上、Tool 集仍缺：400 指名 Action 与 Tool
    const missingTool = await request.put(`/api/workflows/${workflowId}`, {
      data: { ...graph, skillIds: [fx.skillId] },
    });
    expect(missingTool.status()).toBe(400);
    expect(await missingTool.text()).toContain(
      `Action「${fx.actionName}」可见的 Tool「${fx.toolName}」不在工作流 Tool 集里`,
    );

    // 两个集合都齐：保存成功，响应与 GET 都带回集合、指令与设置
    const instructions = `# ${PREFIX}子集\n\n共同约定 ${fx.suffix}\n`;
    const ok = await request.put(`/api/workflows/${workflowId}`, {
      data: {
        ...graph,
        instructions,
        settings: { toggles: { webSearch: true, todo: false }, mcpServers: ["e2e_mcp"] },
        skillIds: [fx.skillId],
        toolIds: [fx.toolId],
      },
    });
    expect(ok.ok()).toBeTruthy();
    const saved = (await ok.json()) as WorkflowDetail;
    expect(saved.workflow.skillIds).toEqual([fx.skillId]);
    expect(saved.workflow.toolIds).toEqual([fx.toolId]);
    expect(saved.workflow.instructions).toBe(instructions);
    expect(saved.workflow.settings).toEqual({
      toggles: { webSearch: true, todo: false },
      mcpServers: ["e2e_mcp"],
    });
    expect(saved.nodes).toHaveLength(3);

    // 画布式 PUT（只发 nodes/edges）：四个设置字段缺省沿用现值，不会被清空
    const canvasPut = await request.put(`/api/workflows/${workflowId}`, { data: graph });
    expect(canvasPut.ok()).toBeTruthy();
    const after = await getDetail(request, workflowId);
    expect(after.workflow.skillIds).toEqual([fx.skillId]);
    expect(after.workflow.toolIds).toEqual([fx.toolId]);
    expect(after.workflow.instructions).toBe(instructions);
    expect(after.workflow.settings.toggles).toEqual({ webSearch: true, todo: false });
    expect(after.workflow.settings.mcpServers).toEqual(["e2e_mcp"]);

    // 设置的形状校验：未知开关键、非布尔、非法 MCP 名、超长指令
    for (const [label, data] of [
      ["未知开关键", { ...graph, settings: { toggles: { nope: true } } }],
      ["非布尔开关", { ...graph, settings: { toggles: { webSearch: "yes" } } }],
      ["非法 MCP 名", { ...graph, settings: { mcpServers: ["有 空格"] } }],
      ["超长指令", { ...graph, instructions: "x".repeat(64 * 1024 + 1) }],
      ["不存在的技能 id", { ...graph, skillIds: [fx.skillId, randomUUID()] }],
    ] as const) {
      const res = await request.put(`/api/workflows/${workflowId}`, { data });
      expect(res.status(), `${label} 应被 400 拒绝`).toBe(400);
    }

    // 集合还在用时把技能从集合里移走：同样按子集拒绝
    const removeSkill = await request.put(`/api/workflows/${workflowId}`, {
      data: { ...graph, skillIds: [] },
    });
    expect(removeSkill.status()).toBe(400);
  });

  test("设置页：指令、开关三态、技能集 / Tool 集勾选与「被 Action 预载 / 可见」标记；保存往返 API；移出仍被预载的技能会被拒", async ({
    page,
    request,
  }) => {
    const fx = await createFixture(request);
    const workflowId = await createWorkflow(request, `${PREFIX}设置页-${fx.suffix}`);
    const graph = actionGraph(fx);
    const put = await request.put(`/api/workflows/${workflowId}`, {
      data: { ...graph, skillIds: [fx.skillId], toolIds: [fx.toolId] },
    });
    expect(put.ok()).toBeTruthy();
    const globalToggles = (
      (await (await request.get("/api/settings")).json()) as {
        toggles: Record<string, boolean>;
      }
    ).toggles;

    await page.goto(`/workflows/${workflowId}/settings`);
    await expect(page.getByRole("heading", { name: "工作流设置", exact: true })).toBeVisible();
    for (const section of ["工作流指令（AGENTS.md）", "插件开关", "MCP 服务器"]) {
      await expect(page.getByRole("heading", { name: section, exact: true })).toBeVisible();
    }
    await expect(page.getByRole("heading", { name: "技能集（1）", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tool 集（1）", exact: true })).toBeVisible();

    // 五个开关都是三态；「继承」一项显示全局当前值，生效徽章与全局一致
    for (const key of ["webSearch", "fsSearch", "strReplaceEditor", "todo", "compaction"]) {
      const select = page.getByTestId(`toggle-${key}`);
      await expect(select).toHaveValue("inherit");
      await expect(select.locator("option").first()).toHaveText(
        `继承全局（${globalToggles[key] ? "开" : "关"}）`,
      );
    }

    // 集合项按 API 勾选，并标出画布上的 Action 正预载 / 看见它
    const skillRow = page
      .locator("label")
      .filter({ has: page.getByText(fx.skillName, { exact: true }) });
    await expect(skillRow.getByRole("checkbox")).toBeChecked();
    await expect(skillRow.getByText(/≈ \d+ tokens/)).toBeVisible();
    await expect(
      skillRow.getByText(`被 Action「${fx.actionName}」预载，移出后保存会被拒绝`),
    ).toBeVisible();
    const toolRow = page
      .locator("label")
      .filter({ has: page.getByText(fx.toolName, { exact: true }) });
    await expect(toolRow.getByRole("checkbox")).toBeChecked();
    await expect(toolRow.getByText(fx.toolPublicName, { exact: true })).toBeVisible();
    await expect(
      toolRow.getByText(`Action「${fx.actionName}」可见，移出后保存会被拒绝`),
    ).toBeVisible();

    // 改指令、把 webSearch 覆盖为开、todo 覆盖为关；生效徽章跟着变
    const instructions = `# 设置页写入\n\n第 ${fx.suffix} 次验收\n`;
    await page.getByPlaceholder(/写给本工作流全部 Action 的共同约定/).fill(instructions);
    await page.getByTestId("toggle-webSearch").selectOption("on");
    await page.getByTestId("toggle-todo").selectOption("off");
    const webSearchRow = page.locator("tr").filter({ has: page.getByTestId("toggle-webSearch") });
    await expect(webSearchRow.locator("td").last()).toHaveText("开");
    const todoRow = page.locator("tr").filter({ has: page.getByTestId("toggle-todo") });
    await expect(todoRow.locator("td").last()).toHaveText("关");
    await expect(page.getByText("有未保存的改动")).toBeVisible();

    const savePut = page.waitForResponse(
      (r) => r.url().endsWith(`/api/workflows/${workflowId}`) && r.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    expect((await savePut).ok()).toBeTruthy();
    await expect(page.getByText(/^已保存/)).toBeVisible();

    const detail = await getDetail(request, workflowId);
    expect(detail.workflow.instructions).toBe(instructions);
    expect(detail.workflow.settings.toggles).toEqual({ webSearch: true, todo: false });
    expect(detail.workflow.skillIds).toEqual([fx.skillId]);
    expect(detail.workflow.toolIds).toEqual([fx.toolId]);
    // 设置页只 PUT 设置与集合、不发图：服务端沿用库里当前的图，画布上的节点原样保留
    expect(detail.nodes).toHaveLength(3);

    // 取消勾选仍被 Action 预载的技能再保存：服务端按子集拒绝，页面显示指名文案
    await skillRow.getByRole("checkbox").uncheck();
    await expect(page.getByRole("heading", { name: "技能集（0）", exact: true })).toBeVisible();
    const rejected = page.waitForResponse(
      (r) => r.url().endsWith(`/api/workflows/${workflowId}`) && r.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    expect((await rejected).status()).toBe(400);
    await expect(
      page.getByText(`Action「${fx.actionName}」预载的技能「${fx.skillName}」不在工作流技能集里`),
    ).toBeVisible();
    const unchanged = await getDetail(request, workflowId);
    expect(unchanged.workflow.skillIds).toEqual([fx.skillId]);
  });

  test("入口与画布检查器：列表卡片「设置」、画布顶栏「工作流设置」、检查器候选收窄到工作流集合", async ({
    page,
    request,
  }) => {
    const fx = await createFixture(request);
    const workflowName = `${PREFIX}入口-${fx.suffix}`;
    const workflowId = await createWorkflow(request, workflowName);
    const graph = actionGraph(fx);
    expect(
      (
        await request.put(`/api/workflows/${workflowId}`, {
          data: { ...graph, skillIds: [fx.skillId], toolIds: [fx.toolId] },
        })
      ).ok(),
    ).toBeTruthy();

    // 列表卡片的「设置」按钮
    await page.goto("/workflows");
    // 工作流卡片是可点击的 div（点整卡进画布），不是 li
    const card = page
      .locator("div.cursor-pointer.rounded-lg")
      .filter({ has: page.getByRole("heading", { name: workflowName, exact: true }) });
    await expect(card).toHaveCount(1);
    await card.getByRole("button", { name: "设置", exact: true }).click();
    await page.waitForURL(new RegExp(`/workflows/${workflowId}/settings$`));
    await expect(page.getByRole("heading", { name: "工作流设置", exact: true })).toBeVisible();

    // 画布顶栏链接
    await page.goto(`/workflows/${workflowId}`);
    await expect(page.locator(".react-flow__node")).toHaveCount(3, { timeout: 20_000 });
    const link = page.getByRole("link", { name: "工作流设置", exact: true });
    await expect(link).toHaveAttribute("href", `/workflows/${workflowId}/settings`);

    // 双击 Action 节点打开检查器：候选只列工作流集合里的项目，提示条报集合大小
    const node = page.locator(".react-flow__node").filter({ hasText: fx.actionName });
    await expect(node).toHaveCount(1);
    await node.dblclick();
    await expect(page.getByRole("heading", { name: "编辑 Action", exact: true })).toBeVisible();
    const hint = page.getByTestId("inspector-candidate-hint");
    await expect(hint).toContainText("技能集（1）");
    await expect(hint).toContainText("Tool 集（1）");
    const preloadRow = page
      .locator("label")
      .filter({ has: page.getByText(fx.skillName, { exact: true }) });
    await expect(preloadRow.getByRole("checkbox")).toBeChecked();
    const toolRow = page
      .locator("label")
      .filter({ has: page.getByText(fx.toolName, { exact: true }) });
    await expect(toolRow.getByRole("checkbox")).toBeChecked();
    // 种子技能不在这个工作流的技能集里，画布侧的候选看不到它
    await expect(page.getByText("集采计划编制规范", { exact: true })).toHaveCount(0);
  });

  test("受理时冻结三层设置：直通工作流的运行带 settingsSnapshot，运行详情显示「设置快照」", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const fx = await createFixture(request);
    const workflowId = await createWorkflow(request, `${PREFIX}快照-${fx.suffix}`);
    const inputNodeId = randomUUID();
    const outputNodeId = randomUUID();
    // 输入直通输出：无 Action、零费用，但受理仍走完整引擎（含技能投影与 Tool 物化）
    const put = await request.put(`/api/workflows/${workflowId}`, {
      data: {
        nodes: [
          {
            id: inputNodeId,
            kind: "input",
            actionId: null,
            objectTypeId: fx.objectTypeId,
            label: "输入",
            x: 0,
            y: 0,
          },
          {
            id: outputNodeId,
            kind: "output",
            actionId: null,
            objectTypeId: fx.objectTypeId,
            label: "输出",
            x: 240,
            y: 0,
          },
        ],
        edges: [
          {
            id: randomUUID(),
            sourceNodeId: inputNodeId,
            sourcePort: "value",
            targetNodeId: outputNodeId,
            targetPort: "value",
          },
        ],
        instructions: `# 快照验收 ${fx.suffix}\n`,
        settings: { toggles: { todo: false }, mcpServers: [] },
        skillIds: [fx.skillId],
        toolIds: [fx.toolId],
      },
    });
    expect(put.ok()).toBeTruthy();
    const global = (await (await request.get("/api/settings")).json()) as {
      toggles: Record<string, boolean>;
      disabledTools: string[];
    };

    const start = await request.post(`/api/workflows/${workflowId}/run`, {
      data: { inputs: { [inputNodeId]: { kind: "text", text: "快照验收" } } },
    });
    expect(start.status()).toBe(200);
    const runId = ((await start.json()) as { runId: string }).runId;

    interface RunDetail {
      run: {
        status: string;
        error: string | null;
        settingsSnapshot: {
          global: { toggles: Record<string, boolean>; disabledTools: string[] };
          workflow: {
            settings: { toggles: Record<string, boolean>; mcpServers: string[] };
            skills: Array<{ id: string; name: string; slug: string }>;
            tools: Array<{ id: string; name: string; publicName: string }>;
          };
          effective: { toggles: Record<string, boolean>; mcpServers: string[] };
        } | null;
      };
    }
    let detail: RunDetail | null = null;
    const deadline = Date.now() + 90_000;
    while (!detail) {
      expect(Date.now(), "等待运行收束超时").toBeLessThan(deadline);
      const res = await request.get(`/api/runs/${runId}`);
      expect(res.ok()).toBeTruthy();
      const body = (await res.json()) as RunDetail;
      if (body.run.status !== "running") detail = body;
      else await new Promise((r) => setTimeout(r, 200));
    }
    expect(detail.run.error).toBeNull();
    expect(detail.run.status).toBe("success");

    // 快照与受理时的三层一致：全局开关、工作流覆盖、合成后的生效值，技能集与 Tool 集全量
    const snap = detail.run.settingsSnapshot;
    expect(snap).toBeTruthy();
    expect(snap!.global.toggles).toEqual(global.toggles);
    expect(snap!.global.disabledTools).toEqual(global.disabledTools);
    expect(snap!.workflow.settings.toggles).toEqual({ todo: false });
    expect(snap!.effective.toggles).toEqual({ ...global.toggles, todo: false });
    expect(snap!.workflow.skills.map((s) => s.id)).toEqual([fx.skillId]);
    expect(snap!.workflow.skills[0].name).toBe(fx.skillName);
    expect(snap!.workflow.tools.map((t) => t.publicName)).toEqual([fx.toolPublicName]);

    // 运行详情的「设置快照」折叠区：摘要与展开后的来源说明都读这份快照
    await page.goto(`/runs/${runId}`);
    const toggleButton = page.getByRole("button", { name: /设置快照/ });
    await expect(toggleButton).toBeVisible();
    const effectiveCount = Object.values(snap!.effective.toggles).filter(Boolean).length;
    await expect(toggleButton).toContainText(
      `生效 ${effectiveCount}/5 项开关 · MCP 0 · 技能集 1 · Tool 集 1`,
    );
    await toggleButton.click();
    await expect(page.getByText("工作流覆盖为关")).toBeVisible();
    // 徽章是「名 + slug / 公名」同一个 span，按子串找
    await expect(page.getByText(fx.skillName)).toBeVisible();
    await expect(page.getByText(fx.toolPublicName)).toBeVisible();

    expect((await request.delete(`/api/runs/${runId}`)).ok()).toBeTruthy();
  });
});
