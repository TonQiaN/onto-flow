/**
 * Tool 契约（ADR-0017）：Tool 作者面对的全部类型。作者写的 execute 模块在运行子进程里被
 * 平台包装（tool-plugin.ts）调用，拿到的 `ctx` 只有这一个稳定小面——不暴露 cordis Context，
 * 上游 API 漂移收敛在包装一处。这个文件只有类型与常量，服务端与运行子进程都能导入；公名规则
 * 与写入口的两条纯校验编辑器也要用，所以归 `@/lib/tool-names`（客户端不从 `@/server` 导入
 * 运行时值），不在这里再写一份。
 */

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
  /** 工作台数据根（data/）；Tool 要落备份文件时用它 */
  dataDir: string;
  /** 工作台数据库文件路径；Tool 要读写工作台库时用 node:sqlite 打开它 */
  dbPath: string;
  /** 调用这次工具的会话的 cwd */
  cwd: string;
  env: Readonly<Record<string, string>>;
  /** 会话取消即触发；长时间工作要把它传下去 */
  signal: AbortSignal;
  /** 在沙箱里跑一条 bash 命令 */
  run(command: string, options?: ToolRunOptions): Promise<ToolRunResult>;
}

/**
 * execute 模块的默认导出形状。
 *
 * @public 仓库内没有引用点：作者的 execute 模块是库里的一行 `code`，不是本仓的 TypeScript，
 * 所以这个类型的消费者在数据库里而不在源码里。ADR-0017 把它连同 `ToolContext` 一族定为 Tool
 * 作者看到的稳定公开面——有主人的公开面不是死代码，上面这个标记是 `knip.json` 的 tags 配置
 * 认的豁免，归零靠它而不是靠删字段。
 */
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
