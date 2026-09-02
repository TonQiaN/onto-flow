/**
 * Tool 的 cordis 包装生成器（ADR-0017）：Tool 是 OntoFlow 契约，作者只写一个
 * execute 模块；物化时平台为它套上自己维护的 cordis 插件，Tool 是包装的数据。
 *
 * 每个 Tool 写两个文件到 <run>/plugins/：
 * - `tool-<id>.execute.ts`：`tools.code` 原样，即作者的 execute 模块；
 * - `tool-<id>.ts`：生成的包装。`apply(ctx)` 里 `ctx.tools.register(...)` 把契约的
 *   publicName / description / parameters / output / timeoutMs 原样交给上游注册表，
 *   `execute` 组装 ToolContext（路径与 env 白名单键名在生成时写死为字面量，值在运行时
 *   从子进程环境取）再调用 execute 模块的默认导出。
 *
 * 上游 ToolDefinition 的 `output` 是必填项（`packages/core/tools/src/index.ts`），
 * 契约的 output 省略时包装给一个无约束 schema（`{}`：上游子集允许注解空 schema
 * 表示任意 JSON），render 一律 `JSON.stringify(value)`；`timeoutMs` 与上游同名，
 * 声明了才由 tool-call-timeout-policy 强制。
 *
 * `ctx.run()` 走与 bash 工具同一道围栏：按会话解析 sandboxPolicy，经 `ctx.shell`
 * 派出命令；bash-sandbox 在 runner 不可用时抛 SandboxUnavailableError（fail-closed），
 * 包装把它折成 `sandbox.runnerFailed = true` 的结果而不是异常，Tool 自己决定拒绝。
 *
 * 只有这个文件知道 cordis 与 dsh-tools 的注册形状；上游漂移时改这里，库里的 Tool 不动。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { tools } from "@/db";
import { DATA_DIR } from "@/server/fs-safety";
import { assertSafeId } from "./ids";
import {
  TOOL_PUBLIC_NAME_PATTERN,
  TOOL_RUN_DEFAULT_TIMEOUT_MS,
  TOOL_RUN_MAX_TIMEOUT_MS,
  type ToolContract,
} from "./tool-contract";
import type { RunWorkspace } from "./workspace";

/** 物化一个 Tool 所需的行：契约字段加数据库 id（文件名与 entry id 从它派生）。 */
export type ToolPluginRow = Pick<typeof tools.$inferSelect, "id" | "name"> & ToolContract;

export interface ToolPluginOptions {
  /**
   * execute 模块能看见的环境变量名：全局设置的凭据引用名、模型凭据名与
   * ONTOFLOW_DB_PATH / ONTOFLOW_DATA_DIR。键名在生成时写死，值在调用时从子进程环境取，
   * 凭据值因此既不进包装文件也不进组合配置。
   */
  envKeys: readonly string[];
}

export interface ToolPluginEntry {
  /** 组合 entry id，也是包装文件的 basename */
  id: string;
  /** 包装文件的绝对路径，以绝对路径进组合 */
  modulePath: string;
  /** execute 模块的绝对路径 */
  executeModulePath: string;
}

/** 生成时写进包装的运行目录事实；全部绝对路径。 */
interface ToolPluginPaths {
  workspaceDir: string;
  runDir: string;
  tmpDir: string;
  dataDir: string;
  dbPath: string;
}

const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * 渲染一个 Tool 的包装源码。纯函数：单测据此断言生成内容，不必先落盘。
 * 所有来自库或设置的值都经 JSON.stringify 进入源码，不会被拼成可执行代码。
 */
export function renderToolPlugin(
  tool: ToolPluginRow,
  paths: ToolPluginPaths,
  executeModulePath: string,
  options: ToolPluginOptions,
): string {
  assertSafeId("工具 id", tool.id);
  if (!TOOL_PUBLIC_NAME_PATTERN.test(tool.publicName)) {
    throw new Error(`Tool「${tool.name}」的公名「${tool.publicName}」不合法，无法注册为工具`);
  }
  for (const key of options.envKeys) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new Error(`环境变量白名单键名「${key}」形状非法`);
    }
  }
  const contract = {
    publicName: tool.publicName,
    description: tool.description,
    parameters: tool.parameters,
    output: tool.output,
    timeoutMs: tool.timeoutMs,
  };
  const literal = (value: unknown): string => JSON.stringify(value);
  return `/**
 * 由 OntoFlow 为单次运行生成的 Tool 包装（ADR-0017）；Tool 作者的 execute 模块在
 * 同目录的 ${path.basename(executeModulePath)}。本文件是平台的，不要手改。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-shell";
import type {} from "@deepseek-ai/dsh-sandbox-policy";

export const name = ${literal(`tool-${tool.id}`)};
export const inject = ["tools", "shell", "sandboxPolicy"];

const CONTRACT = ${literal(contract)} as const;
const PATHS = ${literal(paths)} as const;
const ENV_KEYS = ${literal([...new Set(options.envKeys)])} as const;
const EXECUTE_MODULE_URL = ${literal(pathToFileURL(executeModulePath).href)};
const RUN_DEFAULT_TIMEOUT_MS = ${TOOL_RUN_DEFAULT_TIMEOUT_MS};
const RUN_MAX_TIMEOUT_MS = ${TOOL_RUN_MAX_TIMEOUT_MS};

type ExecuteModule = { default?: unknown };
let loaded: Promise<ExecuteModule> | undefined;

/**
 * execute 模块成功后只 import 一次。失败时不缓存 promise，但 ESM 会缓存模块求值错误：同一 URL
 * 再次 import 直接重抛——所以「不缓存」只保证语法错、顶层抛错在首次调用才暴露、以工具错误结果
 * 呈现而不拖倒运行，并不让下一次调用真的重试成功。
 */
function loadExecuteModule(): Promise<ExecuteModule> {
  loaded ??= (import(EXECUTE_MODULE_URL) as Promise<ExecuteModule>).catch((err: unknown) => {
    loaded = undefined;
    throw err;
  });
  return loaded;
}

function whitelistedEnv(): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value !== "") env[key] = value;
  }
  return Object.freeze(env);
}

function clampTimeout(requested: number | undefined): number {
  const value = requested ?? RUN_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) return RUN_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(value), RUN_MAX_TIMEOUT_MS);
}

export function apply(ctx: Context): void {
  ctx.tools.register({
    name: CONTRACT.publicName,
    description: CONTRACT.description,
    // 参数 schema 走上游同一套 JSON Schema 子集；写入口已拒绝类型数组。
    parameters: CONTRACT.parameters as never,
    ...(CONTRACT.timeoutMs === null ? {} : { timeoutMs: CONTRACT.timeoutMs }),
    output: {
      // 上游要求 output 必填：契约未声明时给无约束 schema，任何 JSON 都放行。
      schema: (CONTRACT.output ?? {}) as never,
      // 签名是 (args, value)：第一个是调用参数，第二个才是返回值。
      render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }],
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      const session = exec.agent?.session;
      const cwd = session?.header.cwd ?? PATHS.workspaceDir;
      const toolCtx = {
        ...PATHS,
        cwd,
        env: whitelistedEnv(),
        signal: exec.signal,
        async run(command: string, options: { cwd?: string; timeoutMs?: number } = {}) {
          if (!session) throw new Error(\`\${CONTRACT.publicName} 只能由 Action 会话调用\`);
          // 与 bash 工具同一份 workspace-write 策略，按会话解析；围栏由上游 sandbox-local 执行。
          const sandboxPolicy = ctx.sandboxPolicy.resolve({ session });
          let result;
          try {
            result = await ctx.shell.run(ctx.shell.resolve({
              command,
              workdir: options.cwd ?? cwd,
              timeoutMs: clampTimeout(options.timeoutMs),
              signal: exec.signal,
              sandboxPolicy,
            }));
          } catch (error) {
            // bash-sandbox 在围栏 runner 不可用时 fail-closed 抛错，命令没有跑；
            // 折成事实交给 Tool 自己裁决，而不是把工具调用整个炸掉。
            if (error instanceof Error && error.name === "SandboxUnavailableError") {
              return {
                stdout: "",
                stderr: error.message,
                exitCode: null,
                timedOut: false,
                sandbox: { mode: sandboxPolicy.mode, enforced: false, runnerFailed: true, denied: false },
              };
            }
            throw error;
          }
          if (result.aborted) {
            const abort = new Error(\`\${CONTRACT.publicName} 已取消\`);
            abort.name = "AbortError";
            throw abort;
          }
          const sandbox = result.sandbox;
          return {
            stdout: result.stdout.text,
            stderr: result.stderr.text,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            sandbox: {
              mode: sandbox?.mode ?? "none",
              // 只有沙箱执行器报告了 enforcement 才算围栏真的包住了这次执行。
              enforced: sandbox !== undefined && sandbox.enforcement !== undefined && sandbox.runnerFailed !== true,
              runnerFailed: sandbox?.runnerFailed === true,
              denied: sandbox?.denied === true,
            },
          };
        },
      };
      const mod = await loadExecuteModule();
      if (typeof mod.default !== "function") {
        throw new Error(\`Tool \${CONTRACT.publicName} 的 execute 模块没有默认导出函数\`);
      }
      const value: unknown = await (mod.default as (args: unknown, ctx: unknown) => Promise<unknown>)(args, toolCtx);
      // 上游只接受无损 JSON；execute 什么都没返回时交 null，而不是让注册表报序列化错误。
      return value === undefined ? null : value;
    },
  });
}
`;
}

/**
 * 把一个 Tool 物化到运行目录的 plugins/：execute 模块原样落盘，包装按契约生成。
 * 文件名与 entry id 从数据库 id 派生；展示名允许中文，不能拿来拼裸 YAML 路径。
 */
export function materializeToolPlugin(
  workspace: RunWorkspace,
  tool: ToolPluginRow,
  options: ToolPluginOptions,
): ToolPluginEntry {
  assertSafeId("工具 id", tool.id);
  const basename = `tool-${tool.id}`;
  const executeModulePath = path.join(workspace.pluginsDir, `${basename}.execute.ts`);
  const modulePath = path.join(workspace.pluginsDir, `${basename}.ts`);
  const source = renderToolPlugin(
    tool,
    {
      workspaceDir: workspace.workspaceDir,
      runDir: workspace.runDir,
      tmpDir: workspace.tmpDir,
      dataDir: DATA_DIR,
      dbPath: path.join(DATA_DIR, "ontoflow.db"),
    },
    executeModulePath,
    options,
  );
  fs.writeFileSync(executeModulePath, tool.code, "utf8");
  fs.writeFileSync(modulePath, source, "utf8");
  return { id: basename, modulePath, executeModulePath };
}
