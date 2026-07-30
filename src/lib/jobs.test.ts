import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db";
import {
  ActiveJobExistsError,
  claimNextJob,
  completeJob,
  createJob,
  failJob,
  getJob,
  heartbeatJob,
  QUEUED_JOB_TTL_MS,
  resolveManualReview,
  startSending,
  touchWorker,
  WORKER_FRESHNESS_MS,
  WorkerUnavailableError,
} from "@/lib/jobs";

const userId = "00000000-0000-4000-8000-000000000001";
let database: Database.Database;

beforeEach(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATA_DIR: ".data-test",
    NEXT_PUBLIC_BASE_PATH: "",
    PUBLIC_APP_URL: "http://localhost:3000",
    SESSION_COOKIE_SECURE: "false",
    TRUSTED_ORIGINS: "http://localhost:3000",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD_HASH:
      "$2b$12$TU5.nAhMgEIn9awk6Vx.Tu3xPuTlFQ2ctdTOLY8SOTJJuY77OV.Ey",
    WORKER_TOKEN_SHA256: "a".repeat(64),
    WORKER_LEASE_SECONDS: "60",
    SCREENSHOT_MAX_BYTES: "8388608",
  });
  database = openDatabase(":memory:");
  database
    .prepare(
      `INSERT INTO users
       (id, username, password_hash, role, created_at, updated_at)
       VALUES (?, 'admin', ?, 'admin', 1, 1)`,
    )
    .run(userId, process.env.ADMIN_PASSWORD_HASH);
  globalThis.__codexExperimentDb = database;
  touchWorker("mac-1", "test");
});

afterEach(() => {
  globalThis.__codexExperimentDb = undefined;
  database.close();
});

describe("message job state machine", () => {
  it("requires a fresh worker heartbeat before creating a job", () => {
    database.prepare("DELETE FROM worker_presence").run();
    expect(() =>
      createJob({
        userId,
        recipient: "付方圆",
        message: "这是一条测试消息",
      }),
    ).toThrow(WorkerUnavailableError);

    database
      .prepare(
        `INSERT INTO worker_presence
          (worker_id, last_seen_at, current_job_id, version)
         VALUES ('stale-worker', ?, NULL, 'test')`,
      )
      .run(Date.now() - WORKER_FRESHNESS_MS);
    expect(() =>
      createJob({
        userId,
        recipient: "付方圆",
        message: "这是一条测试消息",
      }),
    ).toThrow(WorkerUnavailableError);

    touchWorker("mac-1", "test");
    expect(
      createJob({
        userId,
        recipient: "付方圆",
        message: "这是一条测试消息",
      }).status,
    ).toBe("queued");
  });

  it("moves one job through claim, sending, and evidence-backed success", () => {
    const created = createJob({
      userId,
      recipient: "付方圆",
      message: "这是一条测试消息",
    });
    expect(created.status).toBe("queued");

    const claimed = claimNextJob("mac-1")!;
    expect(claimed.job.id).toBe(created.id);
    expect(claimed.job.status).toBe("claimed");
    expect(claimed.job.attempts).toBe(1);

    expect(startSending(created.id, "wrong-worker", claimed.leaseToken)).toBeNull();
    expect(startSending(created.id, "mac-1", "wrong-token".padEnd(32, "x"))).toBeNull();
    expect(
      startSending(created.id, "mac-1", claimed.leaseToken)?.status,
    ).toBe("sending");

    const completed = completeJob({
      jobId: created.id,
      workerId: "mac-1",
      leaseToken: claimed.leaseToken,
      filename: `${created.id}.png`,
      mime: "image/png",
      digest: "b".repeat(64),
      summary: "已确认发送。",
    });
    expect(completed?.status).toBe("succeeded");
    expect(completed?.screenshotSha256).toBe("b".repeat(64));
  });

  it("allows only one active desktop task", () => {
    createJob({
      userId,
      recipient: "付方圆",
      message: "第一条",
    });
    expect(() =>
      createJob({
        userId,
        recipient: "付方圆",
        message: "第二条",
      }),
    ).toThrow(ActiveJobExistsError);
  });

  it("never requeues a job whose send may already have started", () => {
    const job = createJob({
      userId,
      recipient: "付方圆",
      message: "这是一条测试消息",
    });
    const claim = claimNextJob("mac-1")!;
    startSending(job.id, "mac-1", claim.leaseToken);
    database
      .prepare("UPDATE message_jobs SET lease_until = ? WHERE id = ?")
      .run(Date.now() - 1, job.id);

    expect(claimNextJob("mac-2")).toBeNull();
    expect(getJob(job.id)?.status).toBe("manual_review");
  });

  it("can safely reclaim a lease that expired before sending started", () => {
    const job = createJob({
      userId,
      recipient: "付方圆",
      message: "这是一条测试消息",
    });
    const firstClaim = claimNextJob("mac-1")!;
    database
      .prepare("UPDATE message_jobs SET lease_until = ? WHERE id = ?")
      .run(Date.now() - 1, job.id);

    const reclaimed = claimNextJob("mac-2");
    expect(reclaimed?.job.id).toBe(job.id);
    expect(reclaimed?.job.workerId).toBe("mac-2");
    expect(reclaimed?.job.attempts).toBe(2);
    expect(reclaimed?.leaseToken).not.toBe(firstClaim.leaseToken);
  });

  it("rejects stale fencing tokens after a lease is reclaimed", () => {
    const job = createJob({
      userId,
      recipient: "付方圆",
      message: "这是一条测试消息",
    });
    const first = claimNextJob("mac-1")!;
    database
      .prepare("UPDATE message_jobs SET lease_until = ? WHERE id = ?")
      .run(Date.now() - 1, job.id);
    const second = claimNextJob("mac-1")!;

    expect(startSending(job.id, "mac-1", first.leaseToken)).toBeNull();
    expect(startSending(job.id, "mac-1", second.leaseToken)?.status).toBe(
      "sending",
    );
  });

  it("expires a stale queued job instead of allowing a worker to claim it", () => {
    const job = createJob({
      userId,
      recipient: "付方圆",
      message: "这是一条测试消息",
    });
    database
      .prepare("UPDATE message_jobs SET created_at = ? WHERE id = ?")
      .run(Date.now() - QUEUED_JOB_TTL_MS - 1, job.id);

    expect(claimNextJob("mac-2")).toBeNull();
    expect(getJob(job.id)).toMatchObject({
      status: "failed",
      attempts: 0,
      resultSummary: expect.stringContaining("不会自动补发"),
    });
    expect(
      database
        .prepare(
          `SELECT actor_type, actor_id, event_type
           FROM audit_events
           WHERE job_id = ? AND event_type = 'job.queue_expired'`,
        )
        .get(job.id),
    ).toEqual({
      actor_type: "system",
      actor_id: "queue-expirer",
      event_type: "job.queue_expired",
    });
  });

  it("lets an admin terminate manual review as not sent without requeueing", () => {
      const job = createJob({
        userId,
        recipient: "付方圆",
        message: "这是一条测试消息",
      });
      const claim = claimNextJob("mac-1")!;
      startSending(job.id, "mac-1", claim.leaseToken);
      expect(
        failJob({
          jobId: job.id,
          workerId: "mac-1",
          leaseToken: claim.leaseToken,
          certainty: "uncertain",
          error: "Send result could not be verified.",
        })?.status,
      ).toBe("manual_review");

      const resolved = resolveManualReview({
        jobId: job.id,
        userId,
        resolution: "not_sent",
      });
      expect(resolved).toMatchObject({
        status: "failed",
        resultSummary: expect.stringContaining("不会"),
        errorMessage: null,
      });
      expect(
        database
          .prepare(
            `SELECT actor_type, actor_id, event_type, metadata_json
             FROM audit_events
             WHERE job_id = ? AND event_type = ?`,
          )
          .get(job.id, "job.manual_resolved_not_sent"),
      ).toEqual({
        actor_type: "user",
        actor_id: userId,
        event_type: "job.manual_resolved_not_sent",
        metadata_json: JSON.stringify({ resolution: "not_sent" }),
      });
      expect(
        resolveManualReview({
          jobId: job.id,
          userId,
          resolution: "not_sent",
        }),
      ).toBeNull();
      expect(claimNextJob("mac-2")).toBeNull();
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM message_jobs")
          .get(),
      ).toEqual({ count: 1 });
  });

  it("records a sanitized screenshot when manual review is resolved as sent", () => {
    const job = createJob({
      userId,
      recipient: "付方圆",
      message: "这是一条测试消息",
    });
    const claim = claimNextJob("mac-1")!;
    startSending(job.id, "mac-1", claim.leaseToken);
    failJob({
      jobId: job.id,
      workerId: "mac-1",
      leaseToken: claim.leaseToken,
      certainty: "uncertain",
      error: "Send result could not be verified.",
    });

    const screenshot = {
      filename: `${job.id}.abcdefghijklmnop.jpg`,
      mime: "image/jpeg" as const,
      digest: "b".repeat(64),
    };
    expect(
      resolveManualReview({
        jobId: job.id,
        userId,
        resolution: "sent",
        screenshot,
      }),
    ).toMatchObject({
      status: "succeeded",
      screenshotFilename: screenshot.filename,
      screenshotMime: screenshot.mime,
      screenshotSha256: screenshot.digest,
      resultSummary: expect.stringContaining("独立截图证据"),
    });
    expect(
      database
        .prepare(
          `SELECT metadata_json FROM audit_events
           WHERE job_id = ? AND event_type = 'job.manual_resolved_sent'`,
        )
        .get(job.id),
    ).toEqual({
      metadata_json: JSON.stringify({
        resolution: "sent",
        screenshotSha256: screenshot.digest,
      }),
    });
  });

  it("refreshes worker presence only when a heartbeat renews the lease", () => {
    const job = createJob({
      userId,
      recipient: "付方圆",
      message: "这是一条测试消息",
    });
    const claim = claimNextJob("mac-1")!;
    database
      .prepare(
        `UPDATE worker_presence
         SET last_seen_at = 123, current_job_id = 'unchanged'
         WHERE worker_id = 'mac-1'`,
      )
      .run();

    expect(heartbeatJob(job.id, "mac-1", "x".repeat(32))).toBe(false);
    expect(
      database
        .prepare(
          `SELECT last_seen_at, current_job_id
           FROM worker_presence WHERE worker_id = 'mac-1'`,
        )
        .get(),
    ).toEqual({ last_seen_at: 123, current_job_id: "unchanged" });

    expect(heartbeatJob(job.id, "mac-1", claim.leaseToken)).toBe(true);
    expect(
      database
        .prepare(
          `SELECT last_seen_at, current_job_id
           FROM worker_presence WHERE worker_id = 'mac-1'`,
        )
        .get(),
    ).toMatchObject({ current_job_id: job.id });
  });
});
