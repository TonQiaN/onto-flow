/**
 * Tool 契约的 schema 闸门（ADR-0017）：写入口在 @/lib/json-schema-shape 的形状检查之上，
 * 再用**上游注册时同一套**子集断言核对 parameters 与 output，这样畸形 schema（required
 * 不是数组、properties 不是对象、type 数组……）在编辑器里就被拦下，而不是等到运行子进程
 * 注册插件时把整个运行拖倒。这是 @deepseek-ai 闭包只在 harness/ 导入这条规则下，写入口能
 * 拿到上游判断的唯一通道——形状那半边编辑器也要用，所以它住在 src/lib/，这里只加上游断言。
 */
import { assertObjectJsonSchema } from "@deepseek-ai/dsh-tools";
import { objectSchemaShapeProblem } from "@/lib/json-schema-shape";

/**
 * 对象根 schema：形状合规（本身是对象、type 恒为 "object"、不含 type 数组），且通过上游
 * assertObjectJsonSchema 的完整结构检查。返回中文错误文案；合法时返回 null。
 */
export function objectSchemaProblem(value: unknown, label: string): string | null {
  const shapeProblem = objectSchemaShapeProblem(value, label);
  if (shapeProblem) return shapeProblem;
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
