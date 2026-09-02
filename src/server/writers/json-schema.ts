/**
 * 上游 JSON Schema 子集的写入口校验。上游 cordis 工具注册表在插件加载时校验 schema，
 * 一个 `type: ["integer", "null"]` 就让整个运行在任何节点开跑前倒下——所以库写入时
 * 先挡住，让作者在编辑器里看到，而不是在付费运行的日志里看到。
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
 * 对象根 schema：本身是对象、`type` 恒为 "object"、任何层级不出现 type 数组。
 * 返回中文错误文案；合法时返回 null。label 是字段名，如「parameters」。
 */
export function objectSchemaProblem(value: unknown, label: string): string | null {
  if (!isPlainObject(value)) return `${label} 必须是 JSON 对象`;
  if (value.type !== "object") return `${label} 必须是对象根 schema（type 为 "object"）`;
  const typeArray = findTypeArray(value, label);
  if (typeArray) {
    return `${typeArray} 不能是数组：上游 JSON Schema 子集不支持 type 数组，可空字段请省略而不是标成 null`;
  }
  return null;
}
