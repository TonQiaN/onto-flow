CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  client_key TEXT PRIMARY KEY,
  failure_count INTEGER NOT NULL,
  first_failed_at INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS message_jobs (
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
);
CREATE UNIQUE INDEX IF NOT EXISTS message_jobs_single_active_idx
  ON message_jobs ((1))
  WHERE status IN ('queued','claimed','sending','manual_review');
CREATE TABLE IF NOT EXISTS worker_presence (
  worker_id TEXT PRIMARY KEY,
  version TEXT,
  last_seen_at INTEGER NOT NULL,
  current_job_id TEXT
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  job_id TEXT,
  event_type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
