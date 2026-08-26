/** Action 写入测试：验证循环契约不只进修订 payload，也真实持久化到 actions 行。 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../db/schema";

const sqlite = new Database(":memory:");
sqlite.exec(`
CREATE TABLE models (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
  display_name TEXT NOT NULL
);
CREATE TABLE actions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL, rule TEXT NOT NULL DEFAULT '', model_id TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL DEFAULT 'high', max_reentries INTEGER NOT NULL DEFAULT 0,
  on_exhausted TEXT NOT NULL DEFAULT 'fail', created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE object_types (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL
);
CREATE TABLE action_ports (
  id TEXT PRIMARY KEY, action_id TEXT NOT NULL, direction TEXT NOT NULL,
  name TEXT NOT NULL, object_type_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
  artifact_path TEXT, exit_name TEXT
);
CREATE TABLE action_skills (
  action_id TEXT NOT NULL, skill_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (action_id, skill_id)
);
CREATE TABLE action_tools (
  action_id TEXT NOT NULL, tool_id TEXT NOT NULL, PRIMARY KEY (action_id, tool_id)
);
CREATE TABLE revisions (
  id TEXT PRIMARY KEY, entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL,
  version_no INTEGER NOT NULL, payload TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
`);
(globalThis as unknown as { ontoflowDb?: unknown }).ontoflowDb = drizzle(sqlite, {
  schema,
});

const { createAction, writeAction } = await import("./action");

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM revisions;
    DELETE FROM action_tools;
    DELETE FROM action_skills;
    DELETE FROM action_ports;
    DELETE FROM actions;
    DELETE FROM models;
    INSERT INTO models VALUES ('model-1', 'deepseek-official', 'test-model', '测试模型');
  `);
});

function payload(maxReentries: number, onExhausted: "fail" | "accept") {
  return {
    name: "循环 Action",
    description: "",
    prompt: "执行",
    rule: "",
    modelId: "model-1",
    reasoningEffort: "high",
    maxReentries,
    onExhausted,
    ports: [],
    skillIds: [],
    toolIds: [],
  };
}

describe("Action 循环字段写入", () => {
  it("新建与更新都持久化 maxReentries / onExhausted", () => {
    const created = createAction(payload(2, "accept"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data).toMatchObject({ maxReentries: 2, onExhausted: "accept" });

    expect(
      sqlite
        .prepare(
          "select max_reentries as maxReentries, on_exhausted as onExhausted from actions where id = ?",
        )
        .get(created.data.id),
    ).toEqual({ maxReentries: 2, onExhausted: "accept" });

    const updated = writeAction(created.data.id, payload(5, "fail"));
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.data).toMatchObject({ maxReentries: 5, onExhausted: "fail" });
  });
});
