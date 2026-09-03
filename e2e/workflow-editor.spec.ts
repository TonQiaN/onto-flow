import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  cleanupByPrefix,
  cleanupRevisions,
  createAction,
  createObjectType,
  createWorkflow,
  createWorkflowGraph,
  finishSyntheticRuns,
  inputPort,
  insertSyntheticRun,
  linearRunGraph,
  outputPort,
  type RevisionOwner,
  uniqueSuffix,
} from "./helpers";

/**
 * 工作流画布。`db:seed` 只种平台基线，所以每个用例先经 API 自建 `e2e-` 前缀的
 * 对象类型 / Action / 工作流与整张图，再打开画布断言；节点数与连线数是本用例
 * 自己造出来的事实，可以直接断言。收尾经 cleanupByPrefix + cleanupRevisions。
 */
const PREFIX = "e2e-画布-";
const uploadedDirs = new Set<string>();

test.describe("工作流画布", () => {
  const owners: RevisionOwner[] = [];

  test.afterEach(async ({ request }) => {
    await cleanupByPrefix(request, "/api/workflows", PREFIX);
    await cleanupByPrefix(request, "/api/actions", PREFIX);
    await cleanupByPrefix(request, "/api/object-types", PREFIX);
    cleanupRevisions(owners);
    owners.length = 0;
    for (const dir of uploadedDirs) fs.rmSync(dir, { recursive: true, force: true });
    uploadedDirs.clear();
  });

  test("打开自建工作流：节点数与连线数与建图时一致，保存成功且无校验问题", async ({
    page,
    request,
  }) => {
    const suffix = uniqueSuffix();
    const objectTypeId = await createObjectType(
      request,
      { name: `${PREFIX}资料-${suffix}` },
      owners,
    );
    // 第二个 Action 走具名出口，画布上那条线会带出口名标签
    const firstName = `${PREFIX}起草-${suffix}`;
    const secondName = `${PREFIX}定稿-${suffix}`;
    const firstId = await createAction(
      request,
      {
        name: firstName,
        ports: [inputPort("素材", objectTypeId), outputPort("草稿", objectTypeId, "draft.md")],
      },
      owners,
    );
    const secondId = await createAction(
      request,
      {
        name: secondName,
        ports: [
          inputPort("草稿", objectTypeId),
          outputPort("成品", objectTypeId, "final.md", 0, "通过"),
        ],
      },
      owners,
    );

    // 输入 → 起草 → 定稿 → 输出：4 节点 3 连线
    const graph = await createWorkflowGraph(
      request,
      {
        name: `${PREFIX}线性-${suffix}`,
        objectTypeId,
        steps: [
          { actionId: firstId, label: firstName, inputPort: "素材", outputPort: "草稿" },
          { actionId: secondId, label: secondName, inputPort: "草稿", outputPort: "成品" },
        ],
      },
      owners,
    );
    expect(graph.nodes).toHaveLength(4);
    expect(graph.edges).toHaveLength(3);

    // 列表按本 spec 的前缀收窄，不依赖自建工作流恰好落在第一页
    const workflowName = `${PREFIX}线性-${suffix}`;
    await page.goto(`/workflows?q=${encodeURIComponent(workflowName)}`);
    await page.getByRole("heading", { name: workflowName, exact: true }).click();
    await page.waitForURL(new RegExp(`/workflows/${graph.workflowId}$`));

    // 画布加载完成：数目就是刚才建图时的数目
    await expect(page.locator(".react-flow__node")).toHaveCount(graph.nodes.length, {
      timeout: 20_000,
    });
    await expect(page.locator(".react-flow__edge")).toHaveCount(graph.edges.length);
    // 具名出口的那条线带出口名标签
    await expect(page.locator('[data-testid^="workflow-edge-exit-"]')).toHaveCount(1);
    await expect(page.getByTestId(`workflow-edge-exit-${graph.edgeIds[2]}`)).toHaveText("通过");

    // 保存：PUT 整图成功（不点「运行」）
    const putResponse = page.waitForResponse(
      (res) => res.request().method() === "PUT" && /\/api\/workflows\//.test(res.url()),
    );
    await page.getByRole("button", { name: "保存", exact: true }).click();
    const res = await putResponse;
    expect(res.ok()).toBeTruthy();
    expect(((await res.json()) as { issues: unknown[] }).issues).toEqual([]);

    // 保存按钮恢复可用，无错误横幅、无校验问题横幅
    await expect(page.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
    await expect(page.getByText("保存失败")).toBeHidden();
    await expect(page.getByText(/校验问题（\d+）/)).toBeHidden();

    // 图形未被改动：节点与连线数量不变
    await expect(page.locator(".react-flow__node")).toHaveCount(graph.nodes.length);
    await expect(page.locator(".react-flow__edge")).toHaveCount(graph.edges.length);
  });

  test("具名出口把情况名显示在对应连线上，修订回滚与保存重载都会同步", async ({
    page,
    request,
  }) => {
    const suffix = uniqueSuffix();
    const draftName = `${PREFIX}起草-${suffix}`;
    const decisionName = `${PREFIX}裁决-${suffix}`;
    const workflowName = `${PREFIX}分支工作流-${suffix}`;

    const objectTypeId = await createObjectType(
      request,
      { name: `${PREFIX}分支类型-${suffix}`, kind: "file", description: "E2E 分支标签类型" },
      owners,
    );

    const draftId = await createAction(
      request,
      {
        name: draftName,
        description: "普通出口与回边目标",
        prompt: "起草",
        maxReentries: 1,
        ports: [
          inputPort("需求", objectTypeId, 0),
          inputPort("意见", objectTypeId, 1),
          outputPort("草稿", objectTypeId, "draft.md"),
        ],
      },
      owners,
    );

    const decisionId = await createAction(
      request,
      {
        name: decisionName,
        description: "通过出口扇出，打回出口形成回边",
        prompt: "裁决",
        ports: [
          inputPort("草稿", objectTypeId),
          outputPort("成品", objectTypeId, "final.md", 0, "通过"),
          outputPort("意见", objectTypeId, "feedback.md", 1, "打回"),
        ],
      },
      owners,
    );

    const workflowId = await createWorkflow(
      request,
      { name: workflowName, description: "E2E 具名出口连线标签" },
      owners,
    );

    const inputId = randomUUID();
    const draftNodeId = randomUUID();
    const decisionNodeId = randomUUID();
    const outputAId = randomUUID();
    const outputBId = randomUUID();
    const inputEdgeId = randomUUID();
    const draftEdgeId = randomUUID();
    const passAEdgeId = randomUUID();
    const passBEdgeId = randomUUID();
    const rejectEdgeId = randomUUID();

    const graphResponse = await request.put(`/api/workflows/${workflowId}`, {
      data: {
        nodes: [
          {
            id: inputId,
            kind: "input",
            actionId: null,
            objectTypeId,
            label: "需求",
            x: 0,
            y: 160,
          },
          {
            id: draftNodeId,
            kind: "action",
            actionId: draftId,
            objectTypeId: null,
            label: draftName,
            x: 320,
            y: 160,
          },
          {
            id: decisionNodeId,
            kind: "action",
            actionId: decisionId,
            objectTypeId: null,
            label: decisionName,
            x: 680,
            y: 160,
          },
          {
            id: outputAId,
            kind: "output",
            actionId: null,
            objectTypeId,
            label: "产出 A",
            x: 1040,
            y: 40,
          },
          {
            id: outputBId,
            kind: "output",
            actionId: null,
            objectTypeId,
            label: "产出 B",
            x: 1040,
            y: 280,
          },
        ],
        edges: [
          {
            id: inputEdgeId,
            sourceNodeId: inputId,
            sourcePort: "value",
            targetNodeId: draftNodeId,
            targetPort: "需求",
          },
          {
            id: draftEdgeId,
            sourceNodeId: draftNodeId,
            sourcePort: "草稿",
            targetNodeId: decisionNodeId,
            targetPort: "草稿",
          },
          {
            id: passAEdgeId,
            sourceNodeId: decisionNodeId,
            sourcePort: "成品",
            targetNodeId: outputAId,
            targetPort: "value",
          },
          {
            id: passBEdgeId,
            sourceNodeId: decisionNodeId,
            sourcePort: "成品",
            targetNodeId: outputBId,
            targetPort: "value",
          },
          {
            id: rejectEdgeId,
            sourceNodeId: decisionNodeId,
            sourcePort: "意见",
            targetNodeId: draftNodeId,
            targetPort: "意见",
          },
        ],
      },
    });
    expect(graphResponse.ok()).toBeTruthy();
    const graph = (await graphResponse.json()) as { issues: unknown[] };
    expect(graph.issues).toEqual([]);

    // 给裁决 Action 留下 v2：页面先看到「放行」，随后在同页回滚 v1，验证画布即时同步。
    const decisionDetailResponse = await request.get(`/api/actions/${decisionId}`);
    expect(decisionDetailResponse.ok()).toBeTruthy();
    const decisionDetail = (await decisionDetailResponse.json()) as {
      name: string;
      description: string;
      prompt: string;
      rule: string;
      modelId: string;
      reasoningEffort: string;
      maxReentries: number;
      onExhausted: string;
      ports: Array<{
        direction: "input" | "output";
        name: string;
        objectTypeId: string;
        position: number;
        artifactPath: string | null;
        exitName: string | null;
      }>;
      preloadSkillIds: string[];
      toolIds: string[];
    };
    const decisionV2Response = await request.put(`/api/actions/${decisionId}`, {
      data: {
        name: decisionDetail.name,
        description: decisionDetail.description,
        prompt: decisionDetail.prompt,
        rule: decisionDetail.rule,
        modelId: decisionDetail.modelId,
        reasoningEffort: decisionDetail.reasoningEffort,
        maxReentries: decisionDetail.maxReentries,
        onExhausted: decisionDetail.onExhausted,
        ports: decisionDetail.ports.map((port) => ({
          direction: port.direction,
          name: port.name,
          objectTypeId: port.objectTypeId,
          position: port.position,
          artifactPath: port.artifactPath,
          exitName: port.name === "成品" ? "放行" : port.exitName,
        })),
        preloadSkillIds: decisionDetail.preloadSkillIds,
        toolIds: decisionDetail.toolIds,
      },
    });
    expect(decisionV2Response.ok()).toBeTruthy();

    const edgeLabel = (targetPage: Page, edgeId: string) =>
      targetPage.getByTestId(`workflow-edge-exit-${edgeId}`);
    const expectLabels = async (passName: "通过" | "放行") => {
      await expect(page.locator('[data-testid^="workflow-edge-exit-"]')).toHaveCount(3);
      await expect(edgeLabel(page, inputEdgeId)).toHaveCount(0);
      await expect(edgeLabel(page, draftEdgeId)).toHaveCount(0);
      await expect(edgeLabel(page, passAEdgeId)).toHaveText(passName);
      await expect(edgeLabel(page, passBEdgeId)).toHaveText(passName);
      await expect(edgeLabel(page, rejectEdgeId)).toHaveText("打回");
    };

    await page.goto(`/workflows/${workflowId}`);
    await expect(page.locator(".react-flow__node")).toHaveCount(5);
    await expect(page.locator(".react-flow__edge")).toHaveCount(5);
    await expectLabels("放行");

    const decisionNode = page.locator(".react-flow__node").filter({ hasText: decisionName });
    await expect(decisionNode).toHaveCount(1);
    await decisionNode.dblclick();
    await expect(page.getByRole("heading", { name: "编辑 Action", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "修订历史", exact: true }).click();
    const revisions = page.locator("section").filter({
      has: page.getByRole("heading", { name: "修订历史", exact: true }),
    });
    // 本用例给这个自建 Action 恰好写了两版（建库 v1 + 改出口名 v2）
    await expect(revisions.getByText("共 2 版", { exact: true })).toBeVisible();
    const v1 = revisions.locator("li").filter({
      has: page.getByText("v1", { exact: true }),
    });
    await v1.getByRole("button", { name: "回滚", exact: true }).click();
    const restoreResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/revisions\/[^/]+\/restore$/.test(response.url()),
    );
    await v1.getByRole("button", { name: "确认回滚", exact: true }).click();
    expect((await restoreResponse).ok()).toBeTruthy();
    await expectLabels("通过");
    await page.getByRole("button", { name: "关闭", exact: true }).first().click();

    const putResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith(`/api/workflows/${workflowId}`),
    );
    await page.getByRole("button", { name: "保存", exact: true }).click();
    const savedResponse = await putResponse;
    expect(savedResponse.ok()).toBeTruthy();
    const saved = (await savedResponse.json()) as { issues: unknown[] };
    expect(saved.issues).toEqual([]);
    await page.reload();
    await expect(page.locator(".react-flow__edge")).toHaveCount(5);
    await expectLabels("通过");
  });

  test("文件输入可上传，取消对话框不会发起运行", async ({ page, request }) => {
    const suffix = uniqueSuffix();
    const objectTypeId = await createObjectType(
      request,
      { name: `${PREFIX}类型-${suffix}`, kind: "file", description: "E2E PDF 输入" },
      owners,
    );
    // 输入直通输出：无 Action、零费用（本用例连运行都不发起）
    const graph = await createWorkflowGraph(
      request,
      {
        name: `${PREFIX}上传-${suffix}`,
        description: "E2E PDF 上传对话框",
        objectTypeId,
        inputLabel: "简历",
      },
      owners,
    );

    let runRequests = 0;
    await page.route(`**/api/workflows/${graph.workflowId}/run`, async (route) => {
      runRequests += 1;
      await route.fulfill({ status: 500, body: "不应发起运行" });
    });

    await page.goto(`/workflows/${graph.workflowId}`);
    await expect(page.locator(".react-flow__node")).toHaveCount(graph.nodes.length);
    await page.getByRole("button", { name: "运行", exact: true }).click();

    const fileInput = page.getByLabel("简历文件");
    const uploadResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/uploads") && response.request().method() === "POST",
    );
    await fileInput.setInputFiles({
      name: "e2e-resume.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7\n% no PII E2E fixture\n"),
    });
    const uploaded = await uploadResponse;
    expect(uploaded.ok()).toBeTruthy();
    const uploadValue = (await uploaded.json()) as { file: { path: string } };
    const absoluteUpload = path.resolve(process.cwd(), "data", uploadValue.file.path);
    const uploadsRoot = path.resolve(process.cwd(), "data", "uploads");
    expect(path.relative(uploadsRoot, absoluteUpload)).not.toMatch(/^\.\.|^\//);
    uploadedDirs.add(path.dirname(absoluteUpload));
    await expect(page.getByText("已上传：e2e-resume.pdf")).toBeVisible();

    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.getByRole("heading", { name: "运行工作流" })).toBeHidden();
    expect(runRequests).toBe(0);
  });

  test("编辑器只编排与发起：画布上没有运行条、切换器，也不再认 ?runId= 深链", async ({
    page,
    request,
  }) => {
    const suffix = uniqueSuffix();
    const objectTypeId = await createObjectType(
      request,
      { name: `${PREFIX}类型-${suffix}` },
      owners,
    );
    // 输入直通输出：无 Action、零费用；这里连运行都不发起，只合成一条「进行中」的 DB 行
    const workflowName = `${PREFIX}不跟随-${suffix}`;
    const graph = await createWorkflowGraph(
      request,
      { name: workflowName, description: "编辑器不再跟随运行（ADR-0018）", objectTypeId },
      owners,
    );
    const { inputNodeId, outputNodeId } = graph;
    const runId = insertSyntheticRun({
      workflowId: graph.workflowId,
      workflowName,
      status: "running",
      graph: linearRunGraph({ inputNodeId, outputNodeId, objectTypeId }),
      nodes: [
        { nodeId: inputNodeId, label: "输入" },
        { nodeId: outputNodeId, label: "输出" },
      ],
    });

    try {
      await page.goto(`/workflows/${graph.workflowId}`);
      await expect(page.locator(".react-flow__node")).toHaveCount(graph.nodes.length);

      // 这条运行确实在跑（导航面板列出了它），画布上仍然没有任何跟随运行的东西：
      // 运行条、并行切换器、取消与「再次运行」都属于运行页，`run-*` 元素一个都不该出现
      await expect(
        page.getByTestId("nav-running-run").filter({ hasText: runId.slice(0, 8) }),
      ).toHaveCount(1, { timeout: 15_000 });
      await expect(page.locator('[data-testid^="run-"]')).toHaveCount(0);
      await expect(page.getByRole("button", { name: "取消运行" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "再次运行" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "运行", exact: true })).toBeVisible();

      // 旧的 ?runId= 深链不再被解析：URL 原样留着，画布什么也不跟随
      await page.goto(`/workflows/${graph.workflowId}?runId=${runId}`);
      await expect(page.locator(".react-flow__node")).toHaveCount(graph.nodes.length);
      await expect(page.locator('[data-testid^="run-"]')).toHaveCount(0);
      await expect(page.getByRole("button", { name: "取消运行" })).toHaveCount(0);
    } finally {
      finishSyntheticRuns([runId]);
      const del = await request.delete(`/api/runs/${runId}`);
      expect(del.ok(), `删除运行 ${runId}`).toBeTruthy();
    }
  });
});
