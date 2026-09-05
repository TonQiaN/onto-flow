import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  DATA_DIR,
  cleanupByPrefix,
  cleanupRevisions,
  createWorkflow,
  finishSyntheticRuns,
  insertSyntheticRun,
  openDb,
  type RevisionOwner,
} from "./helpers";

const PREFIX = "e2e-结果刷新-";
const owners: RevisionOwner[] = [];
const runIds: string[] = [];
type Fixture = {
  runId: string;
  nodeId: string;
  started: number;
  file: { kind: "file"; file: { path: string; name: string; mime: string } };
};

async function fixture(request: APIRequestContext): Promise<Fixture> {
  const name = `${PREFIX}${randomUUID().slice(0, 8)}`;
  const workflowId = await createWorkflow(request, { name }, owners);
  const runId = randomUUID();
  const nodeId = randomUUID();
  const runDir = path.join(DATA_DIR, "runs", workflowId, runId);
  const outputPath = path.join(runDir, "workspace", "最终输出.md");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, "P0 自动刷新完成正文");
  const started = Date.now() - 2000;
  insertSyntheticRun({
    workflowId,
    workflowName: name,
    runId,
    runDir,
    startedAt: started,
    nodes: [{ nodeId, label: "e2e-观察节点", status: "running", startedAt: started }],
    rounds: [{ nodeId, round: 0, status: "running", startedAt: started }],
  });
  runIds.push(runId);
  return {
    runId,
    nodeId,
    started,
    file: {
      kind: "file",
      file: {
        path: path.relative(DATA_DIR, outputPath),
        name: "最终输出.md",
        mime: "text/markdown",
      },
    },
  };
}

function payloadPath(f: Fixture, round = 0) {
  return `/api/runs/${f.runId}/nodes/${f.nodeId}/rounds/${round}`;
}

async function openDrawer(page: Page, f: Fixture) {
  await page.goto(`/runs/${f.runId}`);
  await page.getByRole("button", { name: "e2e-观察节点", exact: true }).click();
  return page.getByTestId("run-drawer");
}

function finish(f: Fixture, status: "success" | "failed" = "success") {
  const db = openDb();
  const now = Date.now();
  const error = status === "failed" ? "产物契约校验失败：$.items 必填字段" : null;
  const validation =
    status === "failed"
      ? {
          execution: "completed",
          checkedAt: new Date(now).toISOString(),
          businessAcceptance: "not_evaluated",
          artifacts: [
            {
              port: "结果",
              artifactPath: "最终输出.md",
              objectTypeName: "结果",
              validation: "schema",
              file: f.file,
              sha256: null,
              issues: [{ path: "$.items", expected: "必填字段", actual: "未提供" }],
            },
          ],
        }
      : null;
  try {
    db.transaction(() => {
      db.prepare(
        "UPDATE run_node_rounds SET status=?, finished_at=?, outputs=?, error=?, artifact_validation=? WHERE run_id=? AND node_id=? AND round=0",
      ).run(
        status,
        now,
        status === "success" ? JSON.stringify({ 结果: f.file }) : null,
        error,
        validation ? JSON.stringify(validation) : null,
        f.runId,
        f.nodeId,
      );
      db.prepare(
        "UPDATE run_nodes SET status=?, finished_at=?, error=? WHERE run_id=? AND node_id=?",
      ).run(status, now, error, f.runId, f.nodeId);
      db.prepare("UPDATE runs SET status=?, finished_at=?, error=? WHERE id=?").run(
        status,
        now,
        error,
        f.runId,
      );
    })();
  } finally {
    db.close();
  }
}

test.afterEach(async ({ request }) => {
  finishSyntheticRuns(runIds);
  for (const id of runIds.splice(0))
    expect((await request.delete(`/api/runs/${id}`)).ok()).toBe(true);
  await cleanupByPrefix(request, "/api/workflows", PREFIX);
  cleanupRevisions(owners.splice(0));
});

for (const status of ["success", "failed"] as const) {
  test(`抽屉保持打开，运行中转为${status === "success" ? "成功" : "失败"}时自动展示最终产物或验收错误`, async ({
    page,
    request,
  }) => {
    const f = await fixture(request);
    let requests = 0;
    page.on("request", (r) => {
      if (r.url().endsWith(payloadPath(f))) requests++;
    });
    const drawer = await openDrawer(page, f);
    await expect(drawer.getByTestId("agent-trajectory-panel")).toBeVisible();
    expect(requests).toBe(0);
    const initial = page.waitForResponse((r) => r.url().endsWith(payloadPath(f)));
    await drawer.getByTestId("run-drawer-tab-io").click();
    expect((await (await initial).json()).outputs).toBeNull();
    finish(f, status);
    await expect(drawer).toContainText(status === "success" ? "成功" : "失败");
    if (status === "success") {
      await expect(drawer).toContainText("最终输出.md");
      await drawer.getByRole("button", { name: "查看内容" }).click();
      await expect(drawer.locator("pre")).toContainText("P0 自动刷新完成正文");
    } else {
      await expect(drawer.getByRole("region", { name: "产物契约验收" })).toContainText("$.items");
      await expect(drawer.getByRole("button", { name: "查看失败文件" })).toBeVisible();
    }
    expect(requests).toBeGreaterThan(1);
  });
}

// 模拟确定性的传输顺序；不依赖模型时长，也不在 CI 启动 Action。
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("终态新结果先到，迟到的运行中请求不能覆盖它", async ({ page, request }) => {
  const f = await fixture(request);
  const arrived = deferred();
  const release = deferred();
  const delivered = deferred();
  let count = 0;
  await page.route(`**${payloadPath(f)}`, async (route) => {
    if (++count !== 1) return route.continue();
    const response = await route.fetch();
    arrived.resolve();
    await release.promise;
    try {
      await route.fulfill({ response });
    } catch {
      /* 请求应已被组件取消。 */
    }
    delivered.resolve();
  });
  const drawer = await openDrawer(page, f);
  await drawer.getByTestId("run-drawer-tab-io").click();
  await arrived.promise;
  try {
    await expect(drawer).toContainText("正在读取这一轮的输入输出");
    finish(f);
    await expect(drawer).toContainText("最终输出.md");
    release.resolve();
    await delivered.promise;
    await drawer.getByRole("button", { name: "查看内容" }).click();
    await expect(drawer.locator("pre")).toContainText("P0 自动刷新完成正文");
    expect(count).toBeGreaterThan(1);
  } finally {
    release.resolve();
  }
});

test("读取失败可手动刷新恢复，清理事实与未产出明确区分", async ({ page, request }) => {
  const f = await fixture(request);
  finish(f);
  let first = true;
  await page.route(`**${payloadPath(f)}`, async (route) => {
    if (!first) return route.continue();
    first = false;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "验收夹具：读取暂不可用" }),
    });
  });
  const drawer = await openDrawer(page, f);
  await drawer.getByTestId("run-drawer-tab-io").click();
  await expect(drawer).toContainText("验收夹具：读取暂不可用");
  await expect(drawer).not.toContainText("已被清理");
  await drawer.getByRole("button", { name: "刷新结果" }).click();
  await expect(drawer).toContainText("最终输出.md");
  await drawer.getByRole("button", { name: "查看内容" }).click();
  await expect(drawer.locator("pre")).toContainText("P0 自动刷新完成正文");
  const absolute = path.join(DATA_DIR, f.file.file.path);
  await writeFile(absolute, "手动刷新后的正文");
  await drawer.getByRole("button", { name: "刷新结果" }).click();
  await expect(drawer.locator("pre")).toHaveText("手动刷新后的正文");
  // 精确修改自己的合成行，模拟事件清理的事实，不调用破坏性清理接口。
  const db = openDb();
  try {
    db.prepare(
      "UPDATE run_node_rounds SET inputs=NULL, outputs=NULL, snapshot=NULL, artifact_validation=NULL, payload_cleared_at=? WHERE run_id=?",
    ).run(Date.now(), f.runId);
  } finally {
    db.close();
  }
  await drawer.getByRole("button", { name: "刷新结果" }).click();
  await expect(drawer).toContainText("已被清理");
  await expect(drawer).not.toContainText("尚未产出");
  await expect(drawer.locator("pre")).toHaveCount(0);
  await drawer.getByTestId("run-drawer-tab-snapshot").click();
  await expect(drawer).toContainText("已被清理");
});

test("执行中后写入的载荷自动更新，打开过的文件在运行结束后自动重试预览", async ({
  page,
  request,
}) => {
  const f = await fixture(request);
  // 合成运行没有真实子进程，明确模拟 activeRuns 文件预览闸门的 409。
  let active = true;
  let blockedRequests = 0;
  await page.route(`**/api/runs/${f.runId}/files?*`, async (route) => {
    if (!active) return route.continue();
    blockedRequests++;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "运行执行期间暂不支持文件预览，请等待运行结束" }),
    });
  });
  const drawer = await openDrawer(page, f);
  await drawer.getByTestId("run-drawer-tab-io").click();
  await expect(drawer).toContainText("尚未产出");
  const db = openDb();
  try {
    db.prepare("UPDATE run_node_rounds SET outputs=? WHERE run_id=?").run(
      JSON.stringify({ 结果: f.file }),
      f.runId,
    );
  } finally {
    db.close();
  }
  await expect(drawer).toContainText("最终输出.md");
  await drawer.getByRole("button", { name: "查看内容" }).click();
  await expect(drawer).toContainText("运行执行期间暂不支持文件预览");
  finish(f);
  await expect(drawer).toContainText("成功");
  // 终态先到，执行器仍占用；释放占用不再触发任何 SSE 或状态变化。
  await expect.poll(() => blockedRequests).toBeGreaterThan(1);
  active = false;
  await expect(drawer.locator("pre")).toContainText("P0 自动刷新完成正文");
});

test("切轮取消迟到请求，已结束轮次缓存不随回放光标重复读取", async ({ page, request }) => {
  const f = await fixture(request);
  finish(f);
  const db = openDb();
  const second = { kind: "file", file: { ...f.file.file, name: "第二轮.md" } };
  try {
    const now = Date.now();
    db.prepare("UPDATE run_node_rounds SET finished_at=? WHERE run_id=?").run(
      f.started + 700,
      f.runId,
    );
    db.prepare(
      "INSERT INTO run_node_rounds (id, run_id, node_id, round, status, started_at, finished_at, outputs) VALUES (?,?,?,1,'success',?,?,?)",
    ).run(randomUUID(), f.runId, f.nodeId, f.started + 1000, now, JSON.stringify({ 结果: second }));
    db.prepare("UPDATE runs SET finished_at=? WHERE id=?").run(now, f.runId);
  } finally {
    db.close();
  }
  const pending = deferred();
  const release = deferred();
  const delivered = deferred();
  const counts = [0, 0];
  await page.route(`**/api/runs/${f.runId}/nodes/${f.nodeId}/rounds/*`, async (route) => {
    const round = Number(route.request().url().split("/").at(-1));
    counts[round]++;
    if (round !== 1 || counts[1] > 1) return route.continue();
    const response = await route.fetch();
    pending.resolve();
    await release.promise;
    try {
      await route.fulfill({ response });
    } catch {
      /* 换轮已取消旧请求。 */
    }
    delivered.resolve();
  });
  const drawer = await openDrawer(page, f);
  await drawer.getByTestId("run-drawer-tab-io").click();
  await pending.promise;

  // 第一段在抽屉左侧，可直接点击，不需要重开抽屉。
  const firstSegment = page.locator('[data-testid="run-timeline-segment"][data-round="0"]');
  try {
    await firstSegment.click({ position: { x: 2, y: 5 } });
    await expect(drawer).toContainText("最终输出.md");
    release.resolve();
    await delivered.promise;
    await expect(drawer).not.toContainText("第二轮.md");
    const previousCount = counts[0];
    await drawer.getByTestId("run-drawer-tab-snapshot").click();
    await expect(drawer).toContainText("未生成运行快照");
    await drawer.getByTestId("run-drawer-tab-io").click();
    await expect(drawer).toContainText("最终输出.md");
    await firstSegment.click({ position: { x: 5, y: 5 } });
    expect(counts[0]).toBe(previousCount);
  } finally {
    release.resolve();
  }
});

test("切节点后迟到的旧载荷不能进入另一节点抽屉", async ({ page, request }) => {
  const f = await fixture(request);
  finish(f);
  const otherId = randomUUID();
  const db = openDb();
  try {
    db.prepare(
      "INSERT INTO run_nodes (id, run_id, node_id, label, status, started_at, finished_at) VALUES (?,?,?,'e2e-另一节点','success',?,?)",
    ).run(randomUUID(), f.runId, otherId, f.started, Date.now());
    db.prepare(
      "INSERT INTO run_node_rounds (id, run_id, node_id, round, status, started_at, finished_at, outputs) VALUES (?,?,?,0,'success',?,?,?)",
    ).run(
      randomUUID(),
      f.runId,
      otherId,
      f.started,
      Date.now(),
      JSON.stringify({ 结果: { ...f.file, file: { ...f.file.file, name: "另一节点.md" } } }),
    );
  } finally {
    db.close();
  }
  const pending = deferred();
  const release = deferred();
  const delivered = deferred();
  await page.route(`**${payloadPath(f)}`, async (route) => {
    const response = await route.fetch();
    pending.resolve();
    await release.promise;
    try {
      await route.fulfill({ response });
    } catch {
      /* 节点已经卸载，旧请求取消。 */
    }
    delivered.resolve();
  });
  const drawer = await openDrawer(page, f);
  await drawer.getByTestId("run-drawer-tab-io").click();
  await pending.promise;
  try {
    await page.getByRole("button", { name: "e2e-另一节点", exact: true }).click();
    await drawer.getByTestId("run-drawer-tab-io").click();
    await expect(drawer).toContainText("另一节点.md");
    release.resolve();
    await delivered.promise;
    await expect(drawer).toHaveAttribute("data-node-id", otherId);
    await expect(drawer).not.toContainText("最终输出.md");
  } finally {
    release.resolve();
  }
});

test("收起等待中的文件会停止活跃执行器的 409 自动重试", async ({ page, request }) => {
  await page.setViewportSize({ width: 1100, height: 850 });
  const f = await fixture(request);
  finish(f);
  let requests = 0;
  await page.route(`**/api/runs/${f.runId}/files?*`, async (route) => {
    requests++;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "执行器尚未释放" }),
    });
  });
  const drawer = await openDrawer(page, f);
  await drawer.getByTestId("run-drawer-tab-io").click();
  await drawer.getByRole("button", { name: "查看内容" }).click();
  await expect(drawer).toContainText("每 2 秒自动重试");
  await page.screenshot({ path: test.info().outputPath("file-preview-wait.png") });
  await drawer.getByRole("button", { name: "收起", exact: true }).click();
  const before = requests;
  // 必须跨过一次 2 秒计时周期，才能证明收起取消了自动请求。
  await page.waitForTimeout(2300);
  expect(requests).toBe(before);
  await expect(drawer).not.toContainText("自动重试");
});
