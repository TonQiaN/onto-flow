/** 引用服务测试：Skill 与 Tool 的引用方是工作流的技能集 / Tool 集，Action 的预载与可见不算引用（ADR-0016）。 */
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, resetTestDb } from "./writers/test-db";

const { sqlite } = await createTestDb();
const { referencesOf, refCounts, orphans } = await import("./references");
const { createWorkflow } = await import("./writers/workflow");
const { createAction } = await import("./writers/action");

beforeEach(() => {
  resetTestDb(sqlite);
  sqlite.exec(`
    INSERT INTO models VALUES ('model-1', 'deepseek-official', 'test-model', '测试模型');
    INSERT INTO skills (id, name, description, content, created_at, updated_at)
      VALUES ('skill-a', '范本技能', '', '正文', 0, 0), ('skill-b', '备用技能', '', '正文', 0, 0);
    INSERT INTO tools (id, name, public_name, description, parameters, output, timeout_ms, code, created_at, updated_at)
      VALUES ('tool-1', '盖章', 'stamp', '', '{"type":"object"}', NULL, NULL, 'export default async () => ({})', 0, 0),
             ('tool-2', '检查', 'check', '', '{"type":"object"}', NULL, NULL, 'export default async () => ({})', 0, 0);
  `);
});

function seedWorkflow(name: string, skillIds: string[], toolIds: string[]): string {
  const created = createWorkflow({ name, description: "", skillIds, toolIds });
  if (!created.ok) throw new Error(created.error);
  return created.data.id;
}

describe("Skill 与 Tool 的引用方", () => {
  it("技能集里的技能被工作流引用，跳转到工作流设置页", () => {
    const wfA = seedWorkflow("质检", ["skill-a"], []);
    const wfB = seedWorkflow("简历", ["skill-a", "skill-b"], ["tool-1"]);

    // 按工作流名排序（SQLite 二进制序：简 < 质）
    expect(referencesOf("skill", "skill-a")).toEqual([
      {
        kind: "workflow",
        id: wfB,
        name: "简历",
        detail: "技能集",
        href: `/workflows/${wfB}/settings`,
      },
      {
        kind: "workflow",
        id: wfA,
        name: "质检",
        detail: "技能集",
        href: `/workflows/${wfA}/settings`,
      },
    ]);
    expect(referencesOf("tool", "tool-1")).toEqual([
      {
        kind: "workflow",
        id: wfB,
        name: "简历",
        detail: "Tool 集",
        href: `/workflows/${wfB}/settings`,
      },
    ]);
    expect(referencesOf("tool", "tool-2")).toEqual([]);

    expect(refCounts("skill")).toEqual({ "skill-a": 2, "skill-b": 1 });
    expect(refCounts("tool")).toEqual({ "tool-1": 1 });
    expect(orphans("tool").map((o) => o.id)).toEqual(["tool-2"]);
  });

  it("Action 的预载与可见 Tool 不构成引用", () => {
    const created = createAction({
      name: "解析",
      prompt: "执行",
      modelId: "model-1",
      ports: [],
      preloadSkillIds: ["skill-b"],
      toolIds: ["tool-2"],
    });
    expect(created.ok).toBe(true);

    expect(referencesOf("skill", "skill-b")).toEqual([]);
    expect(referencesOf("tool", "tool-2")).toEqual([]);
    expect(refCounts("skill")).toEqual({});
    expect(refCounts("tool")).toEqual({});
  });
});
