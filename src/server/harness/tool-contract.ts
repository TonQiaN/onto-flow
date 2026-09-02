/**
 * Tool 契约（ADR-0017）：Tool 作者面对的全部类型。作者写的 execute 模块在运行子进程里被
 * 平台包装（tool-plugin.ts）调用，拿到的 `ctx` 只有这一个稳定小面——不暴露 cordis Context，
 * 上游 API 漂移收敛在包装一处。这个文件只有类型与常量，服务端、客户端与运行子进程都能导入。
 */

/** 模型可见的工具名：小写字母开头，字母、数字、下划线，最长 64。 */
export const TOOL_PUBLIC_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * 不能作为 Tool 公名的保留名。上游内建工具在全局层注册，同名的契约 Tool 包装在 boot 时以
 * `tool "x" is already registered` 让整个运行起不来，而不是保存时 400；`structured_output` 是
 * 每个会话自己注册的数据面工具，同名会在会话层遮蔽它、又被可见性守卫按裸名拒绝，Action 就交
 * 不出结果；`web_fetch` / `run_code` 是目录里随开关挂载或备选的上游工具名，留给它们。
 * 客户端在 src/app/tools/tool-form.ts 镜像了同一份清单（tool-form.test.ts 钉住两份一致）。
 */
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

/** 单次 `ctx.run()` 的默认与上限超时（毫秒）；与 bash 工具同一上限。 */
export const TOOL_RUN_DEFAULT_TIMEOUT_MS = 60_000;
export const TOOL_RUN_MAX_TIMEOUT_MS = 120_000;

export interface ToolRunOptions {
  /** 命令的工作目录，默认为会话 cwd（本次运行的工作区） */
  cwd?: string;
  /** 超时，默认 TOOL_RUN_DEFAULT_TIMEOUT_MS，上限 TOOL_RUN_MAX_TIMEOUT_MS */
  timeoutMs?: number;
}

/** 沙箱裁决：与 bash 工具同一份 workspace-write 策略，围栏由上游 sandbox-local 执行。 */
export interface ToolRunSandbox {
  mode: string;
  /** 围栏真的包住了这次执行；false 即裸跑，谨慎的 Tool 应把它当失败 */
  enforced: boolean;
  /** 围栏 runner 不可用（上游 fail-closed 时命令不会执行） */
  runnerFailed: boolean;
  /** 命令因策略被拒绝 */
  denied: boolean;
}

export interface ToolRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  sandbox: ToolRunSandbox;
}

/**
 * execute 模块拿到的上下文。路径都是绝对路径；env 只含运行子进程的白名单环境
 * （凭据引用名对应的值与 ONTOFLOW_* 运行上下文），不是整个进程环境。
 */
export interface ToolContext {
  /** 本次运行的工作区（会话 cwd） */
  workspaceDir: string;
  /** 本次运行的运行目录 */
  runDir: string;
  /** 本次运行独占的临时目录（TMPDIR） */
  tmpDir: string;
  /** 工作台数据根（data/）；归档类 Tool 用它落备份文件 */
  dataDir: string;
  /** 工作台数据库文件路径；归档类 Tool 用 node:sqlite 打开 */
  dbPath: string;
  /** 调用这次工具的会话的 cwd */
  cwd: string;
  env: Readonly<Record<string, string>>;
  /** 会话取消即触发；长时间工作要把它传下去 */
  signal: AbortSignal;
  /** 在沙箱里跑一条 bash 命令 */
  run(command: string, options?: ToolRunOptions): Promise<ToolRunResult>;
}

/** execute 模块的默认导出形状。 */
export type ToolExecute = (args: unknown, ctx: ToolContext) => Promise<unknown>;

/** 库里一个 Tool 的契约字段：与 tools 表一一对应，摘要与包装都只看这些。 */
export interface ToolContract {
  publicName: string;
  description: string;
  parameters: Record<string, unknown>;
  output: Record<string, unknown> | null;
  timeoutMs: number | null;
  code: string;
}
