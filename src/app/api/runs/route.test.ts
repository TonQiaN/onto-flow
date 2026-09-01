/** 运行历史 API 的总 token 口径必须与详情页一致，且不触碰真实 data/ontoflow.db。 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../../db/schema";

const sqlite = new Database(":memory:");
sqlite.exec(`
CREATE TABLE runs (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL,
  workflow_name TEXT NOT NULL DEFAULT '', error TEXT, run_dir TEXT, imports TEXT,
  started_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE TABLE run_nodes (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL, label TEXT NOT NULL,
  status TEXT NOT NULL, snapshot TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
  inputs TEXT, outputs TEXT, session_id TEXT, error TEXT,
  started_at INTEGER, finished_at INTEGER
);
`);
(globalThis as unknown as { ontoflowDb?: unknown }).ontoflowDb = drizzle(sqlite, { schema });

const { GET } = await import("./route");

beforeEach(() => {
  sqlite.exec("DELETE FROM run_nodes; DELETE FROM runs;");
  sqlite
    .prepare(
      "INSERT INTO runs (id, workflow_id, status, workflow_name, started_at) VALUES ('run-1', 'workflow-1', 'success', '测试工作流', 1)",
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO run_nodes (id, run_id, node_id, label, status, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens) VALUES ('node-row-1', 'run-1', 'node-1', '一', 'success', 10, 20, 7, 3, 4), ('node-row-2', 'run-1', 'node-2', '二', 'success', 1, 2, 50, 0, 0)",
    )
    .run();
});

describe("运行历史 API token 汇总", () => {
  it("跨节点只累计 input/output/cache，reasoning 不重复计数", async () => {
    const response = await GET(new Request("http://localhost/api/runs"));
    expect(response.status).toBe(200);
    const rows = (await response.json()) as Array<{ totalTokens: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].totalTokens).toBe(40);
  });
});
