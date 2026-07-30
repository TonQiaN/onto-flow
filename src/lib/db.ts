import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { getServerConfig } from "@/lib/env";

export type AppDatabase = Database.Database;

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role = 'admin'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  attempt_key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  blocked_until INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS message_jobs (
  id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'claimed', 'sending', 'succeeded', 'failed', 'manual_review')
  ),
  attempts INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  lease_token_hash TEXT,
  lease_until INTEGER,
  screenshot_filename TEXT,
  screenshot_mime TEXT,
  screenshot_sha256 TEXT,
  codex_thread_id TEXT,
  result_summary TEXT,
  error_message TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS message_jobs_queue_idx
  ON message_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS worker_presence (
  worker_id TEXT PRIMARY KEY,
  last_seen_at INTEGER NOT NULL,
  current_job_id TEXT,
  version TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'worker', 'system')),
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  job_id TEXT,
  created_at INTEGER NOT NULL,
  metadata_json TEXT
);

PRAGMA user_version = 1;
`;

declare global {
  var __codexExperimentDb: AppDatabase | undefined;
}

export function openDatabase(filename: string): AppDatabase {
  if (filename !== ":memory:") {
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  }

  const database = new Database(filename);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  if (filename !== ":memory:") {
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
  }
  database.exec(schema);
  const messageJobColumns = database
    .pragma("table_info(message_jobs)") as Array<{ name: string }>;
  if (!messageJobColumns.some((column) => column.name === "lease_token_hash")) {
    database.exec("ALTER TABLE message_jobs ADD COLUMN lease_token_hash TEXT");
  }
  return database;
}

export function getDb(): AppDatabase {
  if (globalThis.__codexExperimentDb) {
    return globalThis.__codexExperimentDb;
  }

  const dataDir = path.resolve(getServerConfig().DATA_DIR);
  const database = openDatabase(path.join(dataDir, "app.sqlite"));
  globalThis.__codexExperimentDb = database;
  return database;
}
