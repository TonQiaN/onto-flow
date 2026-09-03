import type { CancelRunResult, StartRunResult } from "../src/server/engine/runner";

interface BatchCleanupOptions {
  cancelRun: (runId: string) => Promise<CancelRunResult>;
  isRunExecutionActive: (runId: string) => boolean;
  settleTimeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * 终止一批已经受理的付费运行，并等到执行器不再持有它们后才把失败交还调用方。
 * 准入部分失败与脚本等待超时共用这一条收束路径，不能留下无人照看的模型请求。
 */
export async function abortRunBatch(
  runIds: readonly string[],
  reason: string,
  options: BatchCleanupOptions,
): Promise<never> {
  const cancellationFailures: string[] = [];
  await Promise.all(
    runIds.map(async (runId) => {
      try {
        const cancelled = await options.cancelRun(runId);
        // 409 表示抢在取消前已经自然收束，404 表示记录已不在；两者都不再运行。
        if (!cancelled.ok && cancelled.status !== 409 && cancelled.status !== 404) {
          cancellationFailures.push(`${runId}: ${cancelled.error}`);
        }
      } catch (error) {
        cancellationFailures.push(
          `${runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );

  const timeoutMs = options.settleTimeoutMs ?? 60_000;
  const pollMs = options.pollIntervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let active = runIds.filter(options.isRunExecutionActive);
  while (active.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    active = runIds.filter(options.isRunExecutionActive);
  }

  const cleanup =
    runIds.length === 0
      ? "本批没有已受理运行"
      : active.length === 0
        ? `已取消并收束同批已受理的 ${runIds.length} 个运行`
        : `已请求取消，但 ${active.length} 个执行器在 ${timeoutMs}ms 内未退出：${active.join(", ")}`;
  const cancellation =
    cancellationFailures.length === 0 ? "" : `；取消调用异常：${cancellationFailures.join("；")}`;
  throw new Error(`${reason}；${cleanup}${cancellation}`);
}

/**
 * 批量准入必须全有或全撤：同时等待每个启动 Promise，无论其中一项返回拒绝还是
 * 直接抛错，都保留其他已受理的 runId，取消并等执行器退出后才把失败交还调用方。
 */
export async function admitWholeBatch(
  starts: readonly Promise<StartRunResult>[],
  options: BatchCleanupOptions,
): Promise<string[]> {
  const settled = await Promise.allSettled(starts);
  const failures = settled.flatMap((entry, index) => {
    if (entry.status === "rejected") {
      const reason = entry.reason instanceof Error ? entry.reason.message : String(entry.reason);
      return [`第 ${index + 1} 个运行启动异常：${reason}`];
    }
    return entry.value.ok ? [] : [`第 ${index + 1} 个运行启动失败：${JSON.stringify(entry.value)}`];
  });
  const runIds = settled.flatMap((entry) =>
    entry.status === "fulfilled" && entry.value.ok ? [entry.value.runId] : [],
  );
  if (failures.length === 0) return runIds;
  return abortRunBatch(runIds, failures.join("；"), options);
}
