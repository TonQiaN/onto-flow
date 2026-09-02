/** Action 写入测试：循环契约与预载技能都要真实持久化，不只进修订 payload。 */
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, resetTestDb } from "./test-db";

const { sqlite } = await createTestDb();
const { createAction, loadActionDto, writeAction } = await import("./action");

beforeEach(() => {
  resetTestDb(sqlite);
  sqlite.exec(`
    INSERT INTO models VALUES ('model-1', 'deepseek-official', 'test-model', '测试模型');
    INSERT INTO skills (id, name, description, content, created_at, updated_at)
      VALUES ('skill-a', '范本技能', '', '正文', 0, 0), ('skill-b', '备用技能', '', '正文', 0, 0);
    INSERT INTO tools (id, name, public_name, description, parameters, output, timeout_ms, code, created_at, updated_at)
      VALUES ('tool-1', '归档', 'archive', '', '{"type":"object"}', NULL, NULL, 'export default async () => ({})', 0, 0);
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
    preloadSkillIds: [],
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

describe("Action 预载技能与可见 Tool", () => {
  it("preloadSkillIds 按顺序写入 action_preloads，DTO 与修订载荷都用同名字段", () => {
    const created = createAction({
      ...payload(0, "fail"),
      preloadSkillIds: ["skill-b", "skill-a", "skill-b"],
      toolIds: ["tool-1"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.preloadSkillIds).toEqual(["skill-b", "skill-a"]);
    expect(created.data.toolIds).toEqual(["tool-1"]);
    expect(
      sqlite
        .prepare("select skill_id as skillId, position from action_preloads where action_id = ? order by position")
        .all(created.data.id),
    ).toEqual([
      { skillId: "skill-b", position: 0 },
      { skillId: "skill-a", position: 1 },
    ]);

    const revision = sqlite
      .prepare("select payload from revisions where entity_kind = 'action' and entity_id = ?")
      .get(created.data.id) as { payload: string };
    expect(JSON.parse(revision.payload)).toMatchObject({
      preloadSkillIds: ["skill-b", "skill-a"],
      toolIds: ["tool-1"],
    });
    expect(JSON.parse(revision.payload)).not.toHaveProperty("skillIds");

    const updated = writeAction(created.data.id, { ...payload(0, "fail"), preloadSkillIds: ["skill-a"] });
    expect(updated.ok).toBe(true);
    expect(loadActionDto(created.data.id)?.preloadSkillIds).toEqual(["skill-a"]);
    expect(loadActionDto(created.data.id)?.toolIds).toEqual([]);
  });

  it("预载不存在的技能时 400；Action 保存不检查它是否在某个工作流的技能集里", () => {
    const missing = createAction({ ...payload(0, "fail"), preloadSkillIds: ["nope"] });
    expect(missing).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("预载") });

    const notInAnyWorkflow = createAction({ ...payload(0, "fail"), preloadSkillIds: ["skill-a"] });
    expect(notInAnyWorkflow.ok).toBe(true);
  });
});
