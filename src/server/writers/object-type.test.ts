import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, resetTestDb } from "./test-db";

const { sqlite } = await createTestDb();
const { createObjectType, writeObjectType } = await import("./object-type");
beforeEach(() => resetTestDb(sqlite));
const schema = '{"type":"object","properties":{"items":{"type":"array"}},"required":["items"]}';

describe("对象类型的 JSON 契约写边界", () => {
  it.each(["{bad", '{"type":"mystery"}', '{"type":"number","minimum":1}', '{"$ref":"remote"}'])(
    "非法或不支持的契约不写实体与修订：%s",
    (jsonSchema) => {
      expect(createObjectType({ name: "契约", kind: "json", jsonSchema })).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(sqlite.prepare("SELECT count(*) AS n FROM object_types").get()).toEqual({ n: 0 });
      expect(sqlite.prepare("SELECT count(*) AS n FROM revisions").get()).toEqual({ n: 0 });
    },
  );

  it("更新拒绝后旧契约和修订保留，合法契约完整记录", () => {
    const created = createObjectType({ name: "契约", kind: "json", jsonSchema: schema });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(
      writeObjectType(created.data.id, { name: "契约", kind: "json", jsonSchema: '{"minimum":2}' }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      sqlite.prepare("SELECT json_schema FROM object_types WHERE id = ?").get(created.data.id),
    ).toEqual({ json_schema: schema });
    const revisions = sqlite.prepare("SELECT payload FROM revisions").all() as Array<{
      payload: string;
    }>;
    expect(revisions).toHaveLength(1);
    expect(JSON.parse(revisions[0].payload).jsonSchema).toBe(schema);
  });

  it("非 JSON 类型不能挂契约，无契约的 JSON 仍可保存", () => {
    expect(createObjectType({ name: "文本", kind: "text", jsonSchema: schema })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(createObjectType({ name: "JSON", kind: "json", jsonSchema: null })).toMatchObject({
      ok: true,
      data: { jsonSchema: null },
    });
    expect(createObjectType({ name: "错误形状", kind: "json", jsonSchema: {} })).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});
