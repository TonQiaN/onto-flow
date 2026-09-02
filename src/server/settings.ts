/**
 * 全局设置：模型默认值、凭据引用、MCP 服务器登记、默认停用的工具、可切换插件的
 * 全局默认值与默认指令——三层设置的最上层（ADR-0016）。工作流设置只在允许切换的
 * 范围内覆盖这里的开关与 MCP 子集，Action 从不开关插件。
 *
 * 单行表存整份 JSON 文档，读写都全量校验（写入口是唯一的校验点，见 AGENTS.md
 * 的「Entity-body validation lives in the writer」）。
 *
 * **凭据只记名字不记值。** 设置里出现的永远是环境变量名，值在运行启动时从
 * Next 进程环境按白名单挑出、显式注入子进程，不进配置文件、不进日志、不进
 * 运行目录（ADR-0006）。MCP 的 stdio env 因此拒绝凭据形键名——那是把密钥写进
 * 组合配置文件的唯一入口。
 */
import { eq } from "drizzle-orm";
import { db, settings } from "@/db";
import { DEFAULT_CREDENTIAL_ENV } from "@/server/harness/entries";
import {
  MCP_SERVER_NAME_PATTERN,
  type McpServerSpec,
} from "@/server/harness/entries";
import { writeFail, writeOk, type WriteResult } from "@/server/writers/types";
import {
  COMPOSITION_TOGGLE_KEYS,
  DEFAULT_COMPOSITION_TOGGLES,
  type CompositionToggles,
  DEFAULT_INSTRUCTIONS_MAX_BYTES,
} from "@/lib/workflow-settings";

/** 一条凭据引用登记：只有名字与用途。 */
export interface CredentialRef {
  /** 环境变量名 */
  name: string;
  purpose: string;
}

export interface SettingsDocument {
  /** 模型凭据的引用名，进入 llm-deepseek 的 apiKeyEnv */
  modelApiKeyEnv: string;
  /** DeepSeek 端点覆盖；留空走官方 */
  modelBaseUrl: string;
  /** 登记的凭据引用；构成运行子进程的环境白名单 */
  credentialRefs: CredentialRef[];
  mcpServers: McpServerSpec[];
  /** 默认对所有 Action 停用的工具公名 */
  disabledTools: string[];
  /**
   * 可切换插件的全局默认值；工作流设置只写要覆盖的键，受理时合成生效开关
   * （ADR-0013、ADR-0016）。webSearch 默认关：搜索用量不经 llm/stream，
   * 本站 node_usage 收不到，是账外支出。
   */
  toggles: CompositionToggles;
  /**
   * 默认指令：物化为每次运行的 <run>/home/AGENTS.md，上游 agent-instructions 把
   * $DSH_HOME/AGENTS.md 当用户级指令读，因此每个 Action 会话都无条件读到；
   * 工作流自己的指令另落 workspace/AGENTS.md（ADR-0016）。
   */
  defaultInstructions: string;
}

/** 出厂默认指令：运行时约束的四条底线，原先硬编码在引擎里，现在归全局设置。 */
export const DEFAULT_INSTRUCTIONS = [
  "# 工作流运行约定",
  "",
  "你是这个工作流里的一个 Action。当前目录是本次运行的工作区，也是各 Action 之间",
  "唯一的交流场所：实质内容一律写成文件，读上游的东西也一律读文件。",
  "",
  "- 产物只写在工作区内；沙箱只放行工作区与系统临时目录的写入。",
  "- 输入文件都是原件，没有做过任何预处理；读不动的格式就用 bash 自己转换。",
  "- 结构化输出只用来报告产物路径，不要往里塞长文本。",
  "- 声明了的产物必须真的写出来：文件不存在，本节点即判失败。",
  "",
].join("\n");

/** 默认指令的字节上限，对齐组合里 agent-instructions 的 maxBytes。 */
export { DEFAULT_INSTRUCTIONS_MAX_BYTES };

export const DEFAULT_SETTINGS: SettingsDocument = {
  modelApiKeyEnv: DEFAULT_CREDENTIAL_ENV,
  modelBaseUrl: "",
  credentialRefs: [],
  mcpServers: [],
  disabledTools: [],
  toggles: { ...DEFAULT_COMPOSITION_TOGGLES },
  defaultInstructions: DEFAULT_INSTRUCTIONS,
};

/** 凭据形键名：出现在 MCP stdio env 里就拒绝；HTTP headers 暂不接受非空值。 */
const CREDENTIAL_KEY_WORDS =
  /(key|token|secret|password|credential|auth|bearer|session|passwd|pwd|pat|cookie)/i;

/** 运行时控制变量不允许被凭据引用名占用：白名单不得重新注入引擎自己的开关。 */
const RESERVED_ENV_PREFIX = /^(DSH_|ONTOFLOW_|NODE_)/;

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** 读设置。表里没有行就返回出厂值——第一次进设置页不该看见错误。 */
export function readSettings(): SettingsDocument {
  const row = db.select().from(settings).where(eq(settings.id, 1)).get();
  if (!row) return { ...DEFAULT_SETTINGS };
  const parsed = parseSettings(row.document);
  // 库里的文档是上一次校验过才写进去的；真读坏了也不能让整个页面 500。
  return parsed.ok ? parsed.data : { ...DEFAULT_SETTINGS };
}

export function writeSettings(raw: unknown): WriteResult<SettingsDocument> {
  const parsed = parseSettings(raw);
  if (!parsed.ok) return parsed;
  const document = parsed.data as unknown as Record<string, unknown>;
  db.insert(settings)
    .values({ id: 1, document, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.id,
      set: { document, updatedAt: new Date() },
    })
    .run();
  return writeOk(parsed.data);
}

function sameSettings(left: SettingsDocument, right: SettingsDocument): boolean {
  // 两边都经过 parseSettings，键顺序稳定；数组顺序变化也算用户改动，不能被恢复覆盖。
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 只在当前设置仍等于 expected 时原子替换。付费冒烟脚本用它临时安装/恢复设置，
 * 用户在运行期间保存的新文档必须胜出，不能被脚本手里的旧快照覆盖。
 */
export function replaceSettingsIfCurrent(
  expected: SettingsDocument,
  replacement: SettingsDocument,
): boolean {
  const parsedExpected = parseSettings(expected);
  const parsedReplacement = parseSettings(replacement);
  if (!parsedExpected.ok || !parsedReplacement.ok) {
    throw new Error("设置比较替换收到未通过校验的文档");
  }
  return db.transaction(
    (tx) => {
      const row = tx.select().from(settings).where(eq(settings.id, 1)).get();
      const current = row ? parseSettings(row.document) : writeOk({ ...DEFAULT_SETTINGS });
      if (!current.ok || !sameSettings(current.data, parsedExpected.data)) return false;
      const document = parsedReplacement.data as unknown as Record<string, unknown>;
      tx.insert(settings)
        .values({ id: 1, document, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: settings.id,
          set: { document, updatedAt: new Date() },
        })
        .run();
      return true;
    },
    // 读当前值与写替换值属于一个 CAS；IMMEDIATE 阻止另一连接插进二者之间。
    { behavior: "immediate" },
  );
}

export function parseSettings(raw: unknown): WriteResult<SettingsDocument> {
  if (!raw || typeof raw !== "object") return writeFail(400, "设置必须是 JSON 对象");
  const body = raw as Record<string, unknown>;

  const modelApiKeyEnv = str(body.modelApiKeyEnv) || DEFAULT_CREDENTIAL_ENV;
  if (!ENV_NAME.test(modelApiKeyEnv)) {
    return writeFail(400, "模型凭据引用名必须是大写环境变量名，如 DEEPSEEK_API_KEY");
  }

  const credentialRefs: CredentialRef[] = [];
  const rawRefs = body.credentialRefs;
  if (rawRefs !== undefined) {
    if (!Array.isArray(rawRefs)) return writeFail(400, "credentialRefs 必须是数组");
    for (const item of rawRefs) {
      if (!item || typeof item !== "object") return writeFail(400, "凭据引用格式不正确");
      const ref = item as Record<string, unknown>;
      const name = str(ref.name);
      if (!ENV_NAME.test(name)) {
        return writeFail(400, `凭据引用名「${name}」必须是大写环境变量名`);
      }
      if (RESERVED_ENV_PREFIX.test(name)) {
        return writeFail(400, `凭据引用名「${name}」占用了引擎自己的前缀，不允许登记`);
      }
      credentialRefs.push({ name, purpose: str(ref.purpose) });
    }
  }

  const mcpServers: McpServerSpec[] = [];
  const rawServers = body.mcpServers;
  if (rawServers !== undefined) {
    if (!Array.isArray(rawServers)) return writeFail(400, "mcpServers 必须是数组");
    const seen = new Set<string>();
    for (const item of rawServers) {
      const result = parseMcpServer(item);
      if (!result.ok) return result;
      if (seen.has(result.data.name)) {
        return writeFail(400, `MCP 服务器名重复：「${result.data.name}」`);
      }
      seen.add(result.data.name);
      mcpServers.push(result.data);
    }
  }

  const disabledTools: string[] = [];
  const rawDisabled = body.disabledTools;
  if (rawDisabled !== undefined) {
    if (!Array.isArray(rawDisabled)) return writeFail(400, "disabledTools 必须是数组");
    for (const item of rawDisabled) {
      const name = str(item);
      if (name) disabledTools.push(name);
    }
  }

  // 缺省取出厂值：只发部分字段的调用方不会把搜索悄悄打开，也不会把其余开关关掉。
  const toggles: CompositionToggles = { ...DEFAULT_COMPOSITION_TOGGLES };
  const rawToggles = body.toggles;
  if (rawToggles !== undefined) {
    if (!isPlainObject(rawToggles)) return writeFail(400, "toggles 必须是对象");
    for (const key of COMPOSITION_TOGGLE_KEYS) {
      const value = rawToggles[key];
      if (value === undefined) continue;
      if (typeof value !== "boolean") return writeFail(400, `toggles.${key} 必须是布尔值`);
      toggles[key] = value;
    }
  }

  const rawInstructions = body.defaultInstructions;
  if (rawInstructions !== undefined && typeof rawInstructions !== "string") {
    return writeFail(400, "defaultInstructions 必须是字符串");
  }
  const defaultInstructions =
    rawInstructions === undefined ? DEFAULT_INSTRUCTIONS : rawInstructions;
  if (Buffer.byteLength(defaultInstructions, "utf8") > DEFAULT_INSTRUCTIONS_MAX_BYTES) {
    return writeFail(400, "defaultInstructions 不能超过 64 KiB");
  }

  return writeOk({
    modelApiKeyEnv,
    modelBaseUrl: str(body.modelBaseUrl),
    credentialRefs,
    mcpServers,
    disabledTools,
    toggles,
    defaultInstructions,
  });
}

function parseMcpServer(raw: unknown): WriteResult<McpServerSpec> {
  if (!raw || typeof raw !== "object") return writeFail(400, "MCP 服务器格式不正确");
  const body = raw as Record<string, unknown>;
  const name = str(body.name);
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    return writeFail(400, `MCP 服务器名「${name}」非法：只允许字母数字与 -_，最长 32 位`);
  }
  const enabled = body.enabled !== false;
  const transport = body.transport;
  if (transport !== "stdio" && transport !== "streamable-http") {
    return writeFail(400, `服务器「${name}」的 transport 必须是 stdio 或 streamable-http`);
  }

  if (transport === "stdio") {
    const command = str(body.command);
    if (!command) return writeFail(400, `服务器「${name}」缺少 command`);
    const args: string[] = [];
    if (body.args !== undefined) {
      if (!Array.isArray(body.args)) return writeFail(400, `服务器「${name}」的 args 必须是数组`);
      for (const a of body.args) args.push(String(a));
    }
    const env: Record<string, string> = {};
    if (body.env !== undefined) {
      if (!body.env || typeof body.env !== "object") {
        return writeFail(400, `服务器「${name}」的 env 必须是对象`);
      }
      for (const [key, value] of Object.entries(body.env as Record<string, unknown>)) {
        if (CREDENTIAL_KEY_WORDS.test(key)) {
          return writeFail(
            400,
            `服务器「${name}」的 env 里「${key}」看起来是凭据：组合配置会原样落盘，密钥请改走凭据引用`,
          );
        }
        env[key] = String(value);
      }
    }
    const cwd = str(body.cwd);
    return writeOk({
      name,
      enabled,
      transport,
      command,
      args,
      env,
      ...(cwd ? { cwd } : {}),
    });
  }

  const url = str(body.url);
  if (!url) return writeFail(400, `服务器「${name}」缺少 url`);
  if (body.headers !== undefined) {
    if (!isPlainObject(body.headers)) {
      return writeFail(400, `服务器「${name}」的 headers 必须是对象`);
    }
    // v1 没有“按引用在启动时注入 header”的通道；任何非空值都会原样落进 cordis.yml。
    if (Object.keys(body.headers).length > 0) {
      return writeFail(400, `服务器「${name}」暂不支持自定义 headers（组合配置会原样落盘）`);
    }
  }
  return writeOk({ name, enabled, transport, url, headers: {} });
}
