import { randomUUID } from "node:crypto";
import { randomToken, sha256 } from "@/lib/crypto";
import { getDb, type AppDatabase } from "@/lib/db";
import { getServerConfig } from "@/lib/env";

export const jobStatuses = [
  "queued",
  "claimed",
  "sending",
  "succeeded",
  "failed",
  "manual_review",
] as const;

export type JobStatus = (typeof jobStatuses)[number];

export const WORKER_FRESHNESS_MS = 30_000;
export const QUEUED_JOB_TTL_MS = 60_000;

export type MessageJob = {
  id: string;
  recipient: string;
  message: string;
  status: JobStatus;
  attempts: number;
  workerId: string | null;
  leaseUntil: number | null;
  screenshotFilename: string | null;
  screenshotMime: string | null;
  screenshotSha256: string | null;
  codexThreadId: string | null;
  resultSummary: string | null;
  errorMessage: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
};

export type ClaimedMessageJob = {
  job: MessageJob;
  leaseToken: string;
};

export class ActiveJobExistsError extends Error {
  constructor() {
    super("A message job is already active.");
    this.name = "ActiveJobExistsError";
  }
}

export class WorkerUnavailableError extends Error {
  constructor() {
    super("No fresh worker heartbeat is available.");
    this.name = "WorkerUnavailableError";
  }
}

type JobRow = {
  id: string;
  recipient: string;
  message: string;
  status: JobStatus;
  attempts: number;
  worker_id: string | null;
  lease_until: number | null;
  screenshot_filename: string | null;
  screenshot_mime: string | null;
  screenshot_sha256: string | null;
  codex_thread_id: string | null;
  result_summary: string | null;
  error_message: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
};

function mapJob(row: JobRow): MessageJob {
  return {
    id: row.id,
    recipient: row.recipient,
    message: row.message,
    status: row.status,
    attempts: row.attempts,
    workerId: row.worker_id,
    leaseUntil: row.lease_until,
    screenshotFilename: row.screenshot_filename,
    screenshotMime: row.screenshot_mime,
    screenshotSha256: row.screenshot_sha256,
    codexThreadId: row.codex_thread_id,
    resultSummary: row.result_summary,
    errorMessage: row.error_message,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function recordAudit(
  database: AppDatabase,
  actorType: "user" | "worker" | "system",
  actorId: string,
  eventType: string,
  jobId: string | null,
  metadata?: Record<string, unknown>,
): void {
  database
    .prepare(
      `INSERT INTO audit_events
        (actor_type, actor_id, event_type, job_id, created_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      actorType,
      actorId,
      eventType,
      jobId,
      Date.now(),
      metadata ? JSON.stringify(metadata) : null,
    );
}

function expireQueuedJobs(database: AppDatabase, now: number): void {
  const cutoff = now - QUEUED_JOB_TTL_MS;
  const expired = database
    .prepare(
      `SELECT id FROM message_jobs
       WHERE status = 'queued' AND created_at <= ?`,
    )
    .all(cutoff) as Array<{ id: string }>;

  if (!expired.length) return;

  database
    .prepare(
      `UPDATE message_jobs
       SET status = 'failed',
           lease_token_hash = NULL,
           lease_until = NULL,
           updated_at = ?,
           completed_at = ?,
           result_summary = '任务等待执行器领取时已过期，已终结且不会自动补发。',
           error_message = NULL
       WHERE status = 'queued' AND created_at <= ?`,
    )
    .run(now, now, cutoff);

  for (const row of expired) {
    recordAudit(database, "system", "queue-expirer", "job.queue_expired", row.id, {
      reason: "queue_ttl_expired",
      ttlMs: QUEUED_JOB_TTL_MS,
    });
  }
}

export function createJob(input: {
  recipient: string;
  message: string;
  userId: string;
}): MessageJob {
  const database = getDb();
  const id = randomUUID();
  const now = Date.now();

  const transaction = database.transaction(() => {
    expireQueuedJobs(database, now);

    const active = database
      .prepare(
        `SELECT id FROM message_jobs
         WHERE status IN ('queued', 'claimed', 'sending', 'manual_review')
         LIMIT 1`,
      )
      .get();
    if (active) throw new ActiveJobExistsError();

    const worker = database
      .prepare(
        `SELECT last_seen_at
         FROM worker_presence
         ORDER BY last_seen_at DESC
         LIMIT 1`,
      )
      .get() as { last_seen_at: number } | undefined;
    if (!worker || now - worker.last_seen_at >= WORKER_FRESHNESS_MS) {
      throw new WorkerUnavailableError();
    }

    database
      .prepare(
        `INSERT INTO message_jobs (
          id, recipient, message, status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(id, input.recipient, input.message, input.userId, now, now);
    recordAudit(database, "user", input.userId, "job.created", id);
  });
  transaction.immediate();

  return getJob(id)!;
}

export function getJob(id: string): MessageJob | null {
  const row = getDb()
    .prepare("SELECT * FROM message_jobs WHERE id = ?")
    .get(id) as JobRow | undefined;
  return row ? mapJob(row) : null;
}

export function listJobs(limit = 20): MessageJob[] {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const database = getDb();
  database.transaction(() => expireQueuedJobs(database, Date.now())).immediate();
  const rows = database
    .prepare(
      `SELECT * FROM message_jobs
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(safeLimit) as JobRow[];
  return rows.map(mapJob);
}

function updateWorkerPresence(
  database: AppDatabase,
  workerId: string,
  currentJobId: string | null,
  version?: string,
): void {
  database
    .prepare(
      `INSERT INTO worker_presence
        (worker_id, last_seen_at, current_job_id, version)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(worker_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         current_job_id = excluded.current_job_id,
         version = COALESCE(excluded.version, worker_presence.version)`,
    )
    .run(workerId, Date.now(), currentJobId, version ?? null);
}

export function touchWorker(
  workerId: string,
  version?: string,
): void {
  updateWorkerPresence(getDb(), workerId, null, version);
}

export function claimNextJob(
  workerId: string,
  version?: string,
): ClaimedMessageJob | null {
  const database = getDb();
  const now = Date.now();
  const leaseUntil = now + getServerConfig().WORKER_LEASE_SECONDS * 1000;
  const leaseToken = randomToken();
  const leaseTokenHash = sha256(leaseToken);

  const transaction = database.transaction(() => {
    database
      .prepare(
        `UPDATE message_jobs
         SET status = 'queued',
             worker_id = NULL,
             lease_token_hash = NULL,
             lease_until = NULL,
             updated_at = ?,
             error_message = 'Worker lease expired before sending started.'
         WHERE status = 'claimed' AND lease_until < ?`,
      )
      .run(now, now);

    expireQueuedJobs(database, now);

    const uncertain = database
      .prepare(
        `SELECT id FROM message_jobs
         WHERE status = 'sending' AND lease_until < ?`,
      )
      .all(now) as Array<{ id: string }>;
    database
      .prepare(
        `UPDATE message_jobs
         SET status = 'manual_review',
             lease_token_hash = NULL,
             lease_until = NULL,
             updated_at = ?,
             completed_at = ?,
             error_message = 'Worker lease expired after sending started; not retried.'
         WHERE status = 'sending' AND lease_until < ?`,
      )
      .run(now, now, now);
    for (const row of uncertain) {
      recordAudit(
        database,
        "system",
        "lease-reaper",
        "job.manual_review",
        row.id,
        { reason: "sending_lease_expired" },
      );
    }

    const row = database
      .prepare(
        `SELECT * FROM message_jobs
         WHERE status = 'queued'
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get() as JobRow | undefined;

    if (!row) {
      updateWorkerPresence(database, workerId, null, version);
      return null;
    }

    database
      .prepare(
        `UPDATE message_jobs
         SET status = 'claimed',
             attempts = attempts + 1,
             worker_id = ?,
             lease_token_hash = ?,
             lease_until = ?,
             updated_at = ?,
             error_message = NULL
         WHERE id = ? AND status = 'queued'`,
      )
      .run(workerId, leaseTokenHash, leaseUntil, now, row.id);
    updateWorkerPresence(database, workerId, row.id, version);
    recordAudit(database, "worker", workerId, "job.claimed", row.id);

    return {
      job: getJob(row.id)!,
      leaseToken,
    };
  });

  return transaction.immediate();
}

export function startSending(
  jobId: string,
  workerId: string,
  leaseToken: string,
): MessageJob | null {
  const database = getDb();
  const now = Date.now();
  const leaseUntil = now + getServerConfig().WORKER_LEASE_SECONDS * 1000;
  const leaseTokenHash = sha256(leaseToken);
  const transaction = database.transaction(() => {
    const result = database
      .prepare(
        `UPDATE message_jobs
         SET status = 'sending',
             started_at = COALESCE(started_at, ?),
             updated_at = ?,
             lease_until = ?
         WHERE id = ?
           AND status = 'claimed'
           AND worker_id = ?
           AND lease_token_hash = ?
           AND lease_until >= ?`,
      )
      .run(
        now,
        now,
        leaseUntil,
        jobId,
        workerId,
        leaseTokenHash,
        now,
      );
    if (result.changes !== 1) return null;
    recordAudit(database, "worker", workerId, "job.sending", jobId);
    return getJob(jobId);
  });
  return transaction.immediate();
}

export function heartbeatJob(
  jobId: string,
  workerId: string,
  leaseToken: string,
): boolean {
  const database = getDb();
  const now = Date.now();
  const leaseUntil = now + getServerConfig().WORKER_LEASE_SECONDS * 1000;
  const leaseTokenHash = sha256(leaseToken);
  const transaction = database.transaction(() => {
    const result = database
      .prepare(
        `UPDATE message_jobs
         SET lease_until = ?, updated_at = ?
         WHERE id = ?
           AND worker_id = ?
           AND lease_token_hash = ?
           AND lease_until >= ?
           AND status IN ('claimed', 'sending')`,
      )
      .run(leaseUntil, now, jobId, workerId, leaseTokenHash, now);
    if (result.changes !== 1) return false;
    updateWorkerPresence(database, workerId, jobId);
    return true;
  });
  return transaction.immediate();
}

export function hasActiveJobLease(
  jobId: string,
  workerId: string,
  leaseToken: string,
  status: "claimed" | "sending",
): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 AS active
       FROM message_jobs
       WHERE id = ?
         AND worker_id = ?
         AND lease_token_hash = ?
         AND lease_until >= ?
         AND status = ?`,
    )
    .get(jobId, workerId, sha256(leaseToken), Date.now(), status) as
    | { active: 1 }
    | undefined;
  return row?.active === 1;
}

export function completeJob(input: {
  jobId: string;
  workerId: string;
  leaseToken: string;
  filename: string;
  mime: string;
  digest: string;
  codexThreadId?: string;
  summary?: string;
}): MessageJob | null {
  const database = getDb();
  const now = Date.now();
  const leaseTokenHash = sha256(input.leaseToken);
  const transaction = database.transaction(() => {
    const result = database
      .prepare(
        `UPDATE message_jobs
         SET status = 'succeeded',
             screenshot_filename = ?,
             screenshot_mime = ?,
             screenshot_sha256 = ?,
             codex_thread_id = ?,
             result_summary = ?,
             error_message = NULL,
             lease_token_hash = NULL,
             lease_until = NULL,
             updated_at = ?,
             completed_at = ?
         WHERE id = ?
           AND status = 'sending'
           AND worker_id = ?
           AND lease_token_hash = ?
           AND lease_until >= ?`,
      )
      .run(
        input.filename,
        input.mime,
        input.digest,
        input.codexThreadId ?? null,
        input.summary?.slice(0, 2000) ?? null,
        now,
        now,
        input.jobId,
        input.workerId,
        leaseTokenHash,
        now,
      );
    if (result.changes !== 1) return null;
    updateWorkerPresence(database, input.workerId, null);
    recordAudit(database, "worker", input.workerId, "job.succeeded", input.jobId, {
      screenshotSha256: input.digest,
    });
    return getJob(input.jobId);
  });
  return transaction.immediate();
}

export function failJob(input: {
  jobId: string;
  workerId: string;
  leaseToken: string;
  certainty: "not_sent" | "uncertain";
  error: string;
  codexThreadId?: string;
}): MessageJob | null {
  const database = getDb();
  const now = Date.now();
  const leaseTokenHash = sha256(input.leaseToken);
  const status = input.certainty === "uncertain" ? "manual_review" : "failed";
  const transaction = database.transaction(() => {
    const result = database
      .prepare(
        `UPDATE message_jobs
         SET status = ?,
             error_message = ?,
             codex_thread_id = COALESCE(?, codex_thread_id),
             lease_token_hash = NULL,
             lease_until = NULL,
             updated_at = ?,
             completed_at = ?
         WHERE id = ?
           AND worker_id = ?
           AND lease_token_hash = ?
           AND lease_until >= ?
           AND status IN ('claimed', 'sending')`,
      )
      .run(
        status,
        input.error.slice(0, 2000),
        input.codexThreadId ?? null,
        now,
        now,
        input.jobId,
        input.workerId,
        leaseTokenHash,
        now,
      );
    if (result.changes !== 1) return null;
    updateWorkerPresence(database, input.workerId, null);
    recordAudit(database, "worker", input.workerId, `job.${status}`, input.jobId, {
      certainty: input.certainty,
    });
    return getJob(input.jobId);
  });
  return transaction.immediate();
}

export type ManualReviewResolution = "sent" | "not_sent";

export function resolveManualReview(input: {
  jobId: string;
  userId: string;
  resolution: ManualReviewResolution;
}): MessageJob | null {
  const database = getDb();
  const now = Date.now();
  const status: JobStatus =
    input.resolution === "sent" ? "succeeded" : "failed";
  const summary =
    input.resolution === "sent"
      ? "管理员人工核对：消息已发送。任务已终结，不会触发补发。"
      : "管理员人工核对：消息未发送。任务已终结，不会自动补发。";

  const transaction = database.transaction(() => {
    const result = database
      .prepare(
        `UPDATE message_jobs
         SET status = ?,
             lease_token_hash = NULL,
             lease_until = NULL,
             result_summary = ?,
             error_message = NULL,
             updated_at = ?,
             completed_at = ?
         WHERE id = ? AND status = 'manual_review'`,
      )
      .run(status, summary, now, now, input.jobId);
    if (result.changes !== 1) return null;

    recordAudit(
      database,
      "user",
      input.userId,
      `job.manual_resolved_${input.resolution}`,
      input.jobId,
      { resolution: input.resolution },
    );
    return getJob(input.jobId);
  });
  return transaction.immediate();
}

export function workerSummary(): {
  online: boolean;
  workerId: string | null;
  lastSeenAt: number | null;
  currentJobId: string | null;
} {
  const row = getDb()
    .prepare(
      `SELECT worker_id, last_seen_at, current_job_id
       FROM worker_presence
       ORDER BY last_seen_at DESC
       LIMIT 1`,
    )
    .get() as
    | {
        worker_id: string;
        last_seen_at: number;
        current_job_id: string | null;
      }
    | undefined;

  if (!row) {
    return {
      online: false,
      workerId: null,
      lastSeenAt: null,
      currentJobId: null,
    };
  }

  return {
    online: Date.now() - row.last_seen_at < WORKER_FRESHNESS_MS,
    workerId: row.worker_id,
    lastSeenAt: row.last_seen_at,
    currentJobId: row.current_job_id,
  };
}
