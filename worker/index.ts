import { setTimeout as sleep } from "node:timers/promises";
import { WorkerApi, WorkerApiError, type WorkerClaim } from "./api-client";
import { CodexJobError, prepareCodexJob } from "./codex-runner";
import { getWorkerConfig } from "./config";
import { acquireWorkerLock } from "./lock";

const config = getWorkerConfig();
const api = new WorkerApi(config);
const releaseLock = await acquireWorkerLock();
let stopping = false;

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

async function handleJob(claim: WorkerClaim) {
  const { job, leaseToken } = claim;
  console.log(`[worker] claimed job ${job.id}`);
  let heartbeat: NodeJS.Timeout | undefined;
  let codexThreadId: string | undefined;
  let heartbeatFailures = 0;
  let irreversiblePhaseStarted = false;
  const leaseController = new AbortController();

  try {
    heartbeat = setInterval(() => {
      void api
        .heartbeat(job.id, leaseToken)
        .then(() => {
          heartbeatFailures = 0;
        })
        .catch((error) => {
          heartbeatFailures += 1;
          console.error(`[worker] heartbeat failed for ${job.id}`);
          if (
            (error instanceof WorkerApiError && error.status === 409) ||
            heartbeatFailures >= 2
          ) {
            leaseController.abort(
              new Error("Worker lease could not be maintained."),
            );
          }
        });
    }, 20_000);

    // Enter the non-retryable state before Codex can perform any GUI action,
    // including the recipient preflight. If the agent or desktop session
    // behaves unexpectedly, the job must require manual review rather than be
    // returned to the queue.
    await api.start(job.id, leaseToken);
    irreversiblePhaseStarted = true;
    const prepared = await prepareCodexJob(job, config);
    codexThreadId = prepared.threadId();
    if (leaseController.signal.aborted) {
      throw new CodexJobError(
        "Worker lease was lost before the send turn.",
        "uncertain",
        codexThreadId,
      );
    }
    const result = await prepared.send({ signal: leaseController.signal });
    codexThreadId = result.threadId ?? codexThreadId;

    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await api.complete(job.id, { ...result, leaseToken });
        console.log(`[worker] completed job ${job.id}`);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await sleep(attempt * 1500);
      }
    }
    throw new CodexJobError(
      lastError instanceof Error
        ? `Result upload failed: ${lastError.message}`
        : "Result upload failed.",
      "uncertain",
      codexThreadId,
    );
  } catch (error) {
    const certainty = irreversiblePhaseStarted
      ? "uncertain"
      : error instanceof CodexJobError
        ? error.certainty
        : "uncertain";
    const message =
      error instanceof Error ? error.message : "Unknown worker failure.";
    codexThreadId =
      error instanceof CodexJobError ? error.threadId : codexThreadId;
    console.error(`[worker] job ${job.id} ended as ${certainty}`);
    await api
      .fail(job.id, {
        certainty,
        leaseToken,
        error: message,
        codexThreadId,
      })
      .catch(() =>
        console.error(
          `[worker] could not report failure for ${job.id}; lease safety will apply`,
        ),
      );
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

try {
  console.log(`[worker] ${config.WORKER_ID} started`);
  do {
    try {
      const claim = await api.claim();
      if (claim) {
        await handleJob(claim);
      } else if (!config.WORKER_RUN_ONCE) {
        await sleep(config.POLL_INTERVAL_MS);
      }
    } catch {
      console.error("[worker] queue request failed");
      if (!config.WORKER_RUN_ONCE) {
        await sleep(Math.min(config.POLL_INTERVAL_MS * 2, 30_000));
      }
    }
  } while (!stopping && !config.WORKER_RUN_ONCE);
} finally {
  await releaseLock();
  console.log("[worker] stopped");
}
