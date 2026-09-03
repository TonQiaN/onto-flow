import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import Database from "better-sqlite3";
import { cleanupByPrefix } from "./helpers";

/**
 * 多路并行运行的界面验收：
 * - 导航侧栏的「运行中」面板逐路列出进行中的运行，点击深链到对应画布；
 * - 画布运行条在同一工作流多路并行时出现切换器，可在各路之间切换跟随；
 * - 运行结束后面板收起、运行条转为结果条。
 *
 * 运行用合成 DB 行（模式与 runs.spec.ts 相同）：不经引擎、零费用、时序完全可控。
 */
const PREFIX = "e2e-多路-";
const DB_PATH = path.join(process.cwd(), "data", "ontoflow.db");

function openDb(): Database.Database {
  const database = new Database(DB_PATH);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  return database;
}

function insertSyntheticRun(workflowId: string, workflowName: string): string {
  const runId = randomUUID();
  const now = Date.now();
  const database = openDb();
  try {
    const insert = database.transaction(() => {
      database
        .prepare(
          "insert into runs (id, workflow_id, status, workflow_name, started_at) values (?, ?, 'running', ?, ?)",
        )
        .run(runId, workflowId, workflowName, now);
      const node = database.prepare(
        "insert into run_nodes (id, run_id, node_id, label, status) values (?, ?, ?, ?, 'pending')",
      );
      node.run(randomUUID(), runId, "in-multi", "输入");
      node.run(randomUUID(), runId, "out-multi", "输出");
    });
    insert();
  } finally {
    database.close();
  }
  return runId;
}

function finishSyntheticRuns(runIds: string[]): void {
  const database = openDb();
  try {
    const now = Date.now();
    for (const runId of runIds) {
      database
        .prepare("update run_nodes set status = 'success', finished_at = ? where run_id = ?")
        .run(now, runId);
      database
        .prepare("update runs set status = 'success', finished_at = ? where id = ?")
        .run(now, runId);
    }
  } finally {
    database.close();
  }
}

/** 上次中断可能遗留的本 spec 数据：先失败化并删运行，再删实体。 */
async function removeStale(request: APIRequestContext): Promise<void> {
  const database = openDb();
  let runIds: string[] = [];
  try {
    runIds = (
      database
        .prepare("select id from runs where workflow_name like ?")
        .all(`${PREFIX}%`) as Array<{ id: string }>
    ).map((row) => row.id);
    database
      .prepare(
        "update runs set status = 'failed', finished_at = ? where status = 'running' and workflow_name like ?",
      )
      .run(Date.now(), `${PREFIX}%`);
  } finally {
    database.close();
  }
  for (const runId of runIds) await request.delete(`/api/runs/${runId}`);
  await cleanupByPrefix(request, "/api/workflows", PREFIX);
  await cleanupByPrefix(request, "/api/object-types", PREFIX);
}

test.describe("多路并行界面", () => {
  test.beforeAll(async ({ request }) => {
    await removeStale(request);
  });

  test.afterAll(async ({ request }) => {
    await removeStale(request);
  });

  test("导航面板逐路列出运行，画布切换器可在多路之间切换", async ({ page, request }) => {
    test.setTimeout(120_000);

    const typeRes = await request.post("/api/object-types", {
      data: { name: `${PREFIX}文本`, kind: "text", description: "多路界面验收用" },
    });
    expect(typeRes.ok()).toBeTruthy();
    const typeId = ((await typeRes.json()) as { id: string }).id;

    const workflowName = `${PREFIX}直通`;
    const wfRes = await request.post("/api/workflows", {
      data: { name: workflowName, description: "多路并行界面验收" },
    });
    expect(wfRes.ok()).toBeTruthy();
    const workflowId = ((await wfRes.json()) as { id: string }).id;
    const putRes = await request.put(`/api/workflows/${workflowId}`, {
      data: {
        nodes: [
          { id: "in-multi", kind: "input", objectTypeId: typeId, label: "输入", x: 0, y: 0 },
          { id: "out-multi", kind: "output", objectTypeId: typeId, label: "输出", x: 240, y: 0 },
        ],
        edges: [
          {
            id: "e-multi",
            sourceNodeId: "in-multi",
            sourcePort: "value",
            targetNodeId: "out-multi",
            targetPort: "value",
          },
        ],
      },
    });
    expect(putRes.ok()).toBeTruthy();

    const runA = insertSyntheticRun(workflowId, workflowName);
    const runB = insertSyntheticRun(workflowId, workflowName);

    try {
      // 导航面板：两路都在列，标注工作流名与进度。
      await page.goto("/workflows");
      const panel = page.getByTestId("nav-running-runs");
      await expect(panel).toBeVisible({ timeout: 10_000 });
      await expect(panel).toContainText("运行中 · 2 路");
      const items = page.getByTestId("nav-running-run");
      await expect(items).toHaveCount(2);
      await expect(items.first()).toContainText(workflowName);
      await expect(items.first()).toContainText("节点 0/2");

      // 点击其中一路 → 深链进画布并精确跟随这一路。
      const itemA = items.filter({ hasText: runA.slice(0, 8) });
      await expect(itemA).toHaveCount(1);
      await itemA.click();
      await page.waitForURL(`/workflows/${workflowId}?runId=${runA}`);
      await expect(page.getByText("运行中", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("¥0", { exact: true }).first()).toBeVisible();

      // 并行切换器：两路都在选项里，切到另一路后 URL 跟着换。
      const switcher = page.getByTestId("run-switcher");
      await expect(switcher).toBeVisible({ timeout: 10_000 });
      await expect(switcher.locator("option")).toHaveCount(2);
      await expect(switcher).toHaveValue(runA);

      // 画布保持挂载时再点同工作流的另一条导航深链：只有 query string 改变，
      // 仍必须切换 SSE 与取消目标，不能停留在上一条运行。
      const itemB = page.getByTestId("nav-running-run").filter({ hasText: runB.slice(0, 8) });
      await itemB.click();
      await page.waitForURL(`/workflows/${workflowId}?runId=${runB}`);
      await expect(switcher).toHaveValue(runB);
      await expect(page.getByText("运行中", { exact: true })).toBeVisible();

      await switcher.selectOption(runA);
      await expect(switcher).toHaveValue(runA);
      await expect(page).toHaveURL(new RegExp(`runId=${runA}`));

      // 两路都收束：运行条转成结果条，导航面板收起。
      finishSyntheticRuns([runA, runB]);
      await expect(page.getByText("运行成功", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByTestId("nav-running-runs")).toHaveCount(0, {
        timeout: 15_000,
      });
    } finally {
      finishSyntheticRuns([runA, runB]);
    }

    // 收尾即验收删除：合成运行经 DELETE /api/runs/[id] 收走。
    for (const runId of [runA, runB]) {
      const del = await request.delete(`/api/runs/${runId}`);
      expect(del.ok(), `删除运行 ${runId}`).toBeTruthy();
    }
  });

  test("深链运行必须属于当前工作流", async ({ page, request }) => {
    const currentRes = await request.post("/api/workflows", {
      data: { name: `${PREFIX}深链目标`, description: "深链归属验收" },
    });
    const otherRes = await request.post("/api/workflows", {
      data: { name: `${PREFIX}其它工作流`, description: "不得被目标画布跟随" },
    });
    expect(currentRes.ok()).toBeTruthy();
    expect(otherRes.ok()).toBeTruthy();
    const currentId = ((await currentRes.json()) as { id: string }).id;
    const other = (await otherRes.json()) as { id: string; name: string };
    const foreignRunId = insertSyntheticRun(other.id, other.name);

    try {
      await page.goto(`/workflows/${currentId}?runId=${foreignRunId}`);
      await expect(page.getByText("链接中的运行不存在或不属于当前工作流，已停止跟随")).toBeVisible({
        timeout: 10_000,
      });
      await expect(page).toHaveURL(`/workflows/${currentId}`);
      await expect(page.getByRole("button", { name: "取消运行" })).toHaveCount(0);

      const database = openDb();
      try {
        expect(database.prepare("select status from runs where id = ?").get(foreignRunId)).toEqual({
          status: "running",
        });
      } finally {
        database.close();
      }
    } finally {
      finishSyntheticRuns([foreignRunId]);
      const del = await request.delete(`/api/runs/${foreignRunId}`);
      expect(del.ok(), `删除运行 ${foreignRunId}`).toBeTruthy();
    }
  });

  test("深链详情临时失败时保留 runId 并自动重试", async ({ page, request }) => {
    const workflowRes = await request.post("/api/workflows", {
      data: { name: `${PREFIX}深链重试`, description: "临时错误不能清除深链" },
    });
    expect(workflowRes.ok()).toBeTruthy();
    const workflow = (await workflowRes.json()) as { id: string; name: string };
    const runId = insertSyntheticRun(workflow.id, workflow.name);
    let detailAttempts = 0;
    let allowDetailSuccess = false;
    await page.route(`**/api/runs/${runId}`, async (route) => {
      detailAttempts += 1;
      if (!allowDetailSuccess) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "临时读取失败" }),
        });
        return;
      }
      await route.continue();
    });

    try {
      await page.goto(`/workflows/${workflow.id}?runId=${runId}`);
      await expect(page.getByText("运行详情暂时无法读取，已保留链接并正在重试")).toBeVisible({
        timeout: 10_000,
      });
      await expect(page).toHaveURL(`/workflows/${workflow.id}?runId=${runId}`);
      allowDetailSuccess = true;
      await expect(page.getByRole("button", { name: "取消运行" })).toBeVisible({
        timeout: 10_000,
      });
      expect(detailAttempts).toBeGreaterThanOrEqual(2);
      await expect(page).toHaveURL(`/workflows/${workflow.id}?runId=${runId}`);
    } finally {
      allowDetailSuccess = true;
      finishSyntheticRuns([runId]);
      const del = await request.delete(`/api/runs/${runId}`);
      expect(del.ok(), `删除运行 ${runId}`).toBeTruthy();
    }
  });
});
