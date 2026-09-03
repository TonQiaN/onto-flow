import { describe, expect, it } from "vitest";
import {
  TOOL_PUBLIC_NAME_PATTERN as SERVER_PUBLIC_NAME_PATTERN,
  TOOL_RESERVED_PUBLIC_NAME_PREFIX as SERVER_RESERVED_PUBLIC_NAME_PREFIX,
  TOOL_RESERVED_PUBLIC_NAMES as SERVER_RESERVED_PUBLIC_NAMES,
} from "@/server/harness/tool-contract";
import {
  formatSchema,
  parseObjectSchemaText,
  parseOptionalObjectSchemaText,
  parseTimeoutText,
  publicNameProblem,
  TOOL_EXECUTE_TEMPLATE,
  TOOL_PARAMETERS_TEMPLATE,
  TOOL_PUBLIC_NAME_PATTERN,
  TOOL_RESERVED_PUBLIC_NAME_PREFIX,
  TOOL_RESERVED_PUBLIC_NAMES,
  toolCodeProblem,
} from "./tool-form";

describe("与写入口同一份规则", () => {
  it("公名正则与保留名清单和 src/server/harness/tool-contract.ts 一致", () => {
    expect(TOOL_PUBLIC_NAME_PATTERN.source).toBe(SERVER_PUBLIC_NAME_PATTERN.source);
    expect([...TOOL_RESERVED_PUBLIC_NAMES].sort()).toEqual(
      [...SERVER_RESERVED_PUBLIC_NAMES].sort(),
    );
    expect(TOOL_RESERVED_PUBLIC_NAME_PREFIX).toBe(SERVER_RESERVED_PUBLIC_NAME_PREFIX);
  });

  it("保留名与非法形状各报一句", () => {
    expect(publicNameProblem("bash")).toMatch(/内建/);
    expect(publicNameProblem("structured_output")).toMatch(/内建/);
    expect(publicNameProblem("mcp__fs__read")).toMatch(/MCP 工具的前缀/);
    expect(publicNameProblem("Bash")).toMatch(/非法/);
    expect(publicNameProblem("my_tool")).toBeNull();
  });
});

describe("参数 schema 文本框", () => {
  it("合法的对象根 schema 解析成对象", () => {
    const parsed = parseObjectSchemaText(TOOL_PARAMETERS_TEMPLATE, "parameters");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.type).toBe("object");
  });

  it("非 JSON、非对象、type 不是 object、含 type 数组各报一句", () => {
    expect(parseObjectSchemaText("{", "parameters")).toEqual({
      ok: false,
      error: "parameters 不是合法的 JSON",
    });
    expect(parseObjectSchemaText("[]", "parameters")).toEqual({
      ok: false,
      error: "parameters 必须是 JSON 对象",
    });
    expect(parseObjectSchemaText('{"type":"string"}', "parameters")).toEqual({
      ok: false,
      error: 'parameters 必须是对象根 schema（type 为 "object"）',
    });
    const withArray = parseObjectSchemaText(
      '{"type":"object","properties":{"n":{"type":["integer","null"]}}}',
      "output",
    );
    expect(withArray.ok).toBe(false);
    if (!withArray.ok) expect(withArray.error).toMatch(/^output\.properties\.n\.type 不能是数组/);
  });

  it("返回值 schema 留空即 null，非空按同一套规则", () => {
    expect(parseOptionalObjectSchemaText("  ", "output")).toEqual({ ok: true, value: null });
    expect(parseOptionalObjectSchemaText('{"type":"object"}', "output")).toEqual({
      ok: true,
      value: { type: "object" },
    });
    expect(parseOptionalObjectSchemaText("x", "output").ok).toBe(false);
  });
});

describe("其余字段", () => {
  it("超时留空即 null，否则必须是正整数毫秒", () => {
    expect(parseTimeoutText("")).toEqual({ ok: true, value: null });
    expect(parseTimeoutText("30000")).toEqual({ ok: true, value: 30000 });
    expect(parseTimeoutText("0").ok).toBe(false);
    expect(parseTimeoutText("-1").ok).toBe(false);
    expect(parseTimeoutText("1.5").ok).toBe(false);
    expect(parseTimeoutText("abc").ok).toBe(false);
  });

  it("公名必须小写字母开头、只含小写字母数字下划线、最长 64 位", () => {
    expect(publicNameProblem("validate_resume_match_result")).toBeNull();
    expect(publicNameProblem("a".repeat(64))).toBeNull();
    expect(publicNameProblem("Save")).toMatch(/非法/);
    expect(publicNameProblem("1abc")).toMatch(/非法/);
    expect(publicNameProblem("a-b")).toMatch(/非法/);
    expect(publicNameProblem("a".repeat(65))).toMatch(/非法/);
    expect(publicNameProblem("")).toMatch(/非法/);
  });

  it("execute 模块非空且不得引用 @deepseek-ai/*；模板本身合法", () => {
    expect(toolCodeProblem("   ")).toMatch(/不能为空/);
    expect(toolCodeProblem('import { x } from "@deepseek-ai/cordis";')).toMatch(/@deepseek-ai/);
    expect(toolCodeProblem(TOOL_EXECUTE_TEMPLATE)).toBeNull();
    expect(TOOL_EXECUTE_TEMPLATE).toContain("export default async function execute(");
  });

  it("schema 回填文本：null 为空串，对象为两空格缩进 JSON", () => {
    expect(formatSchema(null)).toBe("");
    expect(formatSchema({ type: "object" })).toBe('{\n  "type": "object"\n}');
  });
});
