import type Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdminSession } from "@/lib/auth";
import { openDatabase } from "@/lib/db";
import { touchWorker } from "@/lib/jobs";
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
  mockedGetAdminSession.mockReset();
  mockedGetAdminSession.mockResolvedValue({
    userId,
    username: "admin",
    role: "admin",
    expiresAt: Date.now() + 60_000,
  });
});

afterEach(() => {
  globalThis.__codexExperimentDb = undefined;
  database.close();
});

function createRequest() {
  return new NextRequest("http://localhost:3000/api/tasks", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
    },
    body: JSON.stringify({
      recipient: "付方圆",
      message: "这是一条测试消息",
    }),
  });
}

describe("task creation API", () => {
  it("refuses to enqueue when no worker has a fresh heartbeat", async () => {
    const offlineResponse = await POST(createRequest());
    expect(offlineResponse.status).toBe(503);
    expect(await offlineResponse.json()).toEqual({
      error: "本机执行器当前离线或心跳已过期，请先启动执行器。",
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM message_jobs").get(),
    ).toEqual({ count: 0 });

    touchWorker("mac-1", "test");
    const onlineResponse = await POST(createRequest());
    expect(onlineResponse.status).toBe(201);
    expect(await onlineResponse.json()).toMatchObject({
      job: { status: "queued", attempts: 0 },
    });
  });
});
