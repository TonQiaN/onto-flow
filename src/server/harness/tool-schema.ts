/**
 * Tool 契约的 schema 闸门（ADR-0017）：写入口用**上游注册时同一套**子集断言核对
 * parameters 与 output，这样畸形 schema（required 不是数组、properties 不是对象、
 * type 数组……）在编辑器里就被拦下，而不是等到运行子进程注册插件时把整个运行拖倒。
 * 这是 @deepseek-ai 闭包只在 harness/ 导入这条规则下，写入口能拿到上游判断的唯一通道。
 */
import { assertObjectJsonSchema } from "@deepseek-ai/dsh-tools";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 深度遍历，找到第一处 type 数组；返回它的 JSON 路径，没有则返回 null。 */
function findTypeArray(node: unknown, path: string): string | null {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      const found = findTypeArray(item, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isPlainObject(node)) return null;
  if (Array.isArray(node.type)) return `${path}.type`;
  for (const [key, value] of Object.entries(node)) {
    const found = findTypeArray(value, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

/**
 * 对象根 schema：本身是对象、type 恒为 "object"、不含 type 数组，且通过上游
 * assertObjectJsonSchema 的完整结构检查。返回中文错误文案；合法时返回 null。
 */
export function objectSchemaProblem(value: unknown, label: string): string | null {
  if (!isPlainObject(value)) return `${label} 必须是 JSON 对象`;
  if (value.type !== "object") return `${label} 必须是对象根 schema（type 为 "object"）`;
  const typeArray = findTypeArray(value, label);
  if (typeArray) {
    return `${typeArray} 不能是数组：上游 JSON Schema 子集不支持 type 数组，可空字段请省略而不是标成 null`;
  }
  try {
    assertObjectJsonSchema(value);
  } catch (err) {
    const violations = (err as { violations?: unknown }).violations;
    const detail = Array.isArray(violations)
      ? violations.map((v) => String(v).replace(/^schema\b/, label)).join("；")
      : err instanceof Error
        ? err.message
        : String(err);
    return `${label} 不符合上游 JSON Schema 子集：${detail}`;
  }
  return null;
}
