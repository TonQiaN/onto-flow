/** 监控聚合的两类事实源都不得把 reasoning 再加到已含它的 output。 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../db/schema";

const sqlite = new Database(":memory:");
sqlite.exec(`
CREATE TABLE runs (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL,
  status TEXT NOT NULL, error TEXT, started_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE TABLE run_nodes (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL, label TEXT NOT NULL,
  status TEXT NOT NULL, snapshot TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
  session_id TEXT, started_at INTEGER, finished_at INTEGER
);
CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, node_id TEXT,
  ts INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT
);
CREATE TABLE node_usage (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
  session_id TEXT NOT NULL, message_id TEXT NOT NULL,
  provider_id TEXT NOT NULL, model_id TEXT NOT NULL, variant TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
  finish TEXT, ts INTEGER NOT NULL
);
`);
(globalThis as unknown as { ontoflowDb?: unknown }).ontoflowDb = drizzle(sqlite, { schema });

const { getLiveSessions, getOverview } = await import("./metrics");

beforeEach(() => {
  sqlite.exec("DELETE FROM node_usage; DELETE FROM run_events; DELETE FROM run_nodes; DELETE FROM runs;");
  const now = Date.now();
  sqlite
    .prepare(
      "INSERT INTO runs (id, workflow_id, workflow_name, status, started_at) VALUES ('run-1', 'workflow-1', '测试工作流', 'running', ?)",
    )
    .run(now - 1000);
  sqlite
    .prepare(
      "INSERT INTO run_nodes (id, run_id, node_id, label, status, snapshot, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost, session_id, started_at) VALUES ('row-1', 'run-1', 'node-1', '测试节点', 'running', ?, 1, 2, 99, 3, 4, 0.1, 'node-1', ?)",
    )
    .run(JSON.stringify({ actionName: "测试 Action", model: {}, reasoningEffort: "high" }), now - 500);
  sqlite
    .prepare(
      "INSERT INTO node_usage (id, run_id, node_id, session_id, message_id, provider_id, model_id, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost, ts) VALUES ('usage-1', 'run-1', 'node-1', 'node-1', 'turn1-step1', 'deepseek-official', 'deepseek-v4-flash', 10, 20, 77, 3, 4, 0.1, ?)",
    )
    .run(now);
});

describe("监控 token 汇总", () => {
  it("实时节点总量不重复加 reasoning", () => {
    expect(getLiveSessions().items[0].tokens).toBe(10);
  });

  it("今日与小时用量不重复加 reasoning", () => {
    const overview = getOverview();
    expect(overview.today.tokens).toBe(37);
    expect(overview.series.reduce((sum, point) => sum + point.tokens, 0)).toBe(37);
  });
});
