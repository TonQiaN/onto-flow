/** 工作流解析必须一次冻结图、Action 与三层能力；付费受理后不再被共享库改写换版。 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";

const sqlite = new Database(":memory:");
sqlite.exec(`
CREATE TABLE workflows (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '', settings TEXT NOT NULL DEFAULT '{"toggles":{},"mcpServers":[]}',
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
CREATE TABLE workflow_skills (
  workflow_id TEXT NOT NULL, skill_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workflow_id, skill_id)
);
CREATE TABLE workflow_tools (
  workflow_id TEXT NOT NULL, tool_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workflow_id, tool_id)
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
CREATE TABLE action_preloads (
  action_id TEXT NOT NULL, skill_id TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY (action_id, skill_id)
);
CREATE TABLE tools (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, public_name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL, parameters TEXT NOT NULL, output TEXT, timeout_ms INTEGER,
  code TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE action_tools (
  action_id TEXT NOT NULL, tool_id TEXT NOT NULL,
  PRIMARY KEY (action_id, tool_id)
);
`);
(globalThis as unknown as { ontoflowDb?: unknown }).ontoflowDb = drizzle(sqlite, { schema });

const { resolveWorkflow, WorkflowResolveError } = await import("./resolve");
const { skillSlug } = await import("./skill-library");

function seed(): void {
  sqlite.exec(`
    DELETE FROM workflows; DELETE FROM workflow_nodes; DELETE FROM workflow_edges;
    DELETE FROM workflow_skills; DELETE FROM workflow_tools; DELETE FROM object_types;
    DELETE FROM models; DELETE FROM actions; DELETE FROM action_ports; DELETE FROM skills;
    DELETE FROM action_preloads; DELETE FROM tools; DELETE FROM action_tools;
    INSERT INTO workflows VALUES (
      'workflow-1', '快照测试', '', '# 共同指令', '{"toggles":{"webSearch":true,"todo":"no"},"mcpServers":["docs"]}', 0, 0
    );
    INSERT INTO workflow_nodes VALUES ('node-1', 'workflow-1', 'action', 'action-1', NULL, '', 0, 0);
    INSERT INTO object_types VALUES ('type-1', '报告', 'file', '', NULL, 0, 0, 0);
    INSERT INTO models VALUES ('model-1', 'deepseek-official', 'model-v1', '模型 V1');
    INSERT INTO actions VALUES ('action-1', '汇总', '', '原始任务', '原始规则', 'model-1', 'high', 0, 'fail', 0, 0);
    INSERT INTO action_ports VALUES ('port-1', 'action-1', 'output', '结果', 'type-1', 0, 'result.md', NULL);
    INSERT INTO skills VALUES ('skill-1', '核对', '', '原始技能', 0, 0);
    INSERT INTO skills VALUES ('skill-2', '范本', '', '范本正文', 0, 0);
    INSERT INTO skills VALUES ('skill-3', '外部技能', '', '不在集合里', 0, 0);
    INSERT INTO workflow_skills VALUES ('workflow-1', 'skill-2', 1);
    INSERT INTO workflow_skills VALUES ('workflow-1', 'skill-1', 0);
    INSERT INTO action_preloads VALUES ('action-1', 'skill-1', 0);
    INSERT INTO tools VALUES ('tool-1', '校验结果', 'validate_result', '', '{"type":"object"}', NULL, NULL, 'original tool code', 0, 0);
    INSERT INTO tools VALUES ('tool-2', '盖章', 'stamp_result', '', '{"type":"object"}', NULL, 5000, 'stamp code', 0, 0);
    INSERT INTO tools VALUES ('tool-3', '外部工具', 'outside_tool', '', '{"type":"object"}', NULL, NULL, 'outside', 0, 0);
    INSERT INTO workflow_tools VALUES ('workflow-1', 'tool-1', 0);
    INSERT INTO workflow_tools VALUES ('workflow-1', 'tool-2', 1);
    INSERT INTO action_tools VALUES ('action-1', 'tool-1');
  `);
}

beforeEach(seed);
afterAll(() => sqlite.close());

describe("工作流执行定义快照", () => {
  it("resolve 后冻结 Action、模型、端口、预载关系、工作流设置与 Tool 源码", async () => {
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
      UPDATE workflows SET instructions = '改过的指令', settings = '{"toggles":{},"mcpServers":[]}';
      DELETE FROM action_tools WHERE action_id = 'action-1';
      DELETE FROM workflow_skills;
    `);

    const definition = resolved.actionDefinitions.get("action-1");
    expect(definition).toMatchObject({
      action: { prompt: "原始任务", rule: "原始规则" },
      model: { modelId: "model-v1", displayName: "模型 V1" },
      ports: { outputs: [{ artifactPath: "result.md" }] },
      preloads: [{ id: "skill-1", name: "核对", slug: skillSlug({ id: "skill-1" }) }],
    });
    // 技能集按 position 排序、带 slug；预载之外的技能同样进集合。
    expect(resolved.capabilities.skills).toEqual([
      { id: "skill-1", name: "核对", slug: skillSlug({ id: "skill-1" }) },
      { id: "skill-2", name: "范本", slug: skillSlug({ id: "skill-2" }) },
    ]);
    expect(resolved.workflow.instructions).toBe("# 共同指令");
    // 非布尔的开关值被丢弃，只保留五键内的布尔覆盖。
    expect(resolved.settings).toEqual({ toggles: { webSearch: true }, mcpServers: ["docs"] });
    expect(resolved.objectTypes.get("type-1")?.name).toBe("报告");
    // Tool 集全量行都冻结，可见关系按公名给出。
    expect(resolved.capabilities.tools.map((tool) => [tool.publicName, tool.code])).toEqual([
      ["validate_result", "original tool code"],
      ["stamp_result", "stamp code"],
    ]);
    expect(resolved.capabilities.tools[1]).toMatchObject({
      timeoutMs: 5000,
      parameters: { type: "object" },
    });
    expect(resolved.capabilities.toolNamesByActionId.get("action-1")).toEqual(["validate_result"]);
  });

  it("Action 预载了技能集之外的技能时以 422 语义拒绝受理", async () => {
    sqlite.exec("INSERT INTO action_preloads VALUES ('action-1', 'skill-3', 1);");
    const failure = await resolveWorkflow("workflow-1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WorkflowResolveError);
    if (!(failure instanceof WorkflowResolveError)) return;
    expect(failure.status).toBe(422);
    expect(failure.message).toBe("工作流校验未通过");
    expect(failure.issues).toEqual([
      { message: "Action「汇总」预载的技能「外部技能」不在本工作流的技能集里" },
    ]);
  });

  it("Action 勾选了 Tool 集之外的 Tool 时同样 422，并把两类越界一起列出", async () => {
    sqlite.exec(`
      INSERT INTO action_preloads VALUES ('action-1', 'skill-3', 1);
      INSERT INTO action_tools VALUES ('action-1', 'tool-3');
    `);
    const failure = await resolveWorkflow("workflow-1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WorkflowResolveError);
    if (!(failure instanceof WorkflowResolveError)) return;
    expect(failure.issues.map((issue) => issue.message)).toEqual([
      "Action「汇总」预载的技能「外部技能」不在本工作流的技能集里",
      "Action「汇总」可见的 Tool「外部工具」不在本工作流的 Tool 集里",
    ]);
  });

  it("不存在的工作流返回 null", async () => {
    expect(await resolveWorkflow("missing")).toBeNull();
  });
});
