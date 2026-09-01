import type {
  CancelRunResult,
  StartRunResult,
} from "../src/server/engine/runner";

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
    cancellationFailures.length === 0
      ? ""
      : `；取消调用异常：${cancellationFailures.join("；")}`;
  throw new Error(`${reason}；${cleanup}${cancellation}`);
}

/**
 * 批量准入必须全有或全撤：只要一项被 429/校验拒绝，就取消同批已受理运行并
 * 等执行器退出后再报错，避免付费脚本因 Promise.all 的部分成功留下无人照看的运行。
 */
export async function requireWholeBatch(
  started: readonly StartRunResult[],
  options: BatchCleanupOptions,
): Promise<string[]> {
  const rejected = started.flatMap((result, index) =>
    result.ok ? [] : [{ index, result }],
  );
  const runIds = started.flatMap((result) => (result.ok ? [result.runId] : []));
  if (rejected.length === 0) return runIds;

  const failures = rejected
    .map(({ index, result }) => `第 ${index + 1} 个运行启动失败：${JSON.stringify(result)}`)
    .join("；");
  return abortRunBatch(runIds, failures, options);
}
