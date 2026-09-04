/**
 * Tool 编辑器的纯函数：把表单文本解析成契约字段，并在客户端先做一遍写入口
 * （src/server/writers/tool.ts、harness/tool-schema.ts）的形状校验，让作者在编辑器里
 * 看到问题而不是在保存被 400 打回时。公名规则、execute 模块检查与对象根 schema 的形状半边
 * 都从 `@/lib/` 取，与写入口同一份实现，不再两处各抄一遍；上游 assertObjectJsonSchema 的
 * 完整子集断言只在写入口跑（@deepseek-ai 只准在 harness/ 导入），所以门禁仍在服务端。
 */
import { objectSchemaShapeProblem } from "@/lib/json-schema-shape";

export type SchemaParse<T> = { ok: true; value: T } | { ok: false; error: string };

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
  const problem = objectSchemaShapeProblem(parsed, label);
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
