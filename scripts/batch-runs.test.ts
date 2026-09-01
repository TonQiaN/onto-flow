import { describe, expect, it, vi } from "vitest";
import type { StartRunResult } from "../src/server/engine/runner";
import { requireWholeBatch } from "./batch-runs";

describe("付费批量运行准入", () => {
  it("全部受理时原样返回运行 id，不发取消", async () => {
    const cancelRun = vi.fn();
    await expect(
      requireWholeBatch(
        [
          { ok: true, runId: "run-1" },
          { ok: true, runId: "run-2" },
        ],
        { cancelRun, isRunExecutionActive: () => false },
      ),
    ).resolves.toEqual(["run-1", "run-2"]);
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it("部分拒绝时取消并等齐全部已受理运行后才报错", async () => {
    const active = new Set(["run-1", "run-3"]);
    const cancelRun = vi.fn(async (runId: string) => {
      active.delete(runId);
      return { ok: true as const };
    });
    const started: StartRunResult[] = [
      { ok: true, runId: "run-1" },
      { ok: false, status: 429, error: "并行运行已达上限" },
      { ok: true, runId: "run-3" },
    ];

    await expect(
      requireWholeBatch(started, {
        cancelRun,
        isRunExecutionActive: (runId) => active.has(runId),
        settleTimeoutMs: 20,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow("已取消并收束同批已受理的 2 个运行");
    expect(cancelRun.mock.calls.map(([runId]) => runId)).toEqual(["run-1", "run-3"]);
  });

  it("取消后执行器未退出时明确列出仍活动的运行", async () => {
    const started: StartRunResult[] = [
      { ok: true, runId: "run-stuck" },
      { ok: false, status: 422, error: "工作流校验未通过", issues: [] },
    ];

    await expect(
      requireWholeBatch(started, {
        cancelRun: async () => ({ ok: true }),
        isRunExecutionActive: () => true,
        settleTimeoutMs: 0,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow("1 个执行器在 0ms 内未退出：run-stuck");
  });
});
