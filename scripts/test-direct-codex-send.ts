import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { PublicJob } from "../src/lib/api-types";
import { prepareCodexJob } from "../worker/codex-runner";
import { getWorkerConfig } from "../worker/config";
import { acquireWorkerLock } from "../worker/lock";

const outputDirectory = path.resolve(".data", "direct-test");

async function assertNoUnresolvedDirectRun(): Promise<void> {
  const entries = await readdir(outputDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const pathname = path.join(outputDirectory, entry.name);
    const value = JSON.parse(await readFile(pathname, "utf8")) as {
      jobId?: unknown;
      status?: unknown;
    };
    if (
      value.status === "preflight_started" ||
      value.status === "send_started" ||
      value.status === "manual_review"
    ) {
      throw new Error(
        `Direct test ${String(value.jobId ?? entry.name)} has an unresolved send outcome. Manually inspect WeLink and resolve that run before starting another direct send.`,
      );
    }
  }
}

async function main() {
  const releaseLock = await acquireWorkerLock();
  try {
    const config = getWorkerConfig();
    const now = Date.now();
    const job: PublicJob = {
      id: randomUUID(),
      recipient: "付方圆",
      message: "这是一条测试消息",
      status: "claimed",
      attempts: 1,
      errorMessage: null,
      resultSummary: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      screenshotUrl: null,
    };

    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    await assertNoUnresolvedDirectRun();
    const runStatePath = path.join(outputDirectory, `${job.id}.json`);
    const messageSha256 = createHash("sha256")
      .update(job.message, "utf8")
      .digest("hex");

    async function writeRunState(
      status:
        | "preflight_started"
        | "preflight_only"
        | "send_started"
        | "succeeded"
        | "manual_review",
      extra: Record<string, unknown> = {},
    ) {
      const temporaryPath = `${runStatePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporaryPath,
          `${JSON.stringify(
            {
              jobId: job.id,
              recipient: job.recipient,
              messageSha256,
              status,
              updatedAt: new Date().toISOString(),
              ...extra,
            },
            null,
            2,
          )}\n`,
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        );
        await rename(temporaryPath, runStatePath);
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    }

    await writeRunState("preflight_started");
    console.log(`[direct-test] preflight started for ${job.recipient}`);
    const prepared = await prepareCodexJob(job, config);
    if (process.env.DIRECT_PREFLIGHT_ONLY === "true") {
      await writeRunState("preflight_only", {
        codexThreadId: prepared.threadId() ?? null,
      });
      console.log("[direct-test] preflight passed; no message was sent");
      return;
    }

    await writeRunState("send_started", {
      codexThreadId: prepared.threadId() ?? null,
    });
    console.log("[direct-test] preflight passed; starting one authorized send");
    let result: Awaited<ReturnType<typeof prepared.send>>;
    try {
      result = await prepared.send();
    } catch (error) {
      await writeRunState("manual_review", {
        codexThreadId: prepared.threadId() ?? null,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }

    const extension = result.mime === "image/png" ? "png" : "jpg";
    const outputPath = path.join(outputDirectory, `${job.id}.${extension}`);
    await writeFile(outputPath, result.screenshot, {
      flag: "wx",
      mode: 0o600,
    });
    await writeRunState("succeeded", {
      codexThreadId: result.threadId ?? null,
      screenshotFile: path.basename(outputPath),
      screenshotMime: result.mime,
    });

    console.log(`[direct-test] sent and saved evidence: ${outputPath}`);
    console.log(`[direct-test] codex thread: ${result.threadId ?? "unavailable"}`);
  } finally {
    await releaseLock();
  }
}

await main();
