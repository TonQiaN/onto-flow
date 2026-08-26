import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cleanupByPrefix } from "./helpers";

const PREFIX = "e2e-PDF输入-";
const uploadedDirs = new Set<string>();

test.describe("工作流画布", () => {
  test.afterEach(async ({ request }) => {
    await cleanupByPrefix(request, "/api/workflows", PREFIX);
    await cleanupByPrefix(request, "/api/object-types", PREFIX);
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

    const workflowResponse = await request.post("/api/workflows", {
      data: { name: workflowName, description: "E2E PDF 上传对话框" },
    });
    expect(workflowResponse.ok()).toBeTruthy();
    const workflow = (await workflowResponse.json()) as { id: string };
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
