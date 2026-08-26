/**
 * 每运行组合配置生成：把运行目录事实（工作区、会话根）与全局设置面
 * （模型目录、MCP 服务器）物化为 cordis.yml。
 *
 * stdout 保留给 studio-rpc 的协议帧，因此组合里不得出现 stdout logger。
 *
 * 移植自 agent-workflow-studio 的 packages/harness/src/run/composition.ts。
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { rpcPluginModulePath } from "./identity";
import {
  deepseekCompositionEntry,
  mcpCompositionEntry,
  renderCompositionYaml,
  type CompositionEntry,
  type DeepSeekProviderSpec,
  type McpServerSpec,
} from "./entries";
import type { RunWorkspace } from "./workspace";

/** 运行目录内的会话持久化根目录名。 */
export const RUN_SESSIONS_SUBDIR = "sessions";

/** 全局设置进入一次运行的组合面。 */
export interface RunCompositionOptions {
  deepseek?: DeepSeekProviderSpec;
  /** 已停用的服务器直接省略：运行组合只描述本次运行的真实能力。 */
  mcpServers?: readonly McpServerSpec[];
  /**
   * 本次运行要挂的 Tool 插件：物化到运行目录后的绝对路径。
   * 与 RPC 插件同理走绝对路径而非裸名——loader 从 node_modules 解析裸名。
   */
  toolPlugins?: readonly { id: string; modulePath: string }[];
}

/** 生成一次运行的组合 entry 清单。会话持久化根落在运行目录内。 */
export function runCompositionEntries(
  workspace: RunWorkspace,
  options: RunCompositionOptions = {},
): CompositionEntry[] {
  return [
    { id: "timer", name: "@deepseek-ai/cordis-plugin-timer" },
    { id: "llm", name: "@deepseek-ai/dsh-llm" },
    deepseekCompositionEntry(options.deepseek),
    { id: "llm-retry", name: "@deepseek-ai/dsh-llm-retry" },
    { id: "credentials", name: "@deepseek-ai/dsh-credentials-local" },
    { id: "session", name: "@deepseek-ai/dsh-session" },
    {
      id: "session-persistence-jsonl",
      name: "@deepseek-ai/dsh-session-persistence-jsonl",
      // 明文 jsonl：运行目录是调试证据的一部分，可读性优先于压缩比。
      config: {
        root: path.join(workspace.runDir, RUN_SESSIONS_SUBDIR),
        compression: "none",
      },
    },
    { id: "system-prompt", name: "@deepseek-ai/dsh-system-prompt", config: { persona: "" } },
    { id: "tools", name: "@deepseek-ai/dsh-tools" },
    { id: "fs-local", name: "@deepseek-ai/dsh-fs-local" },
    { id: "fs-observation-policy", name: "@deepseek-ai/dsh-fs-observation-policy" },
    // attachments 必须在 tool-fs 之前可解析：read_image 注册在
    // ctx.inject(["attachments"], …) 内，没有存储时该工具根本不存在，
    // 视觉输入会静默地无路可走。不传 dshHome，跟随子进程的 DSH_HOME。
    { id: "attachment-local", name: "@deepseek-ai/dsh-attachment-local" },
    { id: "tool-fs", name: "@deepseek-ai/dsh-tool-fs" },
    {
      id: "agent-instructions",
      name: "@deepseek-ai/dsh-agent-instructions",
      config: { maxBytes: 65536 },
    },
    { id: "skill", name: "@deepseek-ai/dsh-skill" },
    {
      id: "skill-filesystem",
      name: "@deepseek-ai/dsh-skill-filesystem",
      config: {
        // 批量运行不开技能 watcher，避免文件句柄随并发运行线性增长。
        watch: false,
        // 两个用户级技能根都钉进运行目录，否则 agentsHome 默认落在 ~/.agents，
        // 运行会发现并加载本机用户自己的技能——工作区隔离当场破功，实测出现过
        // agent 反复加载无关技能、再对着不存在的资源文件空转的情形（ADR-0007）。
        dshHome: workspace.homeDir,
        agentsHome: path.join(workspace.homeDir, "agents"),
      },
    },
    { id: "tool-skill", name: "@deepseek-ai/dsh-tool-skill" },
    { id: "agent", name: "@deepseek-ai/dsh-agent" },
    { id: "agent-loop", name: "@deepseek-ai/dsh-agent-loop", config: { agents: [] } },
    ...(options.mcpServers ?? []).filter((s) => s.enabled).map(mcpCompositionEntry),
    // Tool 插件排在 tools 服务之后、RPC 之前：它们注册到全局工具面，
    // 每个 Action 会话继承得到（能力不再按 Action 收窄，见 CONTEXT.md「引用」）。
    ...(options.toolPlugins ?? []).map((tool) => ({ id: tool.id, name: tool.modulePath })),
    { id: "ontoflow-rpc", name: rpcPluginModulePath() },
  ];
}

/** 把组合配置写入运行目录并返回其绝对路径。 */
export async function writeRunComposition(
  workspace: RunWorkspace,
  options: RunCompositionOptions = {},
): Promise<string> {
  const header =
    "# 本文件由 OntoFlow 为单次运行生成；stdout 保留给协议帧，不得加入 stdout logger。";
  await writeFile(
    workspace.compositionPath,
    renderCompositionYaml(header, runCompositionEntries(workspace, options)),
    "utf8",
  );
  return workspace.compositionPath;
}
