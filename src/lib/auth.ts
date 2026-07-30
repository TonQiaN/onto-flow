import { compare } from "bcryptjs";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { getServerConfig, normalizedBasePath } from "@/lib/env";
import { randomToken, sha256 } from "@/lib/crypto";

export const SESSION_COOKIE_NAME = "codex_experiment_session";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const DUMMY_PASSWORD_HASH =
  "$2b$12$TU5.nAhMgEIn9awk6Vx.Tu3xPuTlFQ2ctdTOLY8SOTJJuY77OV.Ey";

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  role: "admin";
};

export type AdminSession = {
  userId: string;
  username: string;
  role: "admin";
  expiresAt: number;
};

function ensureConfiguredAdmin(): UserRow {
  const config = getServerConfig();
  const database = getDb();
  return database.transaction(() => {
    const now = Date.now();
    const existing = database
      .prepare(
        "SELECT id, username, password_hash, role FROM users WHERE username = ?",
      )
      .get(config.ADMIN_USERNAME) as UserRow | undefined;

    if (existing) {
      if (
        existing.password_hash !== config.ADMIN_PASSWORD_HASH ||
        existing.role !== "admin"
      ) {
        database
          .prepare(
            `UPDATE users
             SET password_hash = ?, role = 'admin', updated_at = ?
             WHERE id = ?`,
          )
          .run(config.ADMIN_PASSWORD_HASH, now, existing.id);
        database
          .prepare("DELETE FROM sessions WHERE user_id = ?")
          .run(existing.id);
      }
      return {
        ...existing,
        password_hash: config.ADMIN_PASSWORD_HASH,
        role: "admin" as const,
      };
    }

    const id = randomUUID();
    database
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
         VALUES (?, ?, ?, 'admin', ?, ?)`,
      )
      .run(id, config.ADMIN_USERNAME, config.ADMIN_PASSWORD_HASH, now, now);

    return {
      id,
      username: config.ADMIN_USERNAME,
      password_hash: config.ADMIN_PASSWORD_HASH,
      role: "admin" as const,
    };
  })();
}

type LoginAttempt = {
  failures: number;
  blocked_until: number | null;
  updated_at: number;
};

function loginAttemptDimensions(ipAddress: string, normalizedUsername: string) {
  return [
    {
      attemptKey: sha256(`pair\0${ipAddress}\0${normalizedUsername}`),
      maxFailures: 5,
      clearOnSuccess: true,
    },
    {
      attemptKey: sha256(`account\0${normalizedUsername}`),
      maxFailures: 10,
      clearOnSuccess: true,
    },
    {
      attemptKey: sha256(`ip\0${ipAddress}`),
      maxFailures: 20,
      clearOnSuccess: false,
    },
  ];
}

export async function authenticateAdmin(
  username: string,
  password: string,
  ipAddress: string,
): Promise<
  | { ok: true; user: UserRow }
  | { ok: false; blockedUntil?: number }
> {
  const database = getDb();
  const normalizedUsername = username.trim().toLocaleLowerCase("en-US");
  const dimensions = loginAttemptDimensions(ipAddress, normalizedUsername);
  const now = Date.now();
  database
    .prepare("DELETE FROM login_attempts WHERE updated_at <= ?")
    .run(now - LOGIN_WINDOW_MS);
  const selectAttempt = database.prepare(
    `SELECT failures, blocked_until, updated_at
     FROM login_attempts WHERE attempt_key = ?`,
  );
  const attempts = dimensions.map((dimension) => ({
    ...dimension,
    attempt: selectAttempt.get(dimension.attemptKey) as LoginAttempt | undefined,
  }));
  const activeBlocks = attempts
    .map(({ attempt }) => attempt?.blocked_until ?? 0)
    .filter((blockedUntil) => blockedUntil > now);
  if (activeBlocks.length > 0) {
    return { ok: false, blockedUntil: Math.max(...activeBlocks) };
  }

  const configuredAdmin = ensureConfiguredAdmin();
  const user =
    configuredAdmin.username.toLocaleLowerCase("en-US") === normalizedUsername
      ? configuredAdmin
      : undefined;
  const passwordMatches = await compare(
    password,
    user?.password_hash ?? DUMMY_PASSWORD_HASH,
  );

  if (user && passwordMatches) {
    const clearAttempt = database.prepare(
      "DELETE FROM login_attempts WHERE attempt_key = ?",
    );
    database.transaction(() => {
      for (const dimension of attempts) {
        if (dimension.clearOnSuccess) {
          clearAttempt.run(dimension.attemptKey);
        }
      }
    })();
    return { ok: true, user };
  }

  const upsertAttempt = database.prepare(
    `INSERT INTO login_attempts (attempt_key, failures, blocked_until, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(attempt_key) DO UPDATE SET
       failures = excluded.failures,
       blocked_until = excluded.blocked_until,
       updated_at = excluded.updated_at`,
  );
  let blockedUntil: number | undefined;
  const failedAt = Date.now();
  database.transaction(() => {
    for (const dimension of attempts) {
      const currentAttempt = selectAttempt.get(
        dimension.attemptKey,
      ) as LoginAttempt | undefined;
      const failures =
        currentAttempt &&
        failedAt - currentAttempt.updated_at < LOGIN_WINDOW_MS
          ? currentAttempt.failures + 1
          : 1;
      const dimensionBlockedUntil =
        failures >= dimension.maxFailures
          ? failedAt + LOGIN_WINDOW_MS
          : null;
      upsertAttempt.run(
        dimension.attemptKey,
        failures,
        dimensionBlockedUntil,
        failedAt,
      );
      if (
        dimensionBlockedUntil &&
        (!blockedUntil || dimensionBlockedUntil > blockedUntil)
      ) {
        blockedUntil = dimensionBlockedUntil;
      }
    }
  })();

  return { ok: false, blockedUntil };
}

export async function createAdminSession(user: UserRow): Promise<void> {
  const database = getDb();
  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  database
    .prepare(
      `INSERT INTO sessions
        (token_hash, user_id, expires_at, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(sha256(token), user.id, expiresAt, now, now);

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: getServerConfig().SESSION_COOKIE_SECURE,
    sameSite: "strict",
    path: normalizedBasePath() || "/",
    expires: new Date(expiresAt),
  });
}

export async function getAdminSession(): Promise<AdminSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const database = getDb();
  const configuredAdmin = ensureConfiguredAdmin();
  const row = database
    .prepare(
      `SELECT
         sessions.expires_at,
         sessions.last_seen_at,
         users.id AS user_id,
         users.username,
         users.role,
         users.password_hash
       FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ?`,
    )
    .get(sha256(token)) as
    | {
        expires_at: number;
        last_seen_at: number;
        user_id: string;
        username: string;
        role: "admin";
        password_hash: string;
      }
    | undefined;

  const now = Date.now();
  if (
    !row ||
    row.expires_at <= now ||
    row.role !== "admin" ||
    row.user_id !== configuredAdmin.id ||
    row.password_hash !== configuredAdmin.password_hash
  ) {
    if (row) {
      database
        .prepare("DELETE FROM sessions WHERE token_hash = ?")
        .run(sha256(token));
    }
    return null;
  }

  if (now - row.last_seen_at > 5 * 60 * 1000) {
    database
      .prepare(
        "UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?",
      )
      .run(now, sha256(token));
  }

  return {
    userId: row.user_id,
    username: row.username,
    role: row.role,
    expiresAt: row.expires_at,
  };
}

export async function destroyAdminSession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    getDb()
      .prepare("DELETE FROM sessions WHERE token_hash = ?")
      .run(sha256(token));
  }
  cookieStore.delete(SESSION_COOKIE_NAME);
}

export function requestSessionToken(request: NextRequest): string | null {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
}
