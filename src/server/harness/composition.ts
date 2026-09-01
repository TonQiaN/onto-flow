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
    // 命令执行与文件写入共用这一份沙箱策略：workspace-write 把 bash 与 write/edit
    // 的文件写入效应圈在运行工作区（外加系统临时目录）；read 在上游任何模式下都
    // 不受限，这是上游的设计决定——工作区目录本就只定义协作范围，不是安全边界
    // （ADR-0011）。围栏根按会话 cwd 解析，workspaceRoot 只是无会话时的兜底。
    {
      id: "sandbox-policy",
      name: "@deepseek-ai/dsh-sandbox-policy",
      config: { mode: "workspace-write", workspaceRoot: workspace.workspaceDir },
    },
    // macOS 上用 sandbox-exec（Seatbelt）包 argv；runner 不可用时 fail-closed，命令不裸跑。
    { id: "sandbox", name: "@deepseek-ai/dsh-sandbox-local" },
    // 无人值守：模型请求的沙箱升级一律拒绝。不挂 approval 升级同样失败，
    // 但报错语义是「没有审批服务」而不是明确的拒绝。
    { id: "approval", name: "@deepseek-ai/dsh-user-approval", config: { policy: "never" } },
    // subprocess / shell-env / bash 是 tool-bash 的 Provider，必须排在它之前
    // （类比 attachment-local 之于 tool-fs）。bash 的 cwd 显式钉进工作区：
    // executor 的兜底是 process.cwd()，与 skill-filesystem 钉根是同类坑（ADR-0007）。
    { id: "subprocess", name: "@deepseek-ai/dsh-subprocess-local" },
    { id: "shell-env", name: "@deepseek-ai/dsh-shell-env", config: { dshHome: workspace.homeDir } },
    {
      id: "bash",
      name: "@deepseek-ai/dsh-bash-sandbox",
      config: { cwd: workspace.workspaceDir, timeoutMs: 120_000 },
    },
    // fs-sandbox 原地换掉 fs-local：write/edit 走上面那份策略，read 原样直通。
    { id: "fs-sandbox", name: "@deepseek-ai/dsh-fs-sandbox" },
    { id: "fs-observation-policy", name: "@deepseek-ai/dsh-fs-observation-policy" },
    // attachments 必须在 tool-fs 之前可解析：read_image 注册在
    // ctx.inject(["attachments"], …) 内，没有存储时该工具根本不存在，
    // 视觉输入会静默地无路可走。不传 dshHome，跟随子进程的 DSH_HOME。
    { id: "attachment-local", name: "@deepseek-ai/dsh-attachment-local" },
    { id: "tool-fs", name: "@deepseek-ai/dsh-tool-fs" },
    // 后台任务通道（dsh-jobs）没挂，先关 run_in_background，免得模型走进注定报错的分支。
    { id: "tool-bash", name: "@deepseek-ai/dsh-tool-bash", config: { enableRunInBackground: false } },
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
    // Tool 插件排在 tools 服务之后、RPC 之前：先把工作流并集注册到全局工具面，
    // 每个 Action 会话再按自己的 action_tools 引用收窄继承面。
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
