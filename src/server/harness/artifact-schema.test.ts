import { describe, expect, it } from "vitest";
import { artifactSchemaProblem, validateJsonArtifact } from "./artifact-schema";

const schema = JSON.stringify({
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
});

describe("JSON 产物契约", () => {
  it.each([
    ["缺少 items", "{}", "$.items", "未提供"],
    ["多余字段", '{"items":[],"wrong":true}', "$.wrong", "true"],
    ["类型错误", '{"items":"wrong"}', "$.items", '"wrong"'],
    ["嵌套错误", '{"items":[{"task":7}]}', "$.items[0].task", "7"],
    ["无效 JSON", "{broken", "$", "无效 JSON"],
  ])("拒绝%s并给出字段和实际值", (_name, text, path, actual) => {
    expect(validateJsonArtifact(text, schema)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path, actual: expect.stringContaining(actual) }),
      ]),
    );
  });
  it("有效结构通过；没有自定义契约时仍检查 JSON 语法，并支持数组根", () => {
    expect(validateJsonArtifact('{"items":[{"task":"检查"}]}', schema)).toEqual([]);
    expect(validateJsonArtifact("[1,2]", null)).toEqual([]);
    expect(validateJsonArtifact("[1]", '{"type":"array","items":{"type":"integer"}}')).toEqual([]);
    expect(validateJsonArtifact("不是 JSON", null)).not.toEqual([]);
  });
  it("不支持的 Schema 关键字、错拼的类型和畸形 required 都在写入口失败", () => {
    for (const text of [
      '{"type":"object","minimum":1}',
      '{"type":"arry"}',
      '{"type":"object","required":"items"}',
      '{"$ref":"https://example.com/schema"}',
    ])
      expect(artifactSchemaProblem(text)).not.toBeNull();
    expect(artifactSchemaProblem(schema)).toBeNull();
  });
  it("枚举与 oneOf 按上游同一套规则验收", () => {
    expect(validateJsonArtifact('"b"', '{"type":"string","enum":["a"]}')).not.toEqual([]);
    expect(
      validateJsonArtifact("3", '{"oneOf":[{"type":"number"},{"type":"integer"}]}'),
    ).not.toEqual([]);
  });
});
