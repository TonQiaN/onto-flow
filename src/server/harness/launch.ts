/**
 * 启动一次运行的子进程：写组合配置、spawn、initialize。
 *
 * 凭据以引用名进入：值从 Next 进程环境按白名单挑出显式注入子进程，
 * 不落组合配置、不落日志、不落运行目录（ADR-0006）。
 */
import path from "node:path";
import { DEEPSEEK_PROVIDER, DEFAULT_CREDENTIAL_ENV, DEFAULT_DEEPSEEK_MODEL } from "./entries";
import { RunProcess } from "./runtime";
import { writeRunComposition, type RunCompositionOptions } from "./composition";
import type { RunWorkspace } from "./workspace";

/** runner 入口：与本模块同目录的 TS 文件，由子进程的 tsx 加载。 */
export function defaultRunnerEntry(): string {
  return path.join(import.meta.dirname, "runner.ts");
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
    // DSH_HOME 恒指向运行目录内的隔离 home，不可被凭据白名单覆盖。
    env: { ...collectCredentialEnv(refs), DSH_HOME: workspace.homeDir },
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
  await proc.initialize({
    cwd: workspace.workspaceDir,
    provider: options.provider ?? DEEPSEEK_PROVIDER,
    model: options.model ?? DEFAULT_DEEPSEEK_MODEL,
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
  });
  return proc;
}
