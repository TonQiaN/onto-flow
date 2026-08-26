/**
 * 组合配置的构件：entry 形状、YAML 渲染与设置驱动的 entry 生成。
 *
 * 组合只携带路径与开关，绝不携带凭据值——llm-deepseek 只带凭据引用名
 * （apiKeyEnv），值由子进程环境白名单注入（ADR-0006）。
 *
 * 移植自 agent-workflow-studio 的 packages/harness/src/composition/entries.ts。
 */

export interface CompositionEntry {
  id: string;
  name: string;
  /** 渲染为 loader entry 的 disabled 标记。 */
  disabled?: boolean;
  config?: Record<string, unknown>;
}

// id 与模块名裸插值进 YAML：形状断言把「校验被绕过」变成响亮失败而不是注入。
const SAFE_ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
// 裸包名与仓库内插件的绝对 POSIX 路径都要放行；两者都不含可用于 YAML 逃逸的字符。
const SAFE_MODULE_NAME = /^[@A-Za-z0-9/_.-]+$/;

/** 把 entry 清单渲染为 cordis.yml 文本；config 值经 JSON 序列化（JSON 是 YAML 子集）。 */
export function renderCompositionYaml(
  header: string,
  entries: readonly CompositionEntry[],
): string {
  const lines: string[] = [header];
  for (const entry of entries) {
    if (!SAFE_ENTRY_ID.test(entry.id)) {
      throw new Error(`组合 entry id 形状非法：${JSON.stringify(entry.id)}`);
    }
    if (!SAFE_MODULE_NAME.test(entry.name)) {
      throw new Error(`组合插件模块名形状非法：${JSON.stringify(entry.name)}`);
    }
    lines.push(`- id: ${entry.id}`);
    lines.push(`  name: '${entry.name}'`);
    if (entry.disabled === true) lines.push("  disabled: true");
    if (entry.config !== undefined) {
      lines.push("  config:");
      for (const [key, value] of Object.entries(entry.config)) {
        // undefined 会被 JSON.stringify 渲染成字面量 undefined、再被 YAML 读成
        // 字符串；缺失的键必须真正缺失，让上游 schema 的 required 生效。
        if (value === undefined) continue;
        lines.push(`    ${key}: ${JSON.stringify(value)}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

/** 上游 mcp-client 对 serverName 的约束；工具公名前缀 `mcp__<serverName>__` 由它派生。 */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** MCP entry 的稳定 id 前缀；插件面板与连接状态投影按它识别 MCP entry。 */
export const MCP_ENTRY_ID_PREFIX = "mcp-";

export interface McpServerReconnectSpec {
  enabled?: boolean;
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
}

/**
 * 一台 MCP 服务器的组合规格。env/headers 的值会原样落入组合配置文件，
 * 凭据必须走环境白名单而不是这里。
 */
export interface McpServerSpec {
  name: string;
  enabled: boolean;
  transport: "stdio" | "streamable-http";
  command?: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  url?: string;
  headers?: Readonly<Record<string, string>>;
  toolCallTimeoutMs?: number;
  reconnect?: McpServerReconnectSpec;
}

/**
 * 把 MCP 规格物化为组合 entry。连接失败不失败 fiber（failOnStartupError 恒为
 * false）：整棵树的可用性不被单台 MCP 服务器绑架。
 */
export function mcpCompositionEntry(spec: McpServerSpec): CompositionEntry {
  const shared = {
    serverName: spec.name,
    failOnStartupError: false,
    ...(spec.toolCallTimeoutMs === undefined
      ? {}
      : { toolCallTimeoutMs: spec.toolCallTimeoutMs }),
    ...(spec.reconnect === undefined ? {} : { reconnect: spec.reconnect }),
  };
  const config: Record<string, unknown> =
    spec.transport === "stdio"
      ? {
          transport: "stdio",
          command: spec.command,
          args: [...(spec.args ?? [])],
          env: { ...spec.env },
          ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
          ...shared,
        }
      : {
          transport: "streamable-http",
          url: spec.url,
          headers: { ...spec.headers },
          ...shared,
        };
  return {
    id: `${MCP_ENTRY_ID_PREFIX}${spec.name}`,
    name: "@deepseek-ai/dsh-mcp-client",
    ...(spec.enabled ? {} : { disabled: true }),
    config,
  };
}

/** 模型目录条目；目录是发现面展示用的 advisory 数据，未列出的模型 id 照样透传。 */
export interface DeepSeekModelSpec {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
  maxTokens?: number;
  inputModalities?: readonly ("text" | "image")[];
}

/** llm-deepseek 的组合规格；apiKeyEnv 是凭据引用名，不是值。 */
export interface DeepSeekProviderSpec {
  apiKeyEnv?: string;
  baseURL?: string;
  maxTokens?: number;
  models?: readonly DeepSeekModelSpec[];
}

/** 模型凭据的默认引用名。只记名字，值永远不进配置、日志与运行目录。 */
export const DEFAULT_CREDENTIAL_ENV = "DEEPSEEK_API_KEY";

/** DeepSeek 官方直连的默认模型：多模态，扫描件走逐页栅格化时必需。 */
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash-vision-exp";
/** llm-deepseek 注册的 provider 路由名，与 pi-ai 目录里的 `deepseek` 刻意区分。 */
export const DEEPSEEK_PROVIDER = "deepseek-official";

export function deepseekCompositionEntry(
  spec: DeepSeekProviderSpec = {},
): CompositionEntry {
  const config: Record<string, unknown> = {
    apiKeyEnv: spec.apiKeyEnv ?? DEFAULT_CREDENTIAL_ENV,
    ...(spec.baseURL === undefined ? {} : { baseURL: spec.baseURL }),
    ...(spec.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens }),
    ...(spec.models === undefined ? {} : { models: spec.models.map((m) => ({ ...m })) }),
  };
  return { id: "llm-deepseek", name: "@deepseek-ai/dsh-llm-deepseek", config };
}
