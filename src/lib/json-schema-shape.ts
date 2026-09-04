/**
 * 对象根 JSON Schema 的形状检查——写入口（`src/server/harness/tool-schema.ts`）与
 * Tool 编辑器（`src/app/tools/tool-form.ts`）共有的那半边。
 *
 * 只做「本身是对象、type 恒为 object、任何层级不出现 type 数组」这三条；上游
 * `assertObjectJsonSchema` 的完整子集断言留在 `harness/tool-schema.ts`，因为
 * `@deepseek-ai` 闭包只准在 `harness/` 导入，门禁因此仍在服务端。放在 `src/lib/` 是
 * 因为编辑器要在保存前给出同一句话，而客户端不能从 `@/server` 导入运行时值。
 *
 * 纯模块：不 import 任何东西。
 */

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
 * 对象根 schema 的形状半边：本身是对象、type 恒为 "object"、任何层级不出现 type 数组。
 * 返回中文错误文案；形状合法时返回 null——**这不代表整份 schema 合法**，写入口还要过
 * 上游断言（`objectSchemaProblem`）。
 */
export function objectSchemaShapeProblem(value: unknown, label: string): string | null {
  if (!isPlainObject(value)) return `${label} 必须是 JSON 对象`;
  if (value.type !== "object") return `${label} 必须是对象根 schema（type 为 "object"）`;
  const typeArray = findTypeArray(value, label);
  if (typeArray) {
    return `${typeArray} 不能是数组：上游 JSON Schema 子集不支持 type 数组，可空字段请省略而不是标成 null`;
  }
  return null;
}
