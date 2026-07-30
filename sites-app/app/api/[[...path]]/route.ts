import bcrypt from "bcryptjs";
import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

type AppEnv = {
  DB: D1Database;
  SCREENSHOTS: R2Bucket;
  IMAGES?: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{
          response(): Response;
        }>;
      };
    };
  };
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD_HASH?: string;
  WORKER_TOKEN_SHA256?: string;
  WORKER_LEASE_SECONDS?: string;
};

type Context = { params: Promise<{ path?: string[] }> };
type JobRow = {
  id: string;
  recipient: string;
  message: string;
  status: string;
  attempts: number;
  error_message: string | null;
  result_summary: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  screenshot_filename: string | null;
  screenshot_mime: string | null;
};

const SESSION_COOKIE = "welink_message_session";
const allowedRecipients = new Set(["付方圆", "成雨函"]);
function bindings(): AppEnv {
  return env as unknown as AppEnv;
}

async function ensureSchema() {
  const db = bindings().DB;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS login_attempts (
      client_key TEXT PRIMARY KEY,
      failure_count INTEGER NOT NULL,
      first_failed_at INTEGER NOT NULL,
      blocked_until INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS message_jobs (
      id TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      recipient TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_by TEXT,
      lease_token_hash TEXT,
      lease_expires_at INTEGER,
      error_message TEXT,
      result_summary TEXT,
      codex_thread_id TEXT,
      screenshot_filename TEXT,
      screenshot_mime TEXT,
      screenshot_sha256 TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER
    )`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS message_jobs_single_active_idx
      ON message_jobs ((1))
      WHERE status IN ('queued','claimed','sending','manual_review')`),
    db.prepare(`CREATE TABLE IF NOT EXISTS worker_presence (
      worker_id TEXT PRIMARY KEY,
      version TEXT,
      last_seen_at INTEGER NOT NULL,
      current_job_id TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      job_id TEXT,
      event_type TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
  ]);
  await ensureAdmin();
}

async function ensureAdmin() {
  const appEnv = bindings();
  const username = appEnv.ADMIN_USERNAME?.trim();
  const passwordHash = appEnv.ADMIN_PASSWORD_HASH?.trim();
  if (!username || !passwordHash) return;
  const now = Date.now();
  const existing = await appEnv.DB
    .prepare("SELECT id, password_hash FROM users WHERE username = ?")
    .bind(username)
    .first<{ id: string; password_hash: string }>();
  if (!existing) {
    await appEnv.DB
      .prepare(`INSERT OR IGNORE INTO users
        (id, username, password_hash, role, created_at, updated_at)
        VALUES (?, ?, ?, 'admin', ?, ?)`)
      .bind(crypto.randomUUID(), username, passwordHash, now, now)
      .run();
    const inserted = await appEnv.DB
      .prepare("SELECT id, password_hash FROM users WHERE username = ?")
      .bind(username)
      .first<{ id: string; password_hash: string }>();
    if (inserted && inserted.password_hash !== passwordHash) {
      await appEnv.DB.batch([
        appEnv.DB
          .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
          .bind(passwordHash, now, inserted.id),
        appEnv.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(inserted.id),
      ]);
    }
  } else if (existing.password_hash !== passwordHash) {
    await appEnv.DB.batch([
      appEnv.DB
        .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .bind(passwordHash, now, existing.id),
      appEnv.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(existing.id),
    ]);
  }
}

function json(payload: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function trustedMutation(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

async function digest(value: string | ArrayBuffer) {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 32) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function session(request: Request) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const now = Date.now();
  return bindings().DB
    .prepare(`SELECT u.id AS userId, u.username AS username
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`)
    .bind(await digest(token), now)
    .first<{ userId: string; username: string }>();
}

async function workerAuthorized(request: Request) {
  const expected = bindings().WORKER_TOKEN_SHA256?.toLowerCase() ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token || expected.length !== 64) return false;
  const actual = await digest(token);
  let mismatch = 0;
  for (let index = 0; index < 64; index += 1) {
    mismatch |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}

function publicJob(row: JobRow) {
  return {
    id: row.id,
    recipient: row.recipient,
    message: row.message,
    status: row.status,
    attempts: row.attempts,
    errorMessage: row.error_message,
    resultSummary: row.result_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    screenshotUrl: row.screenshot_filename ? `/api/tasks/${row.id}/screenshot` : null,
  };
}

async function getJob(id: string) {
  return bindings().DB
    .prepare("SELECT * FROM message_jobs WHERE id = ?")
    .bind(id)
    .first<JobRow>();
}

async function reapExpiredLeases() {
  const now = Date.now();
  await bindings().DB.batch([
    bindings().DB
      .prepare(`UPDATE message_jobs SET
        status='queued', claimed_by=NULL, lease_token_hash=NULL, lease_expires_at=NULL,
        updated_at=?
        WHERE status='claimed' AND lease_expires_at < ?`)
      .bind(now, now),
    bindings().DB
      .prepare(`UPDATE message_jobs SET
        status='manual_review',
        error_message='执行器租约在不可逆操作后失效，需要人工确认；系统不会自动补发。',
        result_summary='发送结果不确定，已停止自动重试。',
        updated_at=?, completed_at=?
        WHERE status='sending' AND lease_expires_at < ?`)
      .bind(now, now, now),
  ]);
}

async function audit(actorType: string, actorId: string, eventType: string, jobId?: string) {
  await bindings().DB
    .prepare(`INSERT INTO audit_events
      (id, actor_type, actor_id, job_id, event_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), actorType, actorId, jobId ?? null, eventType, Date.now())
    .run();
}

function pathParts(context: Context) {
  return context.params.then((value) => value.path ?? []);
}

export async function GET(request: Request, context: Context) {
  await ensureSchema();
  const parts = await pathParts(context);

  if (parts[0] === "health") {
    await bindings().DB.prepare("SELECT 1").first();
    return json({ ok: true, service: "welink-message-lab-sites", database: "ready" });
  }

  if (parts[0] === "session") {
    const current = await session(request);
    return json(
      current
        ? { authenticated: true, username: current.username }
        : { authenticated: false },
    );
  }

  const current = await session(request);
  if (!current) return json({ error: "未登录。" }, 401);

  if (parts[0] === "tasks" && parts.length === 1) {
    await reapExpiredLeases();
    const jobs = await bindings().DB
      .prepare("SELECT * FROM message_jobs ORDER BY created_at DESC LIMIT 30")
      .all<JobRow>();
    const presence = await bindings().DB
      .prepare("SELECT worker_id, last_seen_at FROM worker_presence ORDER BY last_seen_at DESC LIMIT 1")
      .first<{ worker_id: string; last_seen_at: number }>();
    return json({
      jobs: jobs.results.map(publicJob),
      worker: {
        online: Boolean(presence && presence.last_seen_at >= Date.now() - 30_000),
        workerId: presence?.worker_id ?? null,
        lastSeenAt: presence?.last_seen_at ?? null,
      },
    });
  }

  if (parts[0] === "tasks" && parts[1] && parts[2] === "screenshot") {
    const job = await getJob(parts[1]);
    if (!job?.screenshot_filename || !job.screenshot_mime) return new Response(null, { status: 404 });
    const object = await bindings().SCREENSHOTS.get(`screenshots/${job.screenshot_filename}`);
    if (!object) return new Response(null, { status: 404 });
    return new Response(object.body, {
      headers: {
        "Content-Type": job.screenshot_mime,
        "Content-Length": String(object.size),
        "Cache-Control": "private, no-store",
        "Content-Disposition": `inline; filename="${job.id}.jpg"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  if (parts[0] === "tasks" && parts[1] && parts.length === 2) {
    const job = await getJob(parts[1]);
    return job ? json({ job: publicJob(job) }) : json({ error: "任务不存在。" }, 404);
  }

  return json({ error: "Not found." }, 404);
}

export async function POST(request: Request, context: Context) {
  await ensureSchema();
  const parts = await pathParts(context);

  if (parts[0] === "auth" && parts[1] === "login") {
    if (!trustedMutation(request)) return json({ error: "请求来源无效。" }, 403);
    const body = (await request.json().catch(() => null)) as
      | { username?: unknown; password?: unknown }
      | null;
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!username || !password || username.length > 80 || password.length > 256) {
      return json({ error: "请输入管理员账号和密码。" }, 400);
    }
    const clientKey = request.headers.get("cf-connecting-ip") ?? "unknown-client";
    const attempt = await bindings().DB
      .prepare("SELECT * FROM login_attempts WHERE client_key = ?")
      .bind(clientKey)
      .first<{ failure_count: number; first_failed_at: number; blocked_until: number }>();
    if (attempt?.blocked_until && attempt.blocked_until > Date.now()) {
      return json({ error: "登录尝试过多，请稍后再试。" }, 429);
    }
    const user = await bindings().DB
      .prepare("SELECT id, username, password_hash FROM users WHERE username = ?")
      .bind(username)
      .first<{ id: string; username: string; password_hash: string }>();
    const valid = Boolean(user && (await bcrypt.compare(password, user.password_hash)));
    if (!valid) {
      const now = Date.now();
      const withinWindow = attempt && now - attempt.first_failed_at < 15 * 60_000;
      const failures = withinWindow ? attempt.failure_count + 1 : 1;
      const first = withinWindow ? attempt.first_failed_at : now;
      const blockedUntil = failures >= 5 ? now + 15 * 60_000 : 0;
      await bindings().DB
        .prepare(`INSERT INTO login_attempts
          (client_key, failure_count, first_failed_at, blocked_until)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(client_key) DO UPDATE SET
            failure_count=excluded.failure_count,
            first_failed_at=excluded.first_failed_at,
            blocked_until=excluded.blocked_until`)
        .bind(clientKey, failures, first, blockedUntil)
        .run();
      return json({ error: "账号或密码不正确。" }, failures >= 5 ? 429 : 401);
    }
    await bindings().DB.prepare("DELETE FROM login_attempts WHERE client_key = ?").bind(clientKey).run();
    const token = randomToken();
    const now = Date.now();
    await bindings().DB
      .prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .bind(await digest(token), user!.id, now + 12 * 60 * 60_000, now)
      .run();
    await audit("user", user!.id, "auth.login");
    return json(
      { ok: true },
      200,
      {
        "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict`,
      },
    );
  }

  if (parts[0] === "auth" && parts[1] === "logout") {
    if (!trustedMutation(request)) return json({ error: "请求来源无效。" }, 403);
    const token = cookieValue(request, SESSION_COOKIE);
    if (token) {
      await bindings().DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await digest(token)).run();
    }
    return json(
      { ok: true },
      200,
      { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` },
    );
  }

  if (parts[0] === "tasks" && parts.length === 1) {
    if (!trustedMutation(request)) return json({ error: "请求来源无效。" }, 403);
    const current = await session(request);
    if (!current) return json({ error: "未登录。" }, 401);
    const body = (await request.json().catch(() => null)) as
      | { recipient?: unknown; message?: unknown }
      | null;
    const recipient = typeof body?.recipient === "string" ? body.recipient.trim() : "";
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!allowedRecipients.has(recipient) || !message || message.length > 2000 || /[\r\n]/.test(message)) {
      return json({ error: "请选择发送对象，并填写不超过 2000 字的单行消息。" }, 400);
    }
    await reapExpiredLeases();
    const presence = await bindings().DB
      .prepare("SELECT last_seen_at FROM worker_presence ORDER BY last_seen_at DESC LIMIT 1")
      .first<{ last_seen_at: number }>();
    if (!presence || presence.last_seen_at < Date.now() - 30_000) {
      return json({ error: "本机执行器当前离线或心跳已过期，请先启动执行器。" }, 503);
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    try {
      await bindings().DB
        .prepare(`INSERT INTO message_jobs
          (id, created_by, recipient, message, status, attempts, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)`)
        .bind(id, current.userId, recipient, message, now, now)
        .run();
    } catch {
      return json({ error: "当前已有发送任务在执行，请等待它完成。" }, 409);
    }
    await audit("user", current.userId, "job.created", id);
    return json({ job: publicJob((await getJob(id))!) }, 201);
  }

  if (parts[0] !== "worker" || !(await workerAuthorized(request))) {
    return json({ error: "Worker authentication failed." }, 401);
  }

  const body = parts.at(-1) === "result" ? null : ((await request.json().catch(() => null)) as Record<string, unknown> | null);

  if (parts[1] === "claim") {
    const workerId = typeof body?.workerId === "string" ? body.workerId.slice(0, 120) : "";
    const version = typeof body?.version === "string" ? body.version.slice(0, 80) : "";
    if (!/^[a-zA-Z0-9._-]+$/.test(workerId)) return json({ error: "Invalid worker identity." }, 400);
    await reapExpiredLeases();
    const now = Date.now();
    await bindings().DB
      .prepare(`INSERT INTO worker_presence (worker_id, version, last_seen_at, current_job_id)
        VALUES (?, ?, ?, NULL)
        ON CONFLICT(worker_id) DO UPDATE SET version=excluded.version, last_seen_at=excluded.last_seen_at`)
      .bind(workerId, version, now)
      .run();
    const queued = await bindings().DB
      .prepare("SELECT id FROM message_jobs WHERE status='queued' ORDER BY created_at LIMIT 1")
      .first<{ id: string }>();
    if (!queued) return json({ job: null, leaseToken: null });
    const leaseToken = randomToken();
    const leaseHash = await digest(leaseToken);
    const leaseSeconds = Math.max(30, Math.min(600, Number(bindings().WORKER_LEASE_SECONDS ?? "90") || 90));
    const updated = await bindings().DB
      .prepare(`UPDATE message_jobs SET
        status='claimed', claimed_by=?, lease_token_hash=?, lease_expires_at=?,
        attempts=attempts+1, updated_at=?
        WHERE id=? AND status='queued'`)
      .bind(workerId, leaseHash, now + leaseSeconds * 1000, now, queued.id)
      .run();
    if (!updated.meta.changes) return json({ job: null, leaseToken: null });
    await bindings().DB.prepare("UPDATE worker_presence SET current_job_id=? WHERE worker_id=?").bind(queued.id, workerId).run();
    await audit("worker", workerId, "job.claimed", queued.id);
    return json({ job: publicJob((await getJob(queued.id))!), leaseToken });
  }

  const jobId = parts[2] === "jobs" ? parts[3] : "";
  const action = parts[4];
  if (!jobId || !action) return json({ error: "Not found." }, 404);

  if (action === "result") {
    const form = await request.formData().catch(() => null);
    if (!form) return json({ error: "Invalid multipart payload." }, 400);
    const workerId = String(form.get("workerId") ?? "").slice(0, 120);
    const leaseToken = String(form.get("leaseToken") ?? "");
    const file = form.get("screenshot");
    if (!(file instanceof File) || file.size < 32 || file.size > 8 * 1024 * 1024) {
      return json({ error: "Screenshot is invalid." }, 400);
    }
    const leaseHash = await digest(leaseToken);
    const current = await bindings().DB
      .prepare(`SELECT id FROM message_jobs
        WHERE id=? AND status='sending' AND claimed_by=? AND lease_token_hash=? AND lease_expires_at>=?`)
      .bind(jobId, workerId, leaseHash, Date.now())
      .first();
    if (!current) return json({ error: "Job is no longer active." }, 409);

    let bytes: ArrayBuffer;
    try {
      if (bindings().IMAGES) {
        const output = await bindings().IMAGES!
          .input(file.stream())
          .transform({})
          .output({ format: "image/jpeg", quality: 86 });
        const response = output.response();
        if (!response.ok) throw new Error("image transform failed");
        bytes = await response.arrayBuffer();
      } else {
        const raw = await file.arrayBuffer();
        const head = new Uint8Array(raw, 0, Math.min(raw.byteLength, 8));
        const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
        const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
        if (!jpeg && !png) throw new Error("unsupported image");
        bytes = raw;
      }
    } catch {
      return json({ error: "Screenshot is invalid." }, 400);
    }
    const filename = `${jobId}.${randomToken(12)}.jpg`;
    const sha = await digest(bytes);
    await bindings().SCREENSHOTS.put(`screenshots/${filename}`, bytes, {
      httpMetadata: { contentType: "image/jpeg" },
      customMetadata: { jobId, sha256: sha },
    });
    const now = Date.now();
    const summary = String(form.get("summary") ?? "").slice(0, 2000) || "已由本机执行器完成，并上传截图证据。";
    const codexThreadId = String(form.get("codexThreadId") ?? "").slice(0, 200) || null;
    const updated = await bindings().DB
      .prepare(`UPDATE message_jobs SET
        status='succeeded', result_summary=?, codex_thread_id=?,
        screenshot_filename=?, screenshot_mime='image/jpeg', screenshot_sha256=?,
        lease_token_hash=NULL, lease_expires_at=NULL, updated_at=?, completed_at=?
        WHERE id=? AND status='sending' AND claimed_by=? AND lease_token_hash=?`)
      .bind(summary, codexThreadId, filename, sha, now, now, jobId, workerId, leaseHash)
      .run();
    if (!updated.meta.changes) {
      await bindings().SCREENSHOTS.delete(`screenshots/${filename}`);
      return json({ error: "Job is no longer active." }, 409);
    }
    await bindings().DB.prepare("UPDATE worker_presence SET current_job_id=NULL, last_seen_at=? WHERE worker_id=?").bind(now, workerId).run();
    await audit("worker", workerId, "job.succeeded", jobId);
    return json({ job: publicJob((await getJob(jobId))!) });
  }

  const workerId = typeof body?.workerId === "string" ? body.workerId.slice(0, 120) : "";
  const leaseToken = typeof body?.leaseToken === "string" ? body.leaseToken : "";
  const leaseHash = await digest(leaseToken);
  const now = Date.now();
  const leaseSeconds = Math.max(30, Math.min(600, Number(bindings().WORKER_LEASE_SECONDS ?? "90") || 90));

  if (action === "start") {
    const updated = await bindings().DB
      .prepare(`UPDATE message_jobs SET status='sending', started_at=?, updated_at=?, lease_expires_at=?
        WHERE id=? AND status='claimed' AND claimed_by=? AND lease_token_hash=? AND lease_expires_at>=?`)
      .bind(now, now, now + leaseSeconds * 1000, jobId, workerId, leaseHash, now)
      .run();
    if (!updated.meta.changes) return json({ error: "Job is not claimable by this worker." }, 409);
    await audit("worker", workerId, "job.started", jobId);
    return json({ job: publicJob((await getJob(jobId))!) });
  }

  if (action === "heartbeat") {
    const updated = await bindings().DB
      .prepare(`UPDATE message_jobs SET lease_expires_at=?, updated_at=?
        WHERE id=? AND status IN ('claimed','sending') AND claimed_by=? AND lease_token_hash=?`)
      .bind(now + leaseSeconds * 1000, now, jobId, workerId, leaseHash)
      .run();
    if (!updated.meta.changes) return json({ error: "Job lease is no longer active." }, 409);
    await bindings().DB.prepare("UPDATE worker_presence SET last_seen_at=?, current_job_id=? WHERE worker_id=?").bind(now, jobId, workerId).run();
    return json({ ok: true });
  }

  if (action === "failure") {
    const uncertain = body?.certainty !== "not_sent";
    const error = typeof body?.error === "string" ? body.error.slice(0, 2000) : "Worker failed.";
    const status = uncertain ? "manual_review" : "failed";
    const summary = uncertain
      ? "发送结果不确定，已停止自动重试，需要人工确认。"
      : "执行器确认消息未发送；系统不会自动重试。";
    const updated = await bindings().DB
      .prepare(`UPDATE message_jobs SET status=?, error_message=?, result_summary=?,
        lease_token_hash=NULL, lease_expires_at=NULL, updated_at=?, completed_at=?
        WHERE id=? AND status IN ('claimed','sending') AND claimed_by=? AND lease_token_hash=?`)
      .bind(status, error, summary, now, now, jobId, workerId, leaseHash)
      .run();
    if (!updated.meta.changes) return json({ error: "Job is no longer active." }, 409);
    await bindings().DB.prepare("UPDATE worker_presence SET current_job_id=NULL, last_seen_at=? WHERE worker_id=?").bind(now, workerId).run();
    await audit("worker", workerId, uncertain ? "job.manual_review" : "job.failed", jobId);
    return json({ job: publicJob((await getJob(jobId))!) });
  }

  return json({ error: "Not found." }, 404);
}
