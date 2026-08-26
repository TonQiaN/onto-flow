/** collectCapabilities 的关系查询跑内存库，证明 Action 归属没有在取并集时丢失。 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import * as schema from "../../db/schema";
import type { ResolvedWorkflow } from "@/server/resolve";

const sqlite = new Database(":memory:");
sqlite.exec(`
CREATE TABLE skills (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, content TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE tools (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, code TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE action_skills (
  action_id TEXT NOT NULL, skill_id TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY (action_id, skill_id)
);
CREATE TABLE action_tools (
  action_id TEXT NOT NULL, tool_id TEXT NOT NULL,
  PRIMARY KEY (action_id, tool_id)
);
INSERT INTO tools VALUES ('tool-1', 'dangerous_tool', '测试', 'export const name="dangerous_tool"', 0, 0);
INSERT INTO action_tools VALUES ('action-a', 'tool-1');
`);
(globalThis as unknown as { ontoflowDb?: unknown }).ontoflowDb = drizzle(sqlite, { schema });

const { collectCapabilities, toolFilterForAction } = await import("./capabilities");

describe("Action Tool 引用归属", () => {
  it("取工作流并集时仍保留 A/B 的引用差异", () => {
    const nodeRows = new Map([
      ["node-a", { kind: "action", actionId: "action-a" }],
      ["node-b", { kind: "action", actionId: "action-b" }],
    ]) as unknown as ResolvedWorkflow["nodeRows"];
    const capabilities = collectCapabilities({ nodeRows } as ResolvedWorkflow);

    expect(capabilities.tools.map((tool) => tool.name)).toEqual(["dangerous_tool"]);
    expect(capabilities.toolNamesByActionId.get("action-a")).toEqual(["dangerous_tool"]);
    expect(capabilities.toolNamesByActionId.get("action-b")).toEqual([]);
    expect(toolFilterForAction(capabilities, "action-a", [])).toBeUndefined();
    expect(toolFilterForAction(capabilities, "action-b", [])).toEqual({
      deny: ["dangerous_tool"],
    });
  });
});
