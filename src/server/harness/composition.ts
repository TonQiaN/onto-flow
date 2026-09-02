/**
 * 每运行组合配置生成：把运行目录事实（工作区、会话根、临时根）与全局设置面
 * （模型目录、MCP 服务器、可切换能力）物化为 cordis.yml。
 *
 * 行的取舍与理由记在 docs/harness/（ADR-0013）：这里只留机制级的坑——顺序依赖、
 * 必须钉死的路径与开关。`src/server/harness/catalog.ts` 是同一份清单的声明面，
 * catalog.test.ts 把两边钉死：这里多挂或少挂一行而目录没改，`npm run check` 即红。
 *
 * stdout 保留给 ontoflow-rpc 的协议帧，因此组合里不得出现 stdout logger。
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
  DEFAULT_CREDENTIAL_ENV,
  DEEPSEEK_PROVIDER,
  type CompositionEntry,
  type DeepSeekProviderSpec,
  type McpServerSpec,
} from "./entries";
import type { RunWorkspace } from "./workspace";
import { DEFAULT_COMPOSITION_TOGGLES, type CompositionToggles } from "@/lib/workflow-settings";

/** 运行目录内的会话持久化根目录名。 */
export const RUN_SESSIONS_SUBDIR = "sessions";
/** 运行 home 内的工具结果 spill 根目录名（spill-local 不钉 root 会落到进程级临时目录）。 */
export const RUN_SPILL_SUBDIR = "spill";

// 可按工作流切换的能力开关的类型与出厂默认住在 src/lib/workflow-settings.ts：全局设置给
// 默认值、工作流设置覆盖、受理时合成（ADR-0016）；这里只消费合成后的结果。
export { DEFAULT_COMPOSITION_TOGGLES, type CompositionToggles } from "@/lib/workflow-settings";

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
  toggles?: Partial<CompositionToggles>;
}

/** 生成一次运行的组合 entry 清单。会话持久化、spill、临时根全部落在运行目录内。 */
export function runCompositionEntries(
  workspace: RunWorkspace,
  options: RunCompositionOptions = {},
): CompositionEntry[] {
  const toggles: CompositionToggles = { ...DEFAULT_COMPOSITION_TOGGLES, ...options.toggles };
  const apiKeyEnv = options.deepseek?.apiKeyEnv ?? DEFAULT_CREDENTIAL_ENV;
  return [
    { id: "timer", name: "@deepseek-ai/cordis-plugin-timer" },
    { id: "llm", name: "@deepseek-ai/dsh-llm" },
    deepseekCompositionEntry(options.deepseek),
    { id: "llm-retry", name: "@deepseek-ai/dsh-llm-retry" },
    // 与 skill-filesystem 同理不开 watcher：默认会对 <run>/home/.credentials.yaml 起一个
    // chokidar watcher，并发运行下文件句柄随之线性增长，而这个文件本就不会存在。
    { id: "credentials", name: "@deepseek-ai/dsh-credentials-local", config: { watch: false } },
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
    // persona 留空是有意的：一切规范都以文件进入（工作区 AGENTS.md 与 Action 的
    // 规则），运行目录里能查到模型看见的每一句话。
    { id: "system-prompt", name: "@deepseek-ai/dsh-system-prompt", config: { persona: "" } },
    { id: "tools", name: "@deepseek-ai/dsh-tools" },
    // 每次模型请求前、顶层工具执行前把会话日志刷盘：sessions/*.jsonl 是轨迹面板的
    // 权威源，子进程崩溃不能丢它的尾部。要求 sessionPersistence 已挂。
    { id: "session-checkpoint-policy", name: "@deepseek-ai/dsh-session-checkpoint-policy" },
    // 上下文预算三件套：token-meter 是 compaction-basic 的必需依赖，pruner 是它的
    // 可选配套（无模型剪枝先于摘要）。摘要那次调用的用量挂在 compaction/summary
    // 事件上而不是 usage chunk，engine/events.ts 单独计费。三行随 compaction 开关同进同出。
    ...(toggles.compaction
      ? [
          { id: "token-meter", name: "@deepseek-ai/dsh-token-meter" },
          { id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
          {
            id: "tool-result-pruner",
            name: "@deepseek-ai/dsh-compaction-tool-result-pruner",
            config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
          },
        ]
      : []),
    // spill-local 是 spill-policy（超大工具结果）与 glob/grep 超上限结果的存储；bash 的
    // 完整输出由 subprocess-local 自己写在 TMPDIR 下，不经它。root 必须钉进运行目录，
    // 默认值是 os.tmpdir() 下的进程级私有目录。
    {
      id: "spill-local",
      name: "@deepseek-ai/dsh-spill-local",
      config: { root: path.join(workspace.homeDir, RUN_SPILL_SUBDIR) },
    },
    { id: "spill-policy", name: "@deepseek-ai/dsh-spill-policy", config: { maxInlineBytes: 50_000 } },
    // 零配置守卫：timeout-policy 只对声明了 timeoutMs 的工具生效（tool-web、glob/grep；
    // MCP 工具的超时由 MCP SDK 的请求超时自己强制，不经它）；
    // repeat-tool-reminder 只注入提醒、不否决调用。
    { id: "timeout-policy", name: "@deepseek-ai/dsh-tool-call-timeout-policy" },
    {
      id: "repeat-tool-reminder",
      name: "@deepseek-ai/dsh-repeat-tool-reminder",
      config: { thresholds: [3, 5, 8], argumentsPreviewChars: 500 },
    },
    // 命令执行与文件写入共用这一份沙箱策略：workspace-write 把 bash 与 write/edit
    // 的文件写入效应圈在运行工作区（外加临时根，后者经 TMPDIR 钉在 <run>/tmp）；
    // read 在上游任何模式下都不受限，这是上游的设计决定——工作区目录本就只定义
    // 协作范围，不是安全边界（ADR-0011）。围栏根按会话 cwd 解析，workspaceRoot
    // 只是无会话时的兜底。
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
    // glob/grep 走包内 ripgrep（@vscode/ripgrep 的平台包），不经 shell；结果超上限
    // 落到上面的 spill store。sampleOverCapGlobResults 是必填项，取上游 base 的值。
    ...(toggles.fsSearch
      ? [
          {
            id: "tool-fs-search",
            name: "@deepseek-ai/dsh-tool-fs-search",
            config: { sampleOverCapGlobResults: false },
          },
        ]
      : []),
    ...(toggles.strReplaceEditor
      ? [
          {
            id: "tool-str-replace-editor",
            name: "@deepseek-ai/dsh-tool-str-replace-editor",
            config: { maxOutputChars: 16_000 },
          },
        ]
      : []),
    // 后台任务通道（dsh-jobs）不挂（ADR-0014），关掉 run_in_background 免得模型走进注定报错的分支。
    { id: "tool-bash", name: "@deepseek-ai/dsh-tool-bash", config: { enableRunInBackground: false } },
    // allowParallelInProgress 是必填项；取上游 base 的值。
    ...(toggles.todo
      ? [{ id: "tool-todo", name: "@deepseek-ai/dsh-tool-todo", config: { allowParallelInProgress: true } }]
      : []),
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
    // 搜索三件套：web 是 seam，web-search-deepseek 用与模型同一把凭据引用名，
    // tool-web 只开 search 不开 fetch（上游同样不挂 fetch provider：目标由模型选、
    // SSRF 防护未做）。默认不挂，见 CompositionToggles.webSearch。
    ...(toggles.webSearch
      ? [
          { id: "web", name: "@deepseek-ai/dsh-web", config: { searchProvider: DEEPSEEK_PROVIDER } },
          { id: "web-search-deepseek", name: "@deepseek-ai/dsh-web-search-deepseek", config: { apiKeyEnv } },
          {
            id: "tool-web",
            name: "@deepseek-ai/dsh-tool-web",
            config: { search: true, fetch: false, searchTimeoutMs: 60_000 },
          },
        ]
      : []),
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
