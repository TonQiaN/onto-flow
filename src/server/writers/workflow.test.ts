/** Workflow 写入测试：节点 id 会进入运行目录，写入边界必须先拒绝路径形状。 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../db/schema";

const sqlite = new Database(":memory:");
sqlite.exec(`
CREATE TABLE workflows (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE revisions (
  id TEXT PRIMARY KEY, entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL,
  version_no INTEGER NOT NULL, payload TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
`);
(globalThis as unknown as { ontoflowDb?: unknown }).ontoflowDb = drizzle(sqlite, { schema });

const { createWorkflow, writeWorkflow } = await import("./workflow");

beforeEach(() => {
  sqlite.exec("DELETE FROM revisions; DELETE FROM workflows;");
});

describe("Workflow 节点 id 路径安全", () => {
  it.each(["../escape", "nested/node", ".hidden", "中文节点"])(
    "拒绝不能作为单个 ASCII 目录段的 id：%s",
    (id) => {
      const created = createWorkflow({ name: "路径安全测试", description: "" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const result = writeWorkflow(created.data.id, {
        nodes: [
          {
            id,
            kind: "input",
            actionId: null,
            objectTypeId: "unused",
            label: "输入",
            x: 0,
            y: 0,
          },
        ],
        edges: [],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.error).toContain("节点 id");
      }
    },
  );

  it("拒绝超过文件系统安全余量的超长节点 id", () => {
    const created = createWorkflow({ name: "超长节点测试", description: "" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = writeWorkflow(created.data.id, {
      nodes: [
        {
          id: "n".repeat(256),
          kind: "input",
          actionId: null,
          objectTypeId: "unused",
          label: "输入",
          x: 0,
          y: 0,
        },
      ],
      edges: [],
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("不能超过 120 个 ASCII 字符"),
    });
  });
});
