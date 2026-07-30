import type Database from "better-sqlite3";
import { hashSync } from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticateAdmin,
  createAdminSession,
  getAdminSession,
  SESSION_COOKIE_NAME,
} from "@/lib/auth";
import { sha256 } from "@/lib/crypto";
import { openDatabase } from "@/lib/db";

const cookieValues = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieValues.get(name);
      return value ? { name, value } : undefined;
    },
    set: (name: string, value: string) => {
      cookieValues.set(name, value);
    },
    delete: (name: string) => {
      cookieValues.delete(name);
    },
  }),
}));

let database: Database.Database;

beforeEach(() => {
  cookieValues.clear();
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATA_DIR: ".data-test",
    NEXT_PUBLIC_BASE_PATH: "",
    PUBLIC_APP_URL: "http://localhost:3000",
    SESSION_COOKIE_SECURE: "false",
    TRUST_PROXY_HEADERS: "false",
    TRUSTED_ORIGINS: "http://localhost:3000",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD_HASH: hashSync("initial-password", 4),
    WORKER_TOKEN_SHA256: "a".repeat(64),
    WORKER_LEASE_SECONDS: "60",
    SCREENSHOT_MAX_BYTES: "8388608",
    SCREENSHOT_MAX_WIDTH: "4096",
    SCREENSHOT_MAX_HEIGHT: "4096",
    SCREENSHOT_MAX_PIXELS: "16777216",
  });
  database = openDatabase(":memory:");
  globalThis.__codexExperimentDb = database;
});

afterEach(() => {
  globalThis.__codexExperimentDb = undefined;
  database.close();
});

describe("administrator authentication", () => {
  it("revokes existing sessions when the configured password hash changes", async () => {
    const authenticated = await authenticateAdmin(
      "admin",
      "initial-password",
      "127.0.0.1",
    );
    expect(authenticated.ok).toBe(true);
    if (!authenticated.ok) throw new Error("Expected authentication to pass.");

    await createAdminSession(authenticated.user);
    expect(cookieValues.has(SESSION_COOKIE_NAME)).toBe(true);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM sessions").get(),
    ).toEqual({ count: 1 });

    const replacementHash = hashSync("replacement-password", 4);
    process.env.ADMIN_PASSWORD_HASH = replacementHash;

    expect(await getAdminSession()).toBeNull();
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM sessions").get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare("SELECT password_hash FROM users WHERE username = 'admin'")
        .get(),
    ).toEqual({ password_hash: replacementHash });
  });

  it("rate limits an account across distinct client IPs", async () => {
    let finalResult: Awaited<ReturnType<typeof authenticateAdmin>> | undefined;
    for (let index = 0; index < 10; index += 1) {
      finalResult = await authenticateAdmin(
        "admin",
        "wrong-password",
        `192.0.2.${index + 1}`,
      );
    }

    expect(finalResult).toMatchObject({
      ok: false,
      blockedUntil: expect.any(Number),
    });
    expect(
      await authenticateAdmin(
        "admin",
        "initial-password",
        "198.51.100.1",
      ),
    ).toMatchObject({
      ok: false,
      blockedUntil: expect.any(Number),
    });
  });

  it("rate limits repeated attempts for one IP and account pair", async () => {
    let finalResult: Awaited<ReturnType<typeof authenticateAdmin>> | undefined;
    for (let index = 0; index < 5; index += 1) {
      finalResult = await authenticateAdmin(
        "admin",
        "wrong-password",
        "192.0.2.1",
      );
    }
    expect(finalResult).toMatchObject({
      ok: false,
      blockedUntil: expect.any(Number),
    });
  });

  it("rate limits password spraying from one client IP", async () => {
    const ipAddress = "192.0.2.20";
    database
      .prepare(
        `INSERT INTO login_attempts
          (attempt_key, failures, blocked_until, updated_at)
         VALUES (?, 19, NULL, ?)`,
      )
      .run(sha256(`ip\0${ipAddress}`), Date.now());

    expect(
      await authenticateAdmin("admin", "wrong-password", ipAddress),
    ).toMatchObject({
      ok: false,
      blockedUntil: expect.any(Number),
    });
  });
});
