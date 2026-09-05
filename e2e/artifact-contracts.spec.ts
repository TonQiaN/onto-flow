import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  DATA_DIR,
  cleanupByPrefix,
  cleanupRevisions,
  createWorkflow,
  insertSyntheticRun,
  type RevisionOwner,
} from "./helpers";

const PREFIX = "e2e-产物契约-";
const SCHEMA = JSON.stringify({
  type: "object",
  properties: { items: { type: "array" } },
  required: ["items"],
  additionalProperties: false,
});
const owners: RevisionOwner[] = [];
const runs: string[] = [];

test.afterEach(async ({ request }) => {
  for (const id of runs.splice(0))
    expect((await request.delete(`/api/runs/${id}`)).ok()).toBe(true);
  await cleanupByPrefix(request, "/api/workflows", PREFIX);
  cleanupRevisions(owners.splice(0));
});

test("未保存的契约可校验四类错误与合法样例，编辑后旧结论失效", async ({ page, request }) => {
  await page.goto("/object-types");
  await page.getByRole("button", { name: "新建类型" }).click();
  await page.getByLabel("基础形态").selectOption("json");
  const schema = page.getByPlaceholder('{"type":"object","properties":{...},"required":[...]}');
  await schema.fill(SCHEMA);
  const sample = page.getByRole("region", { name: "JSON 契约样例校验" });
  for (const [content, field, expected] of [
    ["{}", "$.items", "必填字段"],
    ['{"items":[],"wrong":true}', "$.wrong", "没有额外字段"],
    ['{"items":"错误"}', "$.items", "数组"],
    ["{broken", "$", "可解析的 JSON"],
  ]) {
    await sample.getByLabel("JSON 样例").fill(content);
    await sample.getByRole("button", { name: "校验样例" }).click();
    await expect(sample.getByRole("status")).toContainText("样例未通过契约校验");
    await expect(sample.getByRole("status")).toContainText(field);
    await expect(sample.getByRole("status")).toContainText(expected);
  }
  await sample.getByLabel("JSON 样例").fill('{"items":[]}');
  await sample.getByRole("button", { name: "校验样例" }).click();
  await expect(sample.getByRole("status")).toContainText("样例通过契约校验");
  await schema.fill('{"type":"number","minimum":1}');
  await expect(sample.getByRole("status")).toHaveCount(0);
  await sample.getByRole("button", { name: "校验样例" }).click();
  await expect(sample.getByRole("alert")).toContainText("不符合支持的契约子集");
  expect(
    (
      await request.post("/api/object-types", {
        data: { name: `${PREFIX}非法`, kind: "json", jsonSchema: '{"minimum":1}' },
      })
    ).status(),
  ).toBe(400);
});

test("失败轮次显示字段诊断和原文件，验收载荷不进入运行详情骨架", async ({ page, request }) => {
  const name = `${PREFIX}${randomUUID().slice(0, 8)}`;
  const workflowId = await createWorkflow(request, { name }, owners);
  const nodeId = randomUUID();
  const runId = randomUUID();
  const runDir = path.join(DATA_DIR, "runs", workflowId, runId);
  const filePath = path.join(runDir, "workspace", "错误结果.json");
  const content = '{"wrong":"原始失败文件"}';
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  const now = Date.now() - 1000;
  const validation = {
    execution: "completed",
    checkedAt: new Date().toISOString(),
    businessAcceptance: "not_evaluated",
    artifacts: [
      {
        port: "结果",
        artifactPath: "错误结果.json",
        objectTypeName: "清单",
        validation: "schema",
        issues: [{ path: "$.items", expected: "必填字段", actual: "未提供" }],
        file: {
          kind: "file",
          file: {
            path: path.relative(DATA_DIR, filePath),
            name: "错误结果.json",
            mime: "application/json",
          },
        },
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ],
  };
  insertSyntheticRun({
    workflowId,
    workflowName: name,
    runId,
    runDir,
    status: "failed",
    startedAt: now,
    finishedAt: now + 900,
    nodes: [
      { nodeId, label: "e2e-错误交付", status: "failed", startedAt: now, finishedAt: now + 900 },
    ],
    rounds: [
      {
        nodeId,
        round: 0,
        status: "failed",
        startedAt: now,
        finishedAt: now + 900,
        error: "产物契约校验失败",
        artifactValidation: validation,
      },
    ],
  });
  runs.push(runId);
  const detail = await (await request.get(`/api/runs/${runId}`)).json();
  expect(detail.rounds[0]).not.toHaveProperty("artifactValidation");
  await page.goto(`/runs/${runId}`);
  await page.getByRole("button", { name: "e2e-错误交付", exact: true }).click();
  const drawer = page.getByTestId("run-drawer");
  await drawer.getByTestId("run-drawer-tab-io").click();
  const receipt = drawer.getByRole("region", { name: "产物契约验收" });
  await expect(receipt).toContainText("未通过");
  await expect(receipt).toContainText("业务质量尚未验收");
  await expect(receipt).toContainText("$.items");
  await receipt.getByRole("button", { name: "查看失败文件" }).click();
  await expect(receipt.locator("pre")).toHaveText(content);
  await receipt.getByText("校验文件 SHA-256", { exact: true }).click();
  await expect(receipt).toContainText(validation.artifacts[0].sha256);
});
