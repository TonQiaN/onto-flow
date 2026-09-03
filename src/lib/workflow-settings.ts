/**
 * 三层设置的纯类型与合成规则（ADR-0016）：全局设置给默认值，工作流设置只在允许切换的
 * 范围内覆盖，Action 从不开关插件。这里不碰数据库，服务端与客户端都能导入。
 */

/**
 * 可按工作流切换的插件开关，键名对应 catalog.ts 里带 `toggle` 字段的行：
 * - webSearch：web / web-search-deepseek / tool-web 三行（默认关：搜索用量账外）
 * - fsSearch：tool-fs-search（glob / grep）
 * - strReplaceEditor：tool-str-replace-editor
 * - todo：tool-todo
 * - compaction：token-meter / compaction-basic / tool-result-pruner 三行同进同出
 */
export interface CompositionToggles {
  webSearch: boolean;
  fsSearch: boolean;
  strReplaceEditor: boolean;
  todo: boolean;
  compaction: boolean;
}

export type CompositionToggleKey = keyof CompositionToggles;

export const COMPOSITION_TOGGLE_KEYS: readonly CompositionToggleKey[] = [
  "webSearch",
  "fsSearch",
  "strReplaceEditor",
  "todo",
  "compaction",
];

/** 出厂默认：跟上游 headless 会话一致，只有搜索因账外支出默认关。 */
export const DEFAULT_COMPOSITION_TOGGLES: CompositionToggles = {
  webSearch: false,
  fsSearch: true,
  strReplaceEditor: true,
  todo: true,
  compaction: true,
};

/** 一个工作流自己的设置：开关只写要覆盖的键，没写的继承全局；MCP 子集按服务器名。 */
export interface WorkflowSettings {
  toggles: Partial<CompositionToggles>;
  mcpServers: string[];
}

export const EMPTY_WORKFLOW_SETTINGS: WorkflowSettings = { toggles: {}, mcpServers: [] };

/** 工作流指令（workspace/AGENTS.md）与全局默认指令（<run>/home/AGENTS.md）各自的上限：64 KiB。 */
export const WORKFLOW_INSTRUCTIONS_MAX_BYTES = 64 * 1024;
export const DEFAULT_INSTRUCTIONS_MAX_BYTES = 64 * 1024;

/**
 * 每运行组合里 agent-instructions 的整批预算。上游把 $DSH_HOME/AGENTS.md（全局默认指令）与
 * workspace/AGENTS.md（工作流指令）合在一起算，超限时先整份省略排在前面的用户级文件——两份
 * 各 64 KiB 的写入口上限合计超过上游 base 的 65536 时，全局默认指令会被静默丢掉。预算盖过
 * 两份之和再留帧余量（system-reminder 框、每个文件的段落头与预算标记），超限只可能在编辑期出现。
 */
export const INSTRUCTIONS_BATCH_MAX_BYTES =
  DEFAULT_INSTRUCTIONS_MAX_BYTES + WORKFLOW_INSTRUCTIONS_MAX_BYTES + 4_096;

/** 合成生效开关：工作流覆盖压在全局默认之上。 */
export function effectiveToggles(
  global: CompositionToggles,
  workflow: Partial<CompositionToggles>,
): CompositionToggles {
  const result: CompositionToggles = { ...global };
  for (const key of COMPOSITION_TOGGLE_KEYS) {
    const value = workflow[key];
    if (typeof value === "boolean") result[key] = value;
  }
  return result;
}

/**
 * 合成生效的 MCP 服务器名：全局登记且启用，并且在工作流子集里。工作流子集里登记表没有的
 * 名字静默忽略——全局登记表可以在工作流之后变化，受理时以当时的登记表为准。
 */
export function effectiveMcpServerNames(
  globalEnabled: readonly string[],
  workflowSubset: readonly string[],
): string[] {
  const subset = new Set(workflowSubset);
  return globalEnabled.filter((name) => subset.has(name));
}

/** 受理时冻结进 runs.settings_snapshot 的三层快照。 */
export interface RunSettingsSnapshot {
  global: {
    toggles: CompositionToggles;
    /** 全局登记且启用的 MCP 服务器名 */
    mcpServers: string[];
    disabledTools: string[];
    /** 全局默认指令的 sha256；正文落在 <run>/home/AGENTS.md */
    defaultInstructionsSha256: string;
  };
  workflow: {
    settings: WorkflowSettings;
    /** 工作流指令的 sha256；正文落在 workspace/AGENTS.md */
    instructionsSha256: string;
    skills: Array<{ id: string; name: string; slug: string }>;
    tools: Array<{ id: string; name: string; publicName: string }>;
  };
  effective: {
    toggles: CompositionToggles;
    mcpServers: string[];
  };
}

/** 编辑器旁标注的 token 估算：中文按 1.5 字符/token、其它按 4 字符/token 的粗算，只用于提示成本。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (/[㐀-鿿豈-﫿]/.test(ch)) cjk++;
  const other = text.length - cjk;
  return Math.ceil(cjk / 1.5 + other / 4);
}

/** 五个开关在界面上的名字与一句说明；工作流设置页与运行页的设置快照共用。全局设置页自带更长的 TOGGLE_COPY，不用这份。 */
export const COMPOSITION_TOGGLE_LABELS: Record<
  CompositionToggleKey,
  { label: string; hint: string }
> = {
  webSearch: {
    label: "DeepSeek 搜索",
    hint: "web_search 工具。搜索是独立的辅助模型请求，用量不经 llm/stream，本站 node_usage 收不到，是账外支出。",
  },
  fsSearch: {
    label: "文件搜索",
    hint: "glob / grep 工具，包内 ripgrep，不经 shell。",
  },
  strReplaceEditor: {
    label: "结构化编辑器",
    hint: "view / create / str_replace / insert 工具，与 edit 并存。",
  },
  todo: {
    label: "待办清单",
    hint: "todo_write：模型的自我组织工具，事件进会话日志。",
  },
  compaction: {
    label: "上下文压缩",
    hint: "token 计量、工具结果剪枝与到阈值时的摘要三行同进同出；关掉后长会话会撞上下文上限。",
  },
};
