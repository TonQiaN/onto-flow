import type Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdminSession } from "@/lib/auth";
import { openDatabase } from "@/lib/db";
import {
  claimNextJob,
  createJob,
  failJob,
  getJob,
  startSending,
  touchWorker,
} from "@/lib/jobs";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
}));

const userId = "00000000-0000-4000-8000-000000000001";
const mockedGetAdminSession = vi.mocked(getAdminSession);
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
  mockedGetAdminSession.mockReset();
});

afterEach(() => {
  globalThis.__codexExperimentDb = undefined;
  database.close();
});

function createManualReviewJob() {
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
  return job;
}

function resolutionRequest(jobId: string, resolution: "sent" | "not_sent") {
  return new NextRequest(
    `http://localhost:3000/api/tasks/${jobId}/resolve`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify({ resolution }),
    },
  );
}

describe("manual review resolution API", () => {
  it("rejects an unauthenticated resolution without changing the job", async () => {
    const job = createManualReviewJob();
    mockedGetAdminSession.mockResolvedValue(null);

    const response = await POST(resolutionRequest(job.id, "sent"), {
      params: Promise.resolve({ id: job.id }),
    });

    expect(response.status).toBe(401);
    expect(getJob(job.id)?.status).toBe("manual_review");
  });

  it("lets the authenticated admin record a terminal conclusion", async () => {
    const job = createManualReviewJob();
    mockedGetAdminSession.mockResolvedValue({
      userId,
      username: "admin",
      role: "admin",
      expiresAt: Date.now() + 60_000,
    });

    const response = await POST(resolutionRequest(job.id, "not_sent"), {
      params: Promise.resolve({ id: job.id }),
    });
    const payload = (await response.json()) as {
      job: { status: string; resultSummary: string };
    };

    expect(response.status).toBe(200);
    expect(payload.job).toMatchObject({
      status: "failed",
      resultSummary: expect.stringContaining("不会自动补发"),
    });
    expect(
      database
        .prepare(
          `SELECT actor_type, actor_id, event_type
           FROM audit_events
           WHERE job_id = ? AND event_type = 'job.manual_resolved_not_sent'`,
        )
        .get(job.id),
    ).toEqual({
      actor_type: "user",
      actor_id: userId,
      event_type: "job.manual_resolved_not_sent",
    });
  });
});
