/**
 * Tool 公名的规则与写入口的两条纯校验（ADR-0017）——写入口
 * （`src/server/writers/tool.ts`）、平台包装（`src/server/harness/tool-plugin.ts`）
 * 与 Tool 编辑器（`src/app/tools/tool-form.ts`）共有的那一份。
 *
 * 放在 `src/lib/` 是因为编辑器要在保存前给出同一句话，而客户端不能从 `@/server` 导入运行时值；
 * 以前保留名清单在 `harness/tool-contract.ts` 与 `app/tools/tool-form.ts` 各抄一份、
 * 靠一条只为守住重复而存在的测试钉住，现在只有这一处。`ToolContext` 那套类型仍归
 * `src/server/harness/tool-contract.ts`——它是运行子进程一侧的契约面。
 *
 * 纯模块：不 import 任何东西。
 */

/** 模型可见的工具名：小写字母开头，字母、数字、下划线，最长 64。 */
export const TOOL_PUBLIC_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * 不能作为 Tool 公名的保留名。上游内建工具在全局层注册，同名的契约 Tool 包装在 boot 时以
 * `tool "x" is already registered` 让整个运行起不来，而不是保存时 400；`structured_output` 是
 * 每个会话自己注册的数据面工具，同名会在会话层遮蔽它、又被可见性守卫按裸名拒绝，Action 就交
 * 不出结果；`web_fetch` 随搜索开关挂载，`run_code` 是上游 Code Mode 的工具名（目录里备选、未挂），
 * 都留给上游。
 */
const TOOL_RESERVED_PUBLIC_NAMES: ReadonlySet<string> = new Set([
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

/**
 * MCP 工具的公名空间：上游 mcp-client 把每台服务器的工具注册成 `mcp__<server>__<tool>`；契约 Tool
 * 撞上时那台服务器同步阶段 register 抛错、整台的工具都被丢弃，只留一行日志。整个前缀保留。
 */
const TOOL_RESERVED_PUBLIC_NAME_PREFIX = "mcp__";

/** 公名的三道检查：形状、保留名、MCP 前缀。合法返回 null。 */
export function publicNameProblem(publicName: string): string | null {
  if (!TOOL_PUBLIC_NAME_PATTERN.test(publicName))
    return `模型可见的工具名「${publicName}」非法：小写字母开头，只含小写字母、数字与下划线，最长 64 位`;
  if (TOOL_RESERVED_PUBLIC_NAMES.has(publicName))
    return `模型可见的工具名「${publicName}」是上游内建工具或会话数据面工具的名字，契约 Tool 不能占用`;
  if (publicName.startsWith(TOOL_RESERVED_PUBLIC_NAME_PREFIX))
    return `模型可见的工具名「${publicName}」用了 MCP 工具的前缀 ${TOOL_RESERVED_PUBLIC_NAME_PREFIX}，契约 Tool 不能占用`;
  return null;
}

/** execute 模块：非空，且不得引用上游闭包（那是又在写裸插件）。合法返回 null。 */
export function toolCodeProblem(code: string): string | null {
  if (code.trim() === "") return "execute 模块源码不能为空";
  if (code.includes("@deepseek-ai/"))
    return "execute 模块不能引用 @deepseek-ai/*：Tool 只经 ctx 拿能力，上游 API 由平台包装承接（ADR-0017）";
  return null;
}
