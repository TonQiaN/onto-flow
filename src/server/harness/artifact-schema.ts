/** JSON 产物与 Tool 共用上游实际执行的 Schema 子集；不接受未落实的校验关键字。 */
import { assertSupportedJsonSchema, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import {
  MAX_ARTIFACT_SCHEMA_BYTES,
  MAX_JSON_ARTIFACT_BYTES,
  type ContractIssue,
} from "@/lib/artifact-contract";

const TYPE_NAMES: Record<string, string> = {
  object: "对象",
  array: "数组",
  string: "字符串",
  number: "数值",
  integer: "整数",
  boolean: "布尔值",
  null: "null",
};

/** 有边界的实值预览，错误日志不复制整份文件。 */
function preview(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

export function artifactSchemaProblem(text: string | null): string | null {
  if (text === null) return null;
  if (Buffer.byteLength(text, "utf8") > MAX_ARTIFACT_SCHEMA_BYTES)
    return "JSON Schema 不能超过 64 KiB";
  let schema: unknown;
  try {
    schema = JSON.parse(text);
  } catch {
    return "JSON Schema 不是合法 JSON";
  }
  try {
    assertSupportedJsonSchema(schema);
  } catch (error) {
    const violations = (error as { violations?: string[] }).violations ?? [];
    const locations = violations.map((v) => v.split(" ")[0]).join("、");
    return `JSON Schema 不符合支持的契约子集${locations ? `（${locations}）` : ""}：仅支持单一 type、properties、required、additionalProperties、items、enum、const、oneOf 及说明字段；不支持的关键字不会被静默忽略`;
  }
  return null;
}

/**
 * 上游负责判断；这里只给其字段诊断补中文期望与有界实值。
 * 路径由上游的点/数组记法生成，键名造成歧义时明确提示查看原文件，不猜某一个值。
 */
export function validateJsonArtifact(content: string, schemaText: string | null): ContractIssue[] {
  if (Buffer.byteLength(content, "utf8") > MAX_JSON_ARTIFACT_BYTES)
    return [{ path: "$", expected: "不超过 32 MiB 的 JSON 文件", actual: "文件超过解析上限" }];
  const problem = artifactSchemaProblem(schemaText);
  if (problem) return [{ path: "$schema", expected: "可执行的 JSON 契约", actual: problem }];
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return [
      { path: "$", expected: "可解析的 JSON", actual: `无效 JSON：${content.slice(0, 180)}` },
    ];
  }
  const schema: unknown = schemaText === null ? {} : JSON.parse(schemaText);
  assertSupportedJsonSchema(schema);
  const violations = validateJsonSchemaValue(schema, value, "$");
  if (violations.length === 0) return [];
  const locations = new Map<string, unknown>();
  const ambiguous = new Set<string>();
  const stack = [{ path: "$", value }];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (locations.has(item.path)) ambiguous.add(item.path);
    locations.set(item.path, item.value);
    if (Array.isArray(item.value))
      item.value.forEach((v, i) => stack.push({ path: `${item.path}[${i}]`, value: v }));
    else if (item.value !== null && typeof item.value === "object")
      for (const [key, v] of Object.entries(item.value))
        stack.push({ path: `${item.path}.${key}`, value: v });
  }
  const paths = [...locations.keys()].sort((a, b) => b.length - a.length);
  return violations.slice(0, 50).map((violation) => {
    const missing = /^missing required property "(.*)"$/s.exec(violation);
    if (missing) return { path: missing[1], expected: "必填字段", actual: "未提供" };
    const field = paths.find((p) => violation.startsWith(`"${p}" `)) ?? "$";
    const detail = violation.slice(field.length + 3);
    const type = /must be (?:an? )?(object|array|string|number|integer|boolean|null)$/.exec(detail);
    let expected = type ? TYPE_NAMES[type[1]] : "符合声明的 JSON 契约";
    if (detail.includes("not a declared property"))
      expected = "没有额外字段（additionalProperties: false）";
    else if (detail.includes("oneOf")) expected = "恰好满足 oneOf 中的一项契约";
    else if (detail.startsWith("must be one of"))
      expected = detail.replace("must be one of", "允许值为");
    else if (detail.startsWith("must equal")) expected = detail.replace("must equal", "固定值为");
    return {
      path: field,
      expected,
      actual: ambiguous.has(field) ? "字段路径有歧义，请查看原文件" : preview(locations.get(field)),
    };
  });
}
