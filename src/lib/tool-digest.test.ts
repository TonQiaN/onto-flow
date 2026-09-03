import { describe, expect, it } from "vitest";
import { canonicalJson, toolContractSha256, type ToolContractDigestInput } from "./tool-digest";

function contract(overrides: Partial<ToolContractDigestInput> = {}): ToolContractDigestInput {
  return {
    publicName: "stamp",
    description: "盖章",
    parameters: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" } },
    },
    output: null,
    timeoutMs: null,
    code: "export default async function execute(args) { return args; }",
    ...overrides,
  };
}

describe("Tool 契约摘要", () => {
  it("规范 JSON 只排序对象键，数组保序", () => {
    expect(canonicalJson({ b: [2, 1], a: { d: null, c: "x" } })).toBe(
      '{"a":{"c":"x","d":null},"b":[2,1]}',
    );
  });

  it("schema 键顺序与 null/缺省的 output、timeoutMs 不改变摘要", () => {
    const reordered = contract({
      parameters: {
        properties: { text: { type: "string" } },
        required: ["text"],
        type: "object",
      },
    });
    expect(toolContractSha256(reordered)).toBe(toolContractSha256(contract()));
    expect(
      toolContractSha256({
        ...contract(),
        output: undefined as unknown as null,
        timeoutMs: undefined as unknown as null,
      }),
    ).toBe(toolContractSha256(contract()));
  });

  it.each([
    ["公名", { publicName: "stamp_v2" }],
    ["描述", { description: "改过的描述" }],
    ["参数 schema", { parameters: { type: "object", required: [], properties: {} } }],
    ["输出 schema", { output: { type: "object" } }],
    ["超时", { timeoutMs: 1000 }],
    ["execute 源码", { code: "export default async function execute() { return 1; }" }],
  ])("%s 变化会改变摘要", (_field, overrides) => {
    expect(toolContractSha256(contract(overrides))).not.toBe(toolContractSha256(contract()));
  });
});
