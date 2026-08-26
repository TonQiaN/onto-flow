import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { cleanupByPrefix } from "./helpers";

const PREFIX = "e2e-PDF输入-";
const uploadedDirs = new Set<string>();
type RevisionOwnerKind = "workflow" | "action" | "object_type";
const revisionOwners = new Map<
  string,
  { kind: RevisionOwnerKind; id: string }
>();

function trackRevisionOwner(kind: RevisionOwnerKind, id: string): void {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`测试实体 id 不安全：${id}`);
  revisionOwners.set(`${kind}:${id}`, { kind, id });
}

/** revisions 是多态引用、没有 FK；实体 API 删除后按本用例创建的精确 id 清掉历史。 */
function cleanupTrackedRevisions(): void {
  if (revisionOwners.size === 0) return;
  const database = new Database(
    path.join(process.cwd(), "data", "ontoflow.db"),
  );
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  try {
    const remove = database.prepare(
      "delete from revisions where entity_kind = ? and entity_id = ?",
    );
    database.transaction(
      (owners: Array<{ kind: RevisionOwnerKind; id: string }>) => {
        for (const owner of owners) remove.run(owner.kind, owner.id);
      },
    )([...revisionOwners.values()]);
    const remaining = database.prepare(
      "select count(*) as total from revisions where entity_kind = ? and entity_id = ?",
    );
    for (const owner of revisionOwners.values()) {
      const row = remaining.get(owner.kind, owner.id) as { total: number };
      expect(row.total).toBe(0);
    }
  } finally {
    database.close();
    revisionOwners.clear();
  }
}

test.describe("工作流画布", () => {
  test.afterEach(async ({ request }) => {
    await cleanupByPrefix(request, "/api/workflows", PREFIX);
    await cleanupByPrefix(request, "/api/actions", PREFIX);
    await cleanupByPrefix(request, "/api/object-types", PREFIX);
    cleanupTrackedRevisions();
    for (const dir of uploadedDirs) fs.rmSync(dir, { recursive: true, force: true });
    uploadedDirs.clear();
  });

  test("打开「采购集采计划生成」：7 节点 7 连线，保存成功且无校验问题", async ({
    page,
  }) => {
    await page.goto("/workflows");
    await page
      .getByRole("heading", { name: "采购集采计划生成", exact: true })
      .click();
    await page.waitForURL(/\/workflows\/[0-9a-f-]{36}/);

    // 画布加载完成：7 节点 / 7 连线
    await expect(page.locator(".react-flow__node")).toHaveCount(7, {
      timeout: 20_000,
    });
    await expect(page.locator(".react-flow__edge")).toHaveCount(7);

    // 保存：PUT 整图成功（不点「运行」）
    const putResponse = page.waitForResponse(
      (res) =>
        res.request().method() === "PUT" &&
        /\/api\/workflows\//.test(res.url()),
    );
    await page.getByRole("button", { name: "保存", exact: true }).click();
    const res = await putResponse;
    expect(res.ok()).toBeTruthy();

    // 保存按钮恢复可用，无错误横幅、无校验问题横幅
    await expect(
      page.getByRole("button", { name: "保存", exact: true }),
    ).toBeEnabled();
    await expect(page.getByText("保存失败")).toBeHidden();
    await expect(page.getByText(/校验问题（\d+）/)).toBeHidden();

    // 图形未被改动：节点与连线数量不变
    await expect(page.locator(".react-flow__node")).toHaveCount(7);
    await expect(page.locator(".react-flow__edge")).toHaveCount(7);
  });

  test("具名出口把情况名显示在对应连线上，修订回滚与保存重载都会同步", async ({
    page,
    request,
  }) => {
    const suffix = Date.now();
    const typeName = `${PREFIX}分支类型-${suffix}`;
    const workflowName = `${PREFIX}分支工作流-${suffix}`;

    const modelResponse = await request.get("/api/models");
    expect(modelResponse.ok()).toBeTruthy();
    const model = ((await modelResponse.json()) as Array<{ id: string }>)[0];
    expect(model).toBeDefined();

    const typeResponse = await request.post("/api/object-types", {
      data: {
        name: typeName,
        kind: "file",
        description: "E2E 分支标签类型",
        jsonSchema: null,
        filePreprocessor: null,
      },
    });
    expect(typeResponse.ok()).toBeTruthy();
    const objectType = (await typeResponse.json()) as { id: string };
    trackRevisionOwner("object_type", objectType.id);

    const draftResponse = await request.post("/api/actions", {
      data: {
        name: `${PREFIX}起草-${suffix}`,
        description: "普通出口与回边目标",
        prompt: "起草",
        rule: "",
        modelId: model!.id,
        reasoningEffort: "low",
        maxReentries: 1,
        onExhausted: "fail",
        ports: [
          {
            direction: "input",
            name: "需求",
            objectTypeId: objectType.id,
            position: 0,
            artifactPath: null,
            exitName: null,
          },
          {
            direction: "input",
            name: "意见",
            objectTypeId: objectType.id,
            position: 1,
            artifactPath: null,
            exitName: null,
          },
          {
            direction: "output",
            name: "草稿",
            objectTypeId: objectType.id,
            position: 0,
            artifactPath: "draft.md",
            exitName: null,
          },
        ],
        skillIds: [],
        toolIds: [],
      },
    });
    expect(draftResponse.ok()).toBeTruthy();
    const draft = (await draftResponse.json()) as { id: string };
    trackRevisionOwner("action", draft.id);

    const decisionResponse = await request.post("/api/actions", {
      data: {
        name: `${PREFIX}裁决-${suffix}`,
        description: "通过出口扇出，打回出口形成回边",
        prompt: "裁决",
        rule: "",
        modelId: model!.id,
        reasoningEffort: "low",
        maxReentries: 0,
        onExhausted: "fail",
        ports: [
          {
            direction: "input",
            name: "草稿",
            objectTypeId: objectType.id,
            position: 0,
            artifactPath: null,
            exitName: null,
          },
          {
            direction: "output",
            name: "成品",
            objectTypeId: objectType.id,
            position: 0,
            artifactPath: "final.md",
            exitName: "通过",
          },
          {
            direction: "output",
            name: "意见",
            objectTypeId: objectType.id,
            position: 1,
            artifactPath: "feedback.md",
            exitName: "打回",
          },
        ],
        skillIds: [],
        toolIds: [],
      },
    });
    expect(decisionResponse.ok()).toBeTruthy();
    const decision = (await decisionResponse.json()) as { id: string };
    trackRevisionOwner("action", decision.id);

    const workflowResponse = await request.post("/api/workflows", {
      data: { name: workflowName, description: "E2E 具名出口连线标签" },
    });
    expect(workflowResponse.ok()).toBeTruthy();
    const workflow = (await workflowResponse.json()) as { id: string };
    trackRevisionOwner("workflow", workflow.id);

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

    const graphResponse = await request.put(`/api/workflows/${workflow.id}`, {
      data: {
        nodes: [
          {
            id: inputId,
            kind: "input",
            actionId: null,
            objectTypeId: objectType.id,
            label: "需求",
            x: 0,
            y: 160,
          },
          {
            id: draftNodeId,
            kind: "action",
            actionId: draft.id,
            objectTypeId: null,
            label: `${PREFIX}起草-${suffix}`,
            x: 320,
            y: 160,
          },
          {
            id: decisionNodeId,
            kind: "action",
            actionId: decision.id,
            objectTypeId: null,
            label: `${PREFIX}裁决-${suffix}`,
            x: 680,
            y: 160,
          },
          {
            id: outputAId,
            kind: "output",
            actionId: null,
            objectTypeId: objectType.id,
            label: "产出 A",
            x: 1040,
            y: 40,
          },
          {
            id: outputBId,
            kind: "output",
            actionId: null,
            objectTypeId: objectType.id,
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
    const decisionDetailResponse = await request.get(
      `/api/actions/${decision.id}`,
    );
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
      skillIds: string[];
      toolIds: string[];
    };
    const decisionV2Response = await request.put(
      `/api/actions/${decision.id}`,
      {
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
          skillIds: decisionDetail.skillIds,
          toolIds: decisionDetail.toolIds,
        },
      },
    );
    expect(decisionV2Response.ok()).toBeTruthy();

    const edgeLabel = (targetPage: Page, edgeId: string) =>
      targetPage.getByTestId(`workflow-edge-exit-${edgeId}`);
    const expectLabels = async (passName: "通过" | "放行") => {
      await expect(
        page.locator('[data-testid^="workflow-edge-exit-"]'),
      ).toHaveCount(3);
      await expect(edgeLabel(page, inputEdgeId)).toHaveCount(0);
      await expect(edgeLabel(page, draftEdgeId)).toHaveCount(0);
      await expect(edgeLabel(page, passAEdgeId)).toHaveText(passName);
      await expect(edgeLabel(page, passBEdgeId)).toHaveText(passName);
      await expect(edgeLabel(page, rejectEdgeId)).toHaveText("打回");
    };

    await page.goto(`/workflows/${workflow.id}`);
    await expect(page.locator(".react-flow__node")).toHaveCount(5);
    await expect(page.locator(".react-flow__edge")).toHaveCount(5);
    await expectLabels("放行");

    const decisionNode = page.locator(".react-flow__node").filter({
      hasText: `${PREFIX}裁决-${suffix}`,
    });
    await expect(decisionNode).toHaveCount(1);
    await decisionNode.dblclick();
    await expect(
      page.getByRole("heading", { name: "编辑 Action", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "修订历史", exact: true }).click();
    const revisions = page.locator("section").filter({
      has: page.getByRole("heading", { name: "修订历史", exact: true }),
    });
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
    await page
      .getByRole("button", { name: "关闭", exact: true })
      .first()
      .click();

    const putResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith(`/api/workflows/${workflow.id}`),
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

  test("PDF 预处理输入可上传，取消对话框不会发起运行", async ({
    page,
    request,
  }) => {
    const suffix = Date.now();
    const typeName = `${PREFIX}类型-${suffix}`;
    const workflowName = `${PREFIX}工作流-${suffix}`;
    const typeResponse = await request.post("/api/object-types", {
      data: {
        name: typeName,
        kind: "file",
        description: "E2E PDF 输入",
        jsonSchema: null,
        filePreprocessor: "pdf",
      },
    });
    expect(typeResponse.ok()).toBeTruthy();
    const objectType = (await typeResponse.json()) as { id: string };
    trackRevisionOwner("object_type", objectType.id);

    const workflowResponse = await request.post("/api/workflows", {
      data: { name: workflowName, description: "E2E PDF 上传对话框" },
    });
    expect(workflowResponse.ok()).toBeTruthy();
    const workflow = (await workflowResponse.json()) as { id: string };
    trackRevisionOwner("workflow", workflow.id);
    const inputId = randomUUID();
    const outputId = randomUUID();
    const graphResponse = await request.put(`/api/workflows/${workflow.id}`, {
      data: {
        nodes: [
          {
            id: inputId,
            kind: "input",
            actionId: null,
            objectTypeId: objectType.id,
            label: "简历",
            x: 0,
            y: 0,
          },
          {
            id: outputId,
            kind: "output",
            actionId: null,
            objectTypeId: objectType.id,
            label: "输出",
            x: 400,
            y: 0,
          },
        ],
        edges: [
          {
            id: randomUUID(),
            sourceNodeId: inputId,
            sourcePort: "value",
            targetNodeId: outputId,
            targetPort: "value",
          },
        ],
      },
    });
    expect(graphResponse.ok()).toBeTruthy();

    let runRequests = 0;
    await page.route(`**/api/workflows/${workflow.id}/run`, async (route) => {
      runRequests += 1;
      await route.fulfill({ status: 500, body: "不应发起运行" });
    });

    await page.goto(`/workflows/${workflow.id}`);
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await page.getByRole("button", { name: "运行", exact: true }).click();

    const fileInput = page.getByLabel("简历文件");
    await expect(fileInput).toHaveAttribute("accept", /application\/pdf/);
    const uploadResponse = page.waitForResponse(
      (response) => response.url().endsWith("/api/uploads") && response.request().method() === "POST",
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
    await expect(page.getByText(/PDF 会抽取文本层并逐页交给多模态模型核对/)).toBeVisible();

    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.getByRole("heading", { name: "运行工作流" })).toBeHidden();
    expect(runRequests).toBe(0);
  });
});
