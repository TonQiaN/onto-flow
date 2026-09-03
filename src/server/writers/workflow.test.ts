/**
 * Workflow 写入测试：节点 id 会进入运行目录，写入边界必须先拒绝路径形状；三层设置里
 * 「Action 预载 ⊆ 技能集、可见 Tool ⊆ Tool 集」只在工作流保存时能检查（ADR-0016）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, resetTestDb } from "./test-db";

const { sqlite } = await createTestDb();
const { createWorkflow, loadWorkflowSets, writeWorkflow } = await import("./workflow");
const { createAction } = await import("./action");

beforeEach(() => {
  resetTestDb(sqlite);
  sqlite.exec(`
    INSERT INTO object_types (id, name, kind, description, builtin, created_at, updated_at)
      VALUES ('type-1', '报告', 'file', '', 0, 0, 0);
    INSERT INTO models VALUES ('model-1', 'deepseek-official', 'test-model', '测试模型');
    INSERT INTO skills (id, name, description, content, created_at, updated_at)
      VALUES ('skill-a', '范本技能', '', '正文', 0, 0), ('skill-b', '备用技能', '', '正文', 0, 0);
    INSERT INTO tools (id, name, public_name, description, parameters, output, timeout_ms, code, created_at, updated_at)
      VALUES ('tool-1', '盖章', 'stamp', '', '{"type":"object"}', NULL, NULL, 'export default async () => ({})', 0, 0),
             ('tool-2', '检查', 'check', '', '{"type":"object"}', NULL, NULL, 'export default async () => ({})', 0, 0);
  `);
});

function inputNode(id: string) {
  return { id, kind: "input", actionId: null, objectTypeId: "type-1", label: "输入", x: 0, y: 0 };
}

/** 库里一个预载 skill-a、可见 tool-1 的共享 Action，返回其 id。 */
function seedAction(): string {
  const created = createAction({
    name: "解析",
    prompt: "执行",
    modelId: "model-1",
    ports: [],
    preloadSkillIds: ["skill-a"],
    toolIds: ["tool-1"],
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.error);
  return created.data.id;
}

function actionNode(actionId: string) {
  return { id: "n1", kind: "action", actionId, objectTypeId: null, label: "解析", x: 0, y: 0 };
}

describe("Workflow 节点 id 路径安全", () => {
  it.each(["../escape", "nested/node", ".hidden", "中文节点"])(
    "拒绝不能作为单个 ASCII 目录段的 id：%s",
    (id) => {
      const created = createWorkflow({ name: "路径安全测试", description: "" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const result = writeWorkflow(created.data.id, { nodes: [inputNode(id)], edges: [] });
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
      nodes: [inputNode("n".repeat(256))],
      edges: [],
    });
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("不能超过 120 个 ASCII 字符"),
    });
  });
});

describe("Workflow 技能集与 Tool 集", () => {
  it("Action 预载的技能不在技能集里时 400，指名 Action 与技能", () => {
    const actionId = seedAction();
    const created = createWorkflow({ name: "子集校验", description: "" });
    if (!created.ok) throw new Error(created.error);

    const result = writeWorkflow(created.data.id, {
      skillIds: [],
      toolIds: ["tool-1"],
      nodes: [actionNode(actionId)],
      edges: [],
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) {
      expect(result.error).toContain("解析");
      expect(result.error).toContain("范本技能");
    }
  });

  it("Action 可见的 Tool 不在 Tool 集里时 400，指名 Action 与 Tool", () => {
    const actionId = seedAction();
    const created = createWorkflow({ name: "子集校验", description: "" });
    if (!created.ok) throw new Error(created.error);

    const result = writeWorkflow(created.data.id, {
      skillIds: ["skill-a"],
      toolIds: [],
      nodes: [actionNode(actionId)],
      edges: [],
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) {
      expect(result.error).toContain("解析");
      expect(result.error).toContain("盖章");
    }
  });

  it("集合齐全时写入两张关系表（带 position），修订载荷含完整定义", () => {
    const actionId = seedAction();
    const created = createWorkflow({ name: "完整保存", description: "" });
    if (!created.ok) throw new Error(created.error);

    const result = writeWorkflow(created.data.id, {
      instructions: "# 共同指令\n产物只写本目录。",
      settings: { toggles: { webSearch: true }, mcpServers: ["filesystem"] },
      skillIds: ["skill-b", "skill-a"],
      toolIds: ["tool-2", "tool-1"],
      nodes: [actionNode(actionId)],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.instructions).toBe("# 共同指令\n产物只写本目录。");
    expect(result.data.settings).toEqual({
      toggles: { webSearch: true },
      mcpServers: ["filesystem"],
    });

    expect(loadWorkflowSets(created.data.id)).toEqual({
      skillIds: ["skill-b", "skill-a"],
      toolIds: ["tool-2", "tool-1"],
    });
    expect(
      sqlite
        .prepare(
          "select skill_id as skillId, position from workflow_skills where workflow_id = ? order by position",
        )
        .all(created.data.id),
    ).toEqual([
      { skillId: "skill-b", position: 0 },
      { skillId: "skill-a", position: 1 },
    ]);

    const latest = sqlite
      .prepare(
        "select payload from revisions where entity_kind = 'workflow' and entity_id = ? order by version_no desc limit 1",
      )
      .get(created.data.id) as { payload: string };
    expect(JSON.parse(latest.payload)).toEqual({
      name: "完整保存",
      description: "",
      instructions: "# 共同指令\n产物只写本目录。",
      settings: { toggles: { webSearch: true }, mcpServers: ["filesystem"] },
      skillIds: ["skill-b", "skill-a"],
      toolIds: ["tool-2", "tool-1"],
      nodes: [actionNode(actionId)],
      edges: [],
    });
  });

  it("只发设置不发图时沿用库里当前的图：⊆ 仍按它校验，图不被改写，修订载荷带当前图", () => {
    const actionId = seedAction();
    const created = createWorkflow({ name: "设置页保存", description: "" });
    if (!created.ok) throw new Error(created.error);
    const withGraph = writeWorkflow(created.data.id, {
      skillIds: ["skill-a"],
      toolIds: ["tool-1"],
      nodes: [actionNode(actionId)],
      edges: [],
    });
    expect(withGraph.ok).toBe(true);

    // 把被预载的技能移出集合：图缺省，但校验对库里的图做，仍要 400 指名
    const removed = writeWorkflow(created.data.id, { skillIds: [], toolIds: ["tool-1"] });
    expect(removed).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("预载"),
    });

    // 只改指令：图原样保留，修订载荷带的是库里当前的图
    const onlySettings = writeWorkflow(created.data.id, { instructions: "# 只改指令" });
    expect(onlySettings.ok).toBe(true);
    expect(
      sqlite
        .prepare("select count(*) as c from workflow_nodes where workflow_id = ?")
        .get(created.data.id),
    ).toEqual({ c: 1 });
    const latest = sqlite
      .prepare(
        "select payload from revisions where entity_kind = 'workflow' and entity_id = ? order by version_no desc limit 1",
      )
      .get(created.data.id) as { payload: string };
    expect(JSON.parse(latest.payload)).toMatchObject({
      instructions: "# 只改指令",
      nodes: [actionNode(actionId)],
    });

    // 只给一半图是形状错误
    expect(writeWorkflow(created.data.id, { nodes: [] })).toMatchObject({ ok: false, status: 400 });
  });

  it("只发图不发集合时沿用现有集合，画布保存不会把技能集清空", () => {
    const actionId = seedAction();
    const created = createWorkflow({
      name: "画布保存",
      description: "",
      skillIds: ["skill-a"],
      toolIds: ["tool-1"],
    });
    if (!created.ok) throw new Error(created.error);
    expect(loadWorkflowSets(created.data.id)).toEqual({
      skillIds: ["skill-a"],
      toolIds: ["tool-1"],
    });

    const result = writeWorkflow(created.data.id, { nodes: [actionNode(actionId)], edges: [] });
    expect(result.ok).toBe(true);
    expect(loadWorkflowSets(created.data.id)).toEqual({
      skillIds: ["skill-a"],
      toolIds: ["tool-1"],
    });
  });

  it("技能集里的 id 不存在时 400", () => {
    const created = createWorkflow({ name: "坏引用", description: "" });
    if (!created.ok) throw new Error(created.error);
    const result = writeWorkflow(created.data.id, { skillIds: ["missing"], nodes: [], edges: [] });
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("missing"),
    });
  });
});

describe("Workflow 设置校验", () => {
  it.each([
    [{ toggles: { search: true } }, "不认识的开关"],
    [{ toggles: { webSearch: "yes" } }, "布尔值"],
    [{ mcpServers: ["bad name!"] }, "MCP 服务器名"],
    [{ mcpServers: "filesystem" }, "字符串数组"],
    [{ extra: 1 }, "不认识的字段"],
    ["文本", "JSON 对象"],
  ])("拒绝非法 settings：%j", (settings, fragment) => {
    const created = createWorkflow({ name: "设置校验", description: "" });
    if (!created.ok) throw new Error(created.error);
    const result = writeWorkflow(created.data.id, { settings, nodes: [], edges: [] });
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining(fragment),
    });
  });

  it("指令超过 64 KiB 时 400", () => {
    const created = createWorkflow({ name: "指令上限", description: "" });
    if (!created.ok) throw new Error(created.error);
    const result = writeWorkflow(created.data.id, {
      instructions: "字".repeat(64 * 1024),
      nodes: [],
      edges: [],
    });
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("64 KiB"),
    });
  });

  it("mcpServers 去重，toggles 只存写了的键", () => {
    const created = createWorkflow({ name: "设置持久化", description: "" });
    if (!created.ok) throw new Error(created.error);
    const result = writeWorkflow(created.data.id, {
      settings: { toggles: { compaction: false }, mcpServers: ["a", "a", "b"] },
      nodes: [],
      edges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.settings).toEqual({
      toggles: { compaction: false },
      mcpServers: ["a", "b"],
    });
  });
});
