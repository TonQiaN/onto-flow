/**
 * Tool 编辑器的纯函数：把表单文本解析成契约字段，并在客户端先做一遍写入口
 * （src/server/writers/tool.ts、harness/tool-schema.ts）的形状校验，让作者在编辑器里
 * 看到问题而不是在保存被 400 打回时。这里只镜像了形状规则（对象根、type 数组、公名、超时、
 * 保留名、@deepseek-ai 引用）；上游 assertObjectJsonSchema 的完整子集断言只在写入口跑，
 * 所以门禁仍在服务端。公名正则与保留名清单与 src/server/harness/tool-contract.ts 是同一份
 * ——客户端不能从 @/server 导入运行时值，tool-form.test.ts 钉住两边一致。
 */

export const TOOL_PUBLIC_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** 与 tool-contract.ts 的 TOOL_RESERVED_PUBLIC_NAMES 同一份：上游内建工具名与会话数据面工具名 */
export const TOOL_RESERVED_PUBLIC_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "edit",
  "read",
  "read_image",
  "write",
  "glob",
  "grep",
  "skill",
  "str_replace_editor",
  "todo_write",
  "web_search",
  "web_fetch",
  "run_code",
  "structured_output",
]);

/** 与 tool-contract.ts 的 TOOL_RESERVED_PUBLIC_NAME_PREFIX 同一份：MCP 工具的公名空间 */
export const TOOL_RESERVED_PUBLIC_NAME_PREFIX = "mcp__";

export type SchemaParse<T> = { ok: true; value: T } | { ok: false; error: string };

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

/** 对象根 schema：本身是对象、type 恒为 "object"、任何层级不出现 type 数组。 */
export function objectSchemaProblem(value: unknown, label: string): string | null {
  if (!isPlainObject(value)) return `${label} 必须是 JSON 对象`;
  if (value.type !== "object") return `${label} 必须是对象根 schema（type 为 "object"）`;
  const typeArray = findTypeArray(value, label);
  if (typeArray) {
    return `${typeArray} 不能是数组：上游 JSON Schema 子集不支持 type 数组，可空字段请省略而不是标成 null`;
  }
  return null;
}

/** 参数 schema 文本框：必填，须是对象根 schema */
export function parseObjectSchemaText(
  text: string,
  label: string,
): SchemaParse<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `${label} 不是合法的 JSON` };
  }
  const problem = objectSchemaProblem(parsed, label);
  if (problem) return { ok: false, error: problem };
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** 返回值 schema 文本框：留空即不校验返回值（null） */
export function parseOptionalObjectSchemaText(
  text: string,
  label: string,
): SchemaParse<Record<string, unknown> | null> {
  if (text.trim() === "") return { ok: true, value: null };
  return parseObjectSchemaText(text, label);
}

/** 超时文本框：留空即不限（null）；否则必须是正整数毫秒 */
export function parseTimeoutText(text: string): SchemaParse<number | null> {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0 || !Number.isSafeInteger(Number(trimmed)))
    return { ok: false, error: "timeoutMs 必须是正整数（毫秒）" };
  return { ok: true, value: Number(trimmed) };
}

export function publicNameProblem(publicName: string): string | null {
  if (!TOOL_PUBLIC_NAME_PATTERN.test(publicName))
    return `模型可见的工具名「${publicName}」非法：小写字母开头，只含小写字母、数字与下划线，最长 64 位`;
  if (TOOL_RESERVED_PUBLIC_NAMES.has(publicName))
    return `模型可见的工具名「${publicName}」是上游内建工具或会话数据面工具的名字，契约 Tool 不能占用`;
  if (publicName.startsWith(TOOL_RESERVED_PUBLIC_NAME_PREFIX))
    return `模型可见的工具名「${publicName}」用了 MCP 工具的前缀 ${TOOL_RESERVED_PUBLIC_NAME_PREFIX}，契约 Tool 不能占用`;
  return null;
}

/** execute 模块：非空，且不得引用上游闭包（那是又在写裸插件） */
export function toolCodeProblem(code: string): string | null {
  if (code.trim() === "") return "execute 模块源码不能为空";
  if (code.includes("@deepseek-ai/"))
    return "execute 模块不能引用 @deepseek-ai/*：Tool 只经 ctx 拿能力，上游 API 由平台包装承接（ADR-0017）";
  return null;
}

export function formatSchema(value: Record<string, unknown> | null): string {
  return value === null ? "" : JSON.stringify(value, null, 2);
}

export const TOOL_PARAMETERS_TEMPLATE = formatSchema({
  type: "object",
  additionalProperties: false,
  properties: {
    input: { type: "string", description: "参数说明" },
  },
  required: ["input"],
});

/**
 * 新建 Tool 时的 execute 模块骨架。只有默认导出是契约；ctx 的字段在注释里逐个说明，
 * 类型来自 src/server/harness/tool-contract.ts（import type 在运行时被擦掉，不参与解析）。
 */
export const TOOL_EXECUTE_TEMPLATE = `/**
 * OntoFlow Tool 的 execute 模块（ADR-0017）：默认导出一个 async 函数，运行时由平台
 * 包装成 cordis 工具，按上面的契约字段（公名、描述、参数 schema、返回值 schema、超时）注册。
 * 这里可以 import node: 内置模块与仓库依赖；不能 import 上游闭包（@deepseek-ai 系列包）。
 *
 * ctx 的全部字段（都是绝对路径；env 只含白名单）：
 *   ctx.workspaceDir  本次运行的工作区（会话 cwd），产物只写这里
 *   ctx.runDir        本次运行的运行目录
 *   ctx.tmpDir        本次运行独占的临时目录
 *   ctx.dataDir       工作台数据根 data/；要落备份文件时用它
 *   ctx.dbPath        工作台数据库文件；要读写工作台库时用 node:sqlite 打开它
 *   ctx.cwd           调用本工具的会话的 cwd
 *   ctx.env           白名单环境变量：全局设置里登记的凭据引用名 + ONTOFLOW_DB_PATH / ONTOFLOW_DATA_DIR
 *   ctx.signal        会话取消即触发的 AbortSignal；长时间工作要把它传下去
 *   ctx.run(command, { cwd?, timeoutMs? })
 *                     在与 bash 工具同一道沙箱围栏里跑一条命令；默认 60 s，上限 120 s。
 *                     返回 { stdout, stderr, exitCode, timedOut, sandbox: { mode, enforced, runnerFailed, denied } }：
 *                     只有 sandbox.enforced && !sandbox.runnerFailed 才代表围栏真的包住了这次执行。
 *
 * 返回值原样交给模型（若声明了返回值 schema，会按它校验）。
 */
import type { ToolContext } from "@/server/harness/tool-contract";

export default async function execute(args: { input: string }, ctx: ToolContext) {
  // TODO: 在这里实现工具逻辑；例如在沙箱里跑一条命令：
  // const result = await ctx.run("ls -la", { cwd: ctx.workspaceDir });
  // if (!(result.sandbox.enforced && !result.sandbox.runnerFailed)) return { ok: false };
  return { ok: true, input: args.input };
}
`;
