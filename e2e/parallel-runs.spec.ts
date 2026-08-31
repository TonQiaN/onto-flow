import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { cleanupByPrefix } from "./helpers";

/**
 * 并行运行验收：把工作流当对外 API 用，同一个工作流同时发起 10 次运行，
 * 全部并行执行、全部成功、事后能逐个删除。
 *
 * 工作流刻意只有输入→输出两个节点：不含 Action 就不产生模型调用与费用，
 * 但每次运行仍然走完整的引擎生命周期——建工作区、spawn harness 子进程、
 * 驱动节点、收束终态——10 个子进程真实地同时存在，这正是要验收的东西。
 * 运行记录用 DELETE /api/runs/[id] 收走，不污染真实运行历史。
 */
const PREFIX = "e2e-并行-";
const RUN_COUNT = 10;

interface RunDetail {
  run: {
    id: string;
    status: string;
    error: string | null;
    runDir: string | null;
    startedAt: string | number;
    finishedAt: string | number | null;
  };
  nodes: Array<{
    nodeId: string;
    status: string;
    error: string | null;
    outputs: Record<string, { kind: string; text?: string }> | null;
  }>;
}

function toMs(value: string | number | null): number {
  if (value === null) throw new Error("时间戳为空");
  return typeof value === "number" ? value : new Date(value).getTime();
}

/** 上次进程被中断时可能遗留的本 spec 运行与实体；先运行后实体，级联才不会留孤儿目录。 */
async function removeStale(request: APIRequestContext): Promise<void> {
  const res = await request.get(`/api/workflows?q=${encodeURIComponent(PREFIX)}&pageSize=100`);
  if (res.ok()) {
    const body = (await res.json()) as { items?: Array<{ id: string; name: string }> };
    for (const wf of body.items ?? []) {
      if (!wf.name.startsWith(PREFIX)) continue;
      const runsRes = await request.get(`/api/runs?workflowId=${wf.id}`);
      if (!runsRes.ok()) continue;
      const rows = (await runsRes.json()) as Array<{ id: string }>;
      for (const row of rows) await request.delete(`/api/runs/${row.id}`);
    }
  }
  await cleanupByPrefix(request, "/api/workflows", PREFIX);
  await cleanupByPrefix(request, "/api/object-types", PREFIX);
}

test.describe("并行运行", () => {
  test.beforeAll(async ({ request }) => {
    await removeStale(request);
  });

  test.afterAll(async ({ request }) => {
    await removeStale(request);
  });

  test(`同一工作流同时发起 ${RUN_COUNT} 次运行，全部并行成功`, async ({ request }) => {
    test.setTimeout(180_000);

    // 直通工作流：输入 → 输出，无 Action、零费用，但每次运行仍 spawn 独立子进程。
    const typeRes = await request.post("/api/object-types", {
      data: { name: `${PREFIX}文本`, kind: "text", description: "并行验收用" },
    });
    expect(typeRes.ok()).toBeTruthy();
    const typeId = ((await typeRes.json()) as { id: string }).id;

    const wfRes = await request.post("/api/workflows", {
      data: { name: `${PREFIX}直通`, description: "并行运行验收：输入直通输出" },
    });
    expect(wfRes.ok()).toBeTruthy();
    const workflowId = ((await wfRes.json()) as { id: string }).id;

    const inputNodeId = "in-parallel";
    const outputNodeId = "out-parallel";
    const putRes = await request.put(`/api/workflows/${workflowId}`, {
      data: {
        nodes: [
          { id: inputNodeId, kind: "input", objectTypeId: typeId, label: "输入", x: 0, y: 0 },
          { id: outputNodeId, kind: "output", objectTypeId: typeId, label: "输出", x: 240, y: 0 },
        ],
        edges: [
          {
            id: "e-parallel",
            sourceNodeId: inputNodeId,
            sourcePort: "value",
            targetNodeId: outputNodeId,
            targetPort: "value",
          },
        ],
      },
    });
    expect(putRes.ok()).toBeTruthy();

    // 同时发起 10 次运行——这是对外 API 的真实调用形态。
    const startResponses = await Promise.all(
      Array.from({ length: RUN_COUNT }, (_, i) =>
        request.post(`/api/workflows/${workflowId}/run`, {
          data: { inputs: { [inputNodeId]: { kind: "text", text: `并行验收 #${i + 1}` } } },
        }),
      ),
    );
    const runIds: string[] = [];
    for (const res of startResponses) {
      expect(res.status()).toBe(200);
      runIds.push(((await res.json()) as { runId: string }).runId);
    }
    expect(new Set(runIds).size).toBe(RUN_COUNT);

    // 轮询到全部终态。10 个子进程同时冷启动（tsx 编译），给足预算。
    const details = new Map<string, RunDetail>();
    const deadline = Date.now() + 150_000;
    while (details.size < RUN_COUNT) {
      expect(Date.now(), "等待全部运行收束超时").toBeLessThan(deadline);
      for (const runId of runIds) {
        if (details.has(runId)) continue;
        const res = await request.get(`/api/runs/${runId}`);
        expect(res.ok()).toBeTruthy();
        const detail = (await res.json()) as RunDetail;
        if (detail.run.status !== "running") details.set(runId, detail);
      }
      if (details.size < RUN_COUNT) await new Promise((r) => setTimeout(r, 1000));
    }

    // 全部成功，逐个核对：状态、无错误、输入原样直通到输出节点。
    for (const [runId, detail] of details) {
      const label = `运行 ${runId}`;
      expect(detail.run.status, `${label} 状态`).toBe("success");
      expect(detail.run.error, `${label} 错误`).toBeNull();
      const index = runIds.indexOf(runId);
      const outputNode = detail.nodes.find((n) => n.nodeId === outputNodeId);
      expect(outputNode?.status, `${label} 输出节点状态`).toBe("success");
      expect(outputNode?.outputs?.value?.text, `${label} 直通值`).toBe(
        `并行验收 #${index + 1}`,
      );
      for (const node of detail.nodes) {
        expect(node.error, `${label} 节点 ${node.nodeId} 错误`).toBeNull();
      }
    }

    // 并行证据：最早收束的那一刻，10 个运行全都已经开始——同时在飞的确是 10 个。
    const startTimes = [...details.values()].map((d) => toMs(d.run.startedAt));
    const finishTimes = [...details.values()].map((d) => toMs(d.run.finishedAt));
    expect(Math.max(...startTimes)).toBeLessThanOrEqual(Math.min(...finishTimes));

    // 逐运行查日志：运行目录独立存在，harness 子进程的 stderr 日志已落盘。
    const runDirs = new Set<string>();
    for (const [runId, detail] of details) {
      const runDir = detail.run.runDir;
      expect(runDir, `运行 ${runId} 缺少 runDir`).toBeTruthy();
      runDirs.add(runDir!);
      const stderrLog = path.join(process.cwd(), runDir!, "logs", "harness.stderr.log");
      expect(fs.existsSync(stderrLog), `运行 ${runId} 缺少 ${stderrLog}`).toBeTruthy();
    }
    expect(runDirs.size).toBe(RUN_COUNT);

    // 收尾即验收删除 API：逐个删运行，记录与目录一起消失。
    for (const [runId, detail] of details) {
      const del = await request.delete(`/api/runs/${runId}`);
      expect(del.ok(), `删除运行 ${runId}`).toBeTruthy();
      const gone = await request.get(`/api/runs/${runId}`);
      expect(gone.status()).toBe(404);
      expect(fs.existsSync(path.join(process.cwd(), detail.run.runDir!))).toBeFalsy();
    }
  });
});
