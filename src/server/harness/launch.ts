/**
 * 启动一次运行的子进程：写组合配置、spawn、initialize。
 *
 * 凭据以引用名进入：值从 Next 进程环境按白名单挑出显式注入子进程，
 * 不落组合配置、不落日志、不落运行目录（ADR-0006）。
 */
import path from "node:path";
import { DATA_DIR } from "@/server/fs-safety";
import { DEEPSEEK_PROVIDER, DEFAULT_CREDENTIAL_ENV, DEFAULT_DEEPSEEK_MODEL } from "./entries";
import { RunProcess } from "./runtime";
import { writeRunComposition, type RunCompositionOptions } from "./composition";
import type { RunWorkspace } from "./workspace";

/**
 * runner 入口：仓库内的 TS 文件，由子进程的 tsx 加载。
 *
 * 从 process.cwd() 拼而不是从 import.meta.dirname 拼：Turbopack 打包服务端代码后
 * import.meta.dirname 是 undefined，路径会在 join 里炸掉——tsx 下跑得通、Next 里跑不通。
 * 本仓库一切命令都从仓库根运行（见 AGENTS.md 的 Commands），cwd 是可靠的锚点。
 */
export function defaultRunnerEntry(): string {
  return path.join(process.cwd(), "src", "server", "harness", "runner.ts");
}

/**
 * 按引用名从当前进程环境挑出凭据值。名字不在环境里或为空则整项省略，
 * 让上游在请求时以 MISSING_CREDENTIAL 响亮失败，而不是拿到空串去认证。
 */
export function collectCredentialEnv(refs: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of refs) {
    const value = process.env[name];
    if (typeof value === "string" && value !== "") env[name] = value;
  }
  return env;
}

export interface LaunchRunOptions {
  runnerEntry?: string;
  /** 需要注入子进程的凭据引用名清单。 */
  credentialRefs?: readonly string[];
  /** 全局设置进入本次运行组合的部分。 */
  composition?: RunCompositionOptions;
  provider?: string;
  model?: string;
  maxTokens?: number;
  requestTimeoutMs?: number;
  onCrash?: (message: string) => void;
  onSessionEvent?: (sessionId: string, event: unknown) => void;
}

/**
 * initialize 已失败，dispose 又无法证明子进程退出。调用方必须保留 runProcess
 * 的所有权并隔离对应工作区；只抛初始化错误会把仍可能存活的进程句柄丢掉。
 */
export class UnsettledRunLaunchError extends Error {
  constructor(
    readonly runProcess: RunProcess,
    readonly initializationError: unknown,
    readonly disposalError: unknown,
  ) {
    const initializationMessage =
      initializationError instanceof Error
        ? initializationError.message
        : String(initializationError);
    const disposalMessage =
      disposalError instanceof Error ? disposalError.message : String(disposalError);
    super(
      `harness 初始化失败且子进程无法确认已退出：${initializationMessage}；` +
        `收束错误：${disposalMessage}`,
    );
    this.name = "UnsettledRunLaunchError";
  }
}

/** 写组合、spawn 子进程并完成 initialize；返回可驱动会话的句柄。 */
export async function launchRun(
  workspace: RunWorkspace,
  options: LaunchRunOptions = {},
): Promise<RunProcess> {
  await writeRunComposition(workspace, options.composition ?? {});
  const apiKeyEnv = options.composition?.deepseek?.apiKeyEnv ?? DEFAULT_CREDENTIAL_ENV;
  const refs = [...(options.credentialRefs ?? []), apiKeyEnv];
  const proc = RunProcess.spawn({
    runnerEntry: options.runnerEntry ?? defaultRunnerEntry(),
    compositionPath: workspace.compositionPath,
    cwd: workspace.workspaceDir,
    env: {
      ...collectCredentialEnv(refs),
      // 下面四个不是凭据而是运行上下文，因此排在白名单之后、不可被它覆盖：
      // DSH_HOME 把 harness 的用户级根钉进运行目录（隔离）；TMPDIR 把 agent 的
      // 临时文件与上游沙箱围栏的临时根一起钉进运行目录（docs/harness/02）；
      // 另两个让 Tool 插件够得着工作台自己的数据——归档类工具正是靠它写库与落备份文件。
      DSH_HOME: workspace.homeDir,
      TMPDIR: workspace.tmpDir,
      ONTOFLOW_DB_PATH: path.join(DATA_DIR, "ontoflow.db"),
      ONTOFLOW_DATA_DIR: DATA_DIR,
    },
    stderrLogPath: path.join(workspace.logsDir, "harness.stderr.log"),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.onSessionEvent === undefined
      ? {}
      : { onSessionEvent: options.onSessionEvent }),
    onCrash: (exit) =>
      options.onCrash?.(
        `harness 子进程未经收束退出（code=${String(exit.code)}，signal=${String(exit.signal)}）`,
      ),
  });
  try {
    await proc.initialize({
      cwd: workspace.workspaceDir,
      provider: options.provider ?? DEEPSEEK_PROVIDER,
      model: options.model ?? DEFAULT_DEEPSEEK_MODEL,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    });
  } catch (cause) {
    // initialize 失败时子进程已经 spawn 出来了；不收束就没有任何人持有它的句柄，
    // 并行运行下这种僵尸会累积到拖垮机器。收束失败不掩盖首个错误。
    try {
      await proc.dispose();
    } catch (disposalError) {
      // 这不是可以吞掉的次要错误：SIGKILL 后仍没有退出边沿时，句柄必须随异常
      // 交还调用方隔离，不能让运行目录与并发名额被当作已经释放。
      throw new UnsettledRunLaunchError(proc, cause, disposalError);
    }
    throw cause;
  }
  return proc;
}
