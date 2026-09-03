import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  cleanupByPrefix,
  finishSyntheticRuns,
  insertSyntheticRun,
  linearRunGraph,
  openDb,
} from "./helpers";

/**
 * 多路并行运行的界面验收（ADR-0018）：看一次运行只有 `/runs/<id>` 一个地方，
 * 多路之间的切换退到导航侧栏与运行列表。
 * - 导航侧栏的「运行中」面板逐路列出进行中的运行，每一路深链到自己的运行页；
 * - 运行页概要栏显示这一路的状态与取消按钮，取消打的是这一路的接口；
 * - 运行收束后这一路从面板里消失。
 *
 * 运行用合成 DB 行（`insertSyntheticRun`）：不经引擎、零费用、时序完全可控。
 * 断言一律只对本 spec 自建的两条运行，不对面板里的条数——真实使用里可能有别的运行在跑。
 */
const PREFIX = "e2e-多路-";

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

  test("导航面板逐路列出运行，每一路深链到自己的运行页", async ({ page, request }) => {
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

    const inputNodeId = "in-multi";
    const outputNodeId = "out-multi";
    const putRes = await request.put(`/api/workflows/${workflowId}`, {
      data: {
        nodes: [
          { id: inputNodeId, kind: "input", objectTypeId: typeId, label: "输入", x: 0, y: 0 },
          { id: outputNodeId, kind: "output", objectTypeId: typeId, label: "输出", x: 240, y: 0 },
        ],
        edges: [
          {
            id: "e-multi",
            sourceNodeId: inputNodeId,
            sourcePort: "value",
            targetNodeId: outputNodeId,
            targetPort: "value",
          },
        ],
      },
    });
    expect(putRes.ok()).toBeTruthy();

    // 两路并行：各自冻结同一张图，节点都还没轮到（pending），运行页画的是冻结件不是现图。
    const graph = linearRunGraph({ inputNodeId, outputNodeId, objectTypeId: typeId });
    const startedAt = Date.now() - 5_000;
    const newRun = () =>
      insertSyntheticRun({
        runId: randomUUID(),
        workflowId,
        workflowName,
        status: "running",
        startedAt,
        graph,
        nodes: [
          { nodeId: inputNodeId, label: "输入" },
          { nodeId: outputNodeId, label: "输出" },
        ],
      });
    const runA = newRun();
    const runB = newRun();

    try {
      // 导航面板：本 spec 的两路都在列，标注工作流名与进度。
      await page.goto("/workflows");
      const panel = page.getByTestId("nav-running-runs");
      await expect(panel).toBeVisible({ timeout: 10_000 });
      const rowA = page.getByTestId("nav-running-run").filter({ hasText: runA.slice(0, 8) });
      const rowB = page.getByTestId("nav-running-run").filter({ hasText: runB.slice(0, 8) });
      await expect(rowA).toHaveCount(1);
      await expect(rowB).toHaveCount(1);
      await expect(rowA).toContainText(workflowName);
      await expect(rowA).toContainText("节点 0/2");

      // 点其中一路 → 深链到它自己的运行页，概要栏是这一路的状态。
      await rowA.click();
      await page.waitForURL(`/runs/${runA}`);
      const summary = page.getByTestId("run-summary-bar");
      await expect(summary).toBeVisible({ timeout: 10_000 });
      await expect(summary).toContainText("运行中");
      await expect(summary).toContainText(workflowName);
      await expect(summary).toContainText(runA.slice(0, 8));

      // 取消按钮打的是这一路的接口。请求在浏览器里就被 route 拦下并伪造成 409，
      // 一个字节都到不了服务端——验的是「按钮指向哪一路」，不是真的中止运行。
      const cancelUrls: string[] = [];
      await page.route("**/api/runs/*/cancel", async (route) => {
        cancelUrls.push(route.request().url());
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "e2e 拦截：不真的取消" }),
        });
      });
      await page.getByRole("button", { name: "取消运行" }).click();
      await page.getByRole("button", { name: "确认取消" }).click();
      await expect.poll(() => cancelUrls).toHaveLength(1);
      expect(cancelUrls[0]).toContain(`/api/runs/${runA}/cancel`);
      expect(cancelUrls[0]).not.toContain(runB);
      await page.unroute("**/api/runs/*/cancel");

      // 另一路是另一个页面，不是同一页里的切换器：深链各走各的。
      await page
        .getByTestId("nav-running-run")
        .filter({ hasText: runB.slice(0, 8) })
        .click();
      await page.waitForURL(`/runs/${runB}`);
      await expect(page.getByTestId("run-summary-bar")).toContainText("运行中");
      await expect(page.getByTestId("run-summary-bar")).toContainText(runB.slice(0, 8));

      // 两路都收束：概要栏转成结果状态，导航面板里本 spec 的两行消失。
      finishSyntheticRuns([runA, runB]);
      await expect(page.getByTestId("run-summary-bar")).toContainText("成功", {
        timeout: 15_000,
      });
      await expect(
        page.getByTestId("nav-running-run").filter({ hasText: runA.slice(0, 8) }),
      ).toHaveCount(0, { timeout: 15_000 });
      await expect(
        page.getByTestId("nav-running-run").filter({ hasText: runB.slice(0, 8) }),
      ).toHaveCount(0, { timeout: 15_000 });
    } finally {
      finishSyntheticRuns([runA, runB]);
    }

    // 收尾即验收删除：合成运行经 DELETE /api/runs/[id] 收走。
    for (const runId of [runA, runB]) {
      const del = await request.delete(`/api/runs/${runId}`);
      expect(del.ok(), `删除运行 ${runId}`).toBeTruthy();
    }
  });
});
