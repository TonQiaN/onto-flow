/** 工作流解析必须一次冻结图、Action 与能力；付费受理后不再被共享库改写换版。 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import * as schema from "../db/schema";

const sqlite = new Database(":memory:");
sqlite.exec(`
CREATE TABLE workflows (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE workflow_nodes (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, kind TEXT NOT NULL,
  action_id TEXT, object_type_id TEXT, label TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL
);
CREATE TABLE workflow_edges (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, source_node_id TEXT NOT NULL,
  source_port TEXT NOT NULL, target_node_id TEXT NOT NULL, target_port TEXT NOT NULL
);
CREATE TABLE object_types (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, description TEXT NOT NULL,
  json_schema TEXT, builtin INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE models (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_id TEXT NOT NULL, display_name TEXT NOT NULL
);
CREATE TABLE actions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, prompt TEXT NOT NULL,
  rule TEXT NOT NULL, model_id TEXT NOT NULL, reasoning_effort TEXT NOT NULL,
  max_reentries INTEGER NOT NULL, on_exhausted TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE action_ports (
  id TEXT PRIMARY KEY, action_id TEXT NOT NULL, direction TEXT NOT NULL, name TEXT NOT NULL,
  object_type_id TEXT NOT NULL, position INTEGER NOT NULL, artifact_path TEXT, exit_name TEXT
);
CREATE TABLE skills (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, content TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE action_skills (
  action_id TEXT NOT NULL, skill_id TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY (action_id, skill_id)
);
CREATE TABLE tools (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, code TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE action_tools (
  action_id TEXT NOT NULL, tool_id TEXT NOT NULL,
  PRIMARY KEY (action_id, tool_id)
);

INSERT INTO workflows VALUES ('workflow-1', '快照测试', '', 0, 0);
INSERT INTO workflow_nodes VALUES ('node-1', 'workflow-1', 'action', 'action-1', NULL, '', 0, 0);
INSERT INTO object_types VALUES ('type-1', '报告', 'file', '', NULL, 0, 0, 0);
INSERT INTO models VALUES ('model-1', 'deepseek-official', 'model-v1', '模型 V1');
INSERT INTO actions VALUES ('action-1', '汇总', '', '原始任务', '原始规则', 'model-1', 'high', 0, 'fail', 0, 0);
INSERT INTO action_ports VALUES ('port-1', 'action-1', 'output', '结果', 'type-1', 0, 'result.md', NULL);
INSERT INTO skills VALUES ('skill-1', '核对', '', '原始技能', 0, 0);
INSERT INTO action_skills VALUES ('action-1', 'skill-1', 0);
INSERT INTO tools VALUES ('tool-1', 'validate_result', '', 'original tool code', 0, 0);
INSERT INTO action_tools VALUES ('action-1', 'tool-1');
`);
(globalThis as unknown as { ontoflowDb?: unknown }).ontoflowDb = drizzle(sqlite, { schema });

const { resolveWorkflow } = await import("./resolve");

afterAll(() => sqlite.close());

describe("工作流执行定义快照", () => {
  it("resolve 后冻结 Action、模型、端口、Skill 关系与 Tool 源码", async () => {
    const resolved = await resolveWorkflow("workflow-1");
    expect(resolved).not.toBeNull();
    if (!resolved) return;

    sqlite.exec(`
      UPDATE actions SET prompt = '网页新任务', rule = '网页新规则' WHERE id = 'action-1';
      UPDATE models SET model_id = 'model-v2', display_name = '模型 V2' WHERE id = 'model-1';
      UPDATE action_ports SET artifact_path = 'changed.md' WHERE id = 'port-1';
      UPDATE object_types SET name = '改名报告' WHERE id = 'type-1';
      UPDATE skills SET content = '网页新技能' WHERE id = 'skill-1';
      UPDATE tools SET code = 'forged tool code' WHERE id = 'tool-1';
      DELETE FROM action_tools WHERE action_id = 'action-1';
    `);

    const definition = resolved.actionDefinitions.get("action-1");
    expect(definition).toMatchObject({
      action: { prompt: "原始任务", rule: "原始规则" },
      model: { modelId: "model-v1", displayName: "模型 V1" },
      ports: { outputs: [{ artifactPath: "result.md" }] },
      skills: [{ id: "skill-1", name: "核对" }],
    });
    expect(resolved.capabilities.skills).toEqual([{ id: "skill-1", name: "核对" }]);
    expect(resolved.objectTypes.get("type-1")?.name).toBe("报告");
    expect(resolved.capabilities.tools).toMatchObject([{ code: "original tool code" }]);
    expect(resolved.capabilities.toolNamesByActionId.get("action-1")).toEqual([
      "validate_result",
    ]);
  });
});
