import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
  };
  nodes: Array<{
    nodeId: string;
    status: string;
    error: string | null;
    outputs: Record<
      string,
      { kind: string; text?: string; file?: { path: string; name: string } }
    > | null;
  }>;
}

/** 直接读 OS 进程表；run.startedAt 只代表受理，不能证明实际 harness 执行重叠。 */
function harnessProcessesFor(workflowId: string): number {
  const commands = execFileSync("/bin/ps", ["-axo", "command="], {
    encoding: "utf8",
  });
  return commands
    .split("\n")
    .filter(
      (command) =>
        command.includes("src/server/harness/runner.ts") &&
        command.includes(`${path.sep}data${path.sep}runs${path.sep}${workflowId}${path.sep}`),
    ).length;
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

    // 从发请求前就高频观察实际 argv；只有 10 个 runner.ts 子进程同时存在才算并行。
    let stopObserving = false;
    let maxConcurrentHarnesses = 0;
    const observer = (async () => {
      while (!stopObserving) {
        maxConcurrentHarnesses = Math.max(
          maxConcurrentHarnesses,
          harnessProcessesFor(workflowId),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();

    const runIds: string[] = [];
    const details = new Map<string, RunDetail>();
    try {
      // 同时发起 10 次运行——这是对外 API 的真实调用形态。
      const startResponses = await Promise.all(
        Array.from({ length: RUN_COUNT }, (_, i) =>
          request.post(`/api/workflows/${workflowId}/run`, {
            data: { inputs: { [inputNodeId]: { kind: "text", text: `并行验收 #${i + 1}` } } },
          }),
        ),
      );
      for (const res of startResponses) {
        expect(res.status()).toBe(200);
        runIds.push(((await res.json()) as { runId: string }).runId);
      }
      expect(new Set(runIds).size).toBe(RUN_COUNT);

      // 轮询到全部终态。10 个子进程同时冷启动（tsx 编译），给足预算。
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
        if (details.size < RUN_COUNT) await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      stopObserving = true;
      await observer;
    }

    // 全部成功，逐个核对：状态、无错误、文字输入物化为工作区文件后原样直通到
    // 输出节点（ADR-0012），正文经 files 预览通道逐字核对。
    for (const [runId, detail] of details) {
      const label = `运行 ${runId}`;
      expect(detail.run.status, `${label} 状态`).toBe("success");
      expect(detail.run.error, `${label} 错误`).toBeNull();
      const index = runIds.indexOf(runId);
      const outputNode = detail.nodes.find((n) => n.nodeId === outputNodeId);
      expect(outputNode?.status, `${label} 输出节点状态`).toBe("success");
      const value = outputNode?.outputs?.value;
      expect(value?.kind, `${label} 直通值应为文件引用`).toBe("file");
      expect(value?.file?.name, `${label} 物化文件按节点名命名`).toBe("输入.md");
      const fileRes = await request.get(
        `/api/runs/${runId}/files?path=${encodeURIComponent(value!.file!.path)}`,
      );
      expect(fileRes.ok(), `${label} 文件预览通道`).toBeTruthy();
      const fileBody = (await fileRes.json()) as { content?: string; truncated?: boolean };
      expect(fileBody.content, `${label} 物化正文`).toBe(`并行验收 #${index + 1}`);
      expect(fileBody.truncated).toBeFalsy();
      for (const node of detail.nodes) {
        expect(node.error, `${label} 节点 ${node.nodeId} 错误`).toBeNull();
      }
    }

    expect(maxConcurrentHarnesses, "实际同时存活的 harness 子进程数").toBe(RUN_COUNT);

    // 预览通道的安全与容量边界：不能跨运行读，软链不能绕过真实路径收敛，
    // 二进制拒绝，超大文本只返回固定大小前缀。
    const firstRunId = runIds[0];
    const secondRunId = runIds[1];
    const firstDetail = details.get(firstRunId)!;
    const secondDetail = details.get(secondRunId)!;
    const secondValue = secondDetail.nodes.find((n) => n.nodeId === outputNodeId)!
      .outputs!.value;
    const crossRun = await request.get(
      `/api/runs/${firstRunId}/files?path=${encodeURIComponent(secondValue.file!.path)}`,
    );
    expect(crossRun.status(), "不能用一个运行 id 读取另一个运行的文件").toBe(400);

    const dataRoot = path.join(process.cwd(), "data");
    const firstRunRoot = path.join(process.cwd(), firstDetail.run.runDir!);
    const secondFile = path.resolve(dataRoot, secondValue.file!.path);
    const symlink = path.join(firstRunRoot, "workspace", "cross-run-link.md");
    fs.symlinkSync(secondFile, symlink);
    const symlinkRes = await request.get(
      `/api/runs/${firstRunId}/files?path=${encodeURIComponent(path.relative(dataRoot, symlink))}`,
    );
    expect(symlinkRes.status(), "软链不能绕过运行目录边界").toBe(400);

    const binary = path.join(firstRunRoot, "workspace", "binary.bin");
    fs.writeFileSync(binary, Buffer.from([1, 0, 2]));
    const binaryRes = await request.get(
      `/api/runs/${firstRunId}/files?path=${encodeURIComponent(path.relative(dataRoot, binary))}`,
    );
    expect(binaryRes.status(), "二进制文件不进入文本预览").toBe(415);

    const oversized = path.join(firstRunRoot, "workspace", "oversized.txt");
    fs.writeFileSync(oversized, "x".repeat(262_145));
    const oversizedRes = await request.get(
      `/api/runs/${firstRunId}/files?path=${encodeURIComponent(path.relative(dataRoot, oversized))}`,
    );
    expect(oversizedRes.ok()).toBeTruthy();
    const oversizedBody = (await oversizedRes.json()) as {
      content: string;
      size: number;
      truncated: boolean;
    };
    expect(oversizedBody.content).toHaveLength(262_144);
    expect(oversizedBody.size).toBe(262_145);
    expect(oversizedBody.truncated).toBe(true);

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
