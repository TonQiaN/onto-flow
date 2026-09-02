/** Tool 写入测试：契约字段在写入口校验（ADR-0017），唯一性交给数据库。 */
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, resetTestDb } from "./test-db";

const { sqlite } = await createTestDb();
const { createTool, writeTool } = await import("./tool");

beforeEach(() => resetTestDb(sqlite));

const valid = {
  name: "归档集采计划",
  publicName: "save_purchase_plan",
  description: "把计划写进 purchase_plans",
  parameters: { type: "object", properties: { planNo: { type: "string" } }, required: ["planNo"] },
  output: { type: "object", properties: { ok: { type: "boolean" } } },
  timeoutMs: 30_000,
  code: "export default async function execute(args, ctx) { return { ok: true }; }",
};

describe("Tool 契约校验", () => {
  it.each([
    [{ publicName: "Save" }, "工具名"],
    [{ publicName: "1abc" }, "工具名"],
    [{ publicName: "a-b" }, "工具名"],
    [{ publicName: "a".repeat(65) }, "工具名"],
    // 保留名：与上游内建同名的包装在 boot 时撞名、整个运行起不来；structured_output 会遮蔽会话数据面
    [{ publicName: "bash" }, "内建"],
    [{ publicName: "structured_output" }, "内建"],
    [{ parameters: { type: "string" } }, "对象根"],
    [{ parameters: "{}" }, "parameters"],
    [{ parameters: { type: "object", properties: { n: { type: ["integer", "null"] } } } }, "type 数组"],
    [{ output: { type: "object", properties: { items: { type: "array", items: { type: ["string", "null"] } } } } }, "type 数组"],
    [{ output: { type: "array" } }, "对象根"],
    [{ timeoutMs: 0 }, "正整数"],
    [{ timeoutMs: 1.5 }, "正整数"],
    // 畸形关键字形状要在写入口拦下：output 在插件注册时才炸会拖倒整个运行
    [{ parameters: { type: "object", required: "x" } }, "子集"],
    [{ output: { type: "object", properties: "no" } }, "子集"],
    [{ parameters: { type: "object", properties: { n: { type: "integer", enum: "1" } } } }, "子集"],
    [{ code: "   " }, "不能为空"],
    [{ code: 'import { x } from "@deepseek-ai/dsh-core";' }, "@deepseek-ai"],
  ])("拒绝 %j", (patch, fragment) => {
    const result = createTool({ ...valid, ...patch });
    expect(result).toMatchObject({ ok: false, status: 400, error: expect.stringContaining(fragment) });
  });

  it("type 数组的错误指到具体路径", () => {
    const result = createTool({
      ...valid,
      parameters: { type: "object", properties: { n: { type: ["integer", "null"] } } },
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("parameters.properties.n.type") });
  });

  it("output 与 timeoutMs 可省略，落库为 null", () => {
    const result = createTool({ ...valid, output: undefined, timeoutMs: undefined });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ publicName: "save_purchase_plan", output: null, timeoutMs: null });
    expect(result.data.parameters).toEqual(valid.parameters);
  });
});

describe("Tool 写入", () => {
  it("新建与更新都写全部契约字段，修订载荷含完整契约", () => {
    const created = createTool(valid);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data).toMatchObject({ ...valid });

    const updated = writeTool(created.data.id, { ...valid, publicName: "archive_plan", timeoutMs: null });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.data).toMatchObject({ publicName: "archive_plan", timeoutMs: null });

    const revision = sqlite
      .prepare(
        "select payload from revisions where entity_kind = 'tool' and entity_id = ? order by version_no desc limit 1",
      )
      .get(created.data.id) as { payload: string };
    expect(JSON.parse(revision.payload)).toEqual({ ...valid, publicName: "archive_plan", timeoutMs: null });
  });

  it("publicName 重复由数据库唯一约束拒绝（handle() 映射为 409）", () => {
    expect(createTool(valid).ok).toBe(true);
    expect(() => createTool({ ...valid, name: "另一个名字" })).toThrow(/UNIQUE constraint failed/);
  });
});
