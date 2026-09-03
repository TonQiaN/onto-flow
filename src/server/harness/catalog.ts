/**
 * DeepSeek Harness 插件目录：每一行上游插件（或本项目自有插件）在本项目里的
 * 决定、分组与定制标记的**声明面**。可执行面是 composition.ts；散文理由在
 * docs/harness/；设置页的插件面板按这里分区展示。三方由 catalog.test.ts 钉死
 * （ADR-0013）：
 *
 * - 默认设置下 runCompositionEntries 的每个 entry id 必须对应目录里一行
 *   决定为「必挂 / 挂 / 自有」且默认挂载的行；反之亦然。
 * - 决定为「挂」但 mountedByDefault=false 的行，只在对应开关打开时进入组合。
 * - 目录每行的 package 必须出现在它那组的 docs/harness/NN-*.md 里。
 * - fork 行记的上游文件，在 _reference/deepseek-harness 存在时必须真的存在。
 *
 * 分组默认方向就是举证方向（docs/harness/README.md）：组 1–4 跟上游 headless
 * 会话保持一致、去掉要给理由；组 5–8 默认不挂；组 9 是同一 seam 的替代
 * provider；组 10 是本项目自己写的部分。
 *
 * 这里的一句话理由是给面板与测试用的；完整论证一律在文档里。
 */

/** 十组分类；编号即 docs/harness/ 下的文件前缀。 */
export const PLUGIN_GROUPS = {
  1: { title: "骨架", file: "01-骨架.md", defaultStance: "必挂" },
  2: { title: "模型的手脚", file: "02-模型的手脚.md", defaultStance: "跟上游，去掉要理由" },
  3: { title: "模型的上下文", file: "03-模型的上下文.md", defaultStance: "跟上游，去掉要理由" },
  4: { title: "会话的记录", file: "04-会话的记录.md", defaultStance: "跟上游" },
  5: { title: "委派与自编排", file: "05-委派与自编排.md", defaultStance: "不挂：编排归图" },
  6: { title: "面向人的交互", file: "06-面向人的交互.md", defaultStance: "不挂：运行中没有人" },
  7: { title: "宿主与界面", file: "07-宿主与界面.md", defaultStance: "不挂：不影响 agent" },
  8: { title: "遥测与身份", file: "08-遥测与身份.md", defaultStance: "不挂：内容不出本机" },
  9: {
    title: "同一 seam 的替代 provider",
    file: "09-替代provider.md",
    defaultStance: "不挂，记为备选",
  },
  10: { title: "本项目自有", file: "10-本项目自有.md", defaultStance: "自有" },
} as const;

export type PluginGroupId = keyof typeof PLUGIN_GROUPS;

/**
 * 四值决定加两个特殊值：「备选」= 同一 seam 里不挂但值得记的替代实现；
 * 「自有」= 本项目自己写的插件或改造，不存在"挂不挂"的问题。
 */
export type PluginDecision = "必挂" | "挂" | "不挂" | "待定" | "备选" | "自有";

/** 定制方式三阶，按序优先：能用配置就不包装，能包装就不 fork（docs/harness/README.md）。 */
export type CustomizationKind = "配置" | "包装" | "fork";

export interface PluginCustomization {
  kind: CustomizationKind;
  /** 改了什么，一句话。 */
  what: string;
  /** 为什么改，一句话。 */
  why: string;
  /** fork 与包装所依据的上游文件（相对 _reference/deepseek-harness）与版本。 */
  upstream?: { path: string; version: string };
}

export interface PluginCatalogRow {
  /** 上游包名；一族包用 `@deepseek-ai/dsh-client-*` 这种通配写法；自有模块写仓库内路径。 */
  package: string;
  group: PluginGroupId;
  decision: PluginDecision;
  /**
   * 组合里的 entry id。固定行写 id；按运行动态生成的行写 idPrefix
   * （MCP 服务器、Tool 插件）。不进组合的库与不挂的行没有这个字段。
   */
  entry?: { id: string } | { idPrefix: string };
  /**
   * 决定为「挂」的行是否在默认设置下就进入组合。false 表示挂载由开关决定
   * （CompositionToggles / 工作流设置），目录仍视它为「挂」。
   */
  mountedByDefault?: false;
  /** 能否由单个工作流覆盖全局默认（ADR-0016）。骨架、沙箱、审批、记录一律 false。 */
  workflowToggle: boolean;
  /**
   * 控制这一行挂载的开关键（src/lib/workflow-settings.ts 的 CompositionToggles）。
   * 有它的行由开关决定进不进组合，catalog.test 对每个键都验一遍开与关。
   */
  toggle?: CompositionToggleKey;
  /** 一句话理由；完整论证在组文档里。 */
  reason: string;
  customization?: PluginCustomization;
}

import type { CompositionToggleKey } from "@/lib/workflow-settings";

/** 目前钉住的上游版本；package.json 的 @deepseek-ai/* 钉版与 docs/harness/README.md 都必须与它一致。 */
export const UPSTREAM_VERSION = "0.1.1-rc.2";

const V = UPSTREAM_VERSION;

export const PLUGIN_CATALOG: readonly PluginCatalogRow[] = [
  // ───────────────────────── 组 1：骨架 ─────────────────────────
  {
    package: "@deepseek-ai/cordis",
    group: 1,
    decision: "必挂",
    workflowToggle: false,
    reason: "插件框架本身；不是组合行，由 runner 经 dsh-app-boot 装载。",
  },
  {
    package: "@deepseek-ai/cordis-plugin-loader",
    group: 1,
    decision: "必挂",
    workflowToggle: false,
    reason: "读 cordis.yml、解析插件的装载器；boot() 内部使用，不是组合行。",
  },
  {
    package: "@deepseek-ai/dsh-app-boot",
    group: 1,
    decision: "必挂",
    workflowToggle: false,
    reason: "runner 用它的 boot() 与 fail-loud 守卫起整棵树；不是组合行。",
  },
  {
    package: "@deepseek-ai/cordis-plugin-timer",
    group: 1,
    decision: "必挂",
    entry: { id: "timer" },
    workflowToggle: false,
    reason:
      "随 disposal 回收的定时器；app-boot 把它列为依赖、上游 base 第一行。本项目挂的包里没有一个调用 ctx.timeout 家族，保留只因去掉要举证。",
  },
  {
    package: "@deepseek-ai/dsh-llm",
    group: 1,
    decision: "必挂",
    entry: { id: "llm" },
    workflowToggle: false,
    reason: "模型适配器注册表与消息/流式词汇表；没有它没有模型调用。",
  },
  {
    package: "@deepseek-ai/dsh-llm-deepseek",
    group: 1,
    decision: "必挂",
    entry: { id: "llm-deepseek" },
    workflowToggle: false,
    reason: "唯一的模型路由 deepseek-official；凭据只以引用名进入（ADR-0006）。",
    customization: {
      kind: "配置",
      what: "apiKeyEnv 由全局设置的凭据引用名给出，baseURL 可覆盖；值永远不进配置文件。",
      why: "凭据以引用名进入、值由 spawn 环境白名单注入（ADR-0006）。",
    },
  },
  {
    package: "@deepseek-ai/dsh-llm-retry",
    group: 1,
    decision: "必挂",
    entry: { id: "llm-retry" },
    workflowToggle: false,
    reason: "按 provider 路由的请求重试；瞬时网络错误不该失败一个付费节点。",
  },
  {
    package: "@deepseek-ai/dsh-credentials",
    group: 1,
    decision: "必挂",
    workflowToggle: false,
    reason: "凭据 seam 定义；credentials-local 是它的 provider。",
  },
  {
    package: "@deepseek-ai/dsh-credentials-local",
    group: 1,
    decision: "必挂",
    entry: { id: "credentials" },
    workflowToggle: false,
    reason: "从子进程环境按引用名解析凭据；$DSH_HOME 已钉进运行目录，不会读到机器上的 .env。",
    customization: {
      kind: "配置",
      what: "watch=false。",
      why: "上游默认对 <run>/home/.credentials.yaml 起一个 chokidar watcher，这个文件在运行里本就不存在；与 skill-filesystem 同理，并发运行下文件句柄不该随运行数线性增长。",
      upstream: { path: "packages/credentials/credentials-local/src/index.ts", version: V },
    },
  },
  {
    package: "@deepseek-ai/dsh-session",
    group: 1,
    decision: "必挂",
    entry: { id: "session" },
    workflowToggle: false,
    reason: "事件溯源的会话日志；模型可见即已记录的不变量住在这里。",
  },
  {
    package: "@deepseek-ai/dsh-system-prompt",
    group: 1,
    decision: "必挂",
    entry: { id: "system-prompt" },
    workflowToggle: false,
    reason: "提示词片段与工具 schema 的组装注册表。",
    customization: {
      kind: "配置",
      what: "persona 固定为空串。",
      why: "一切规范以文件进入（工作区 AGENTS.md、Action 规则），运行目录里能查到模型看见的每一句话。",
    },
  },
  {
    package: "@deepseek-ai/dsh-tools",
    group: 1,
    decision: "必挂",
    entry: { id: "tools" },
    workflowToggle: false,
    reason: "工具注册表与执行流水线；restrict/guard 是 Action 收窄工具面的机制。",
  },
  {
    package: "@deepseek-ai/dsh-agent",
    group: 1,
    decision: "必挂",
    entry: { id: "agent" },
    workflowToggle: false,
    reason: "Agent 接口、注册表与 agent/* 事件；ontoflow-rpc 注入 agents 创建会话。",
  },
  {
    package: "@deepseek-ai/dsh-agent-loop",
    group: 1,
    decision: "必挂",
    entry: { id: "agent-loop" },
    workflowToggle: false,
    reason:
      "一切的基础：默认的 agent 循环驱动器。上游没有步数上限，由 ontoflow-rpc 在会话 scope 上补。",
    customization: {
      kind: "配置",
      what: "agents 固定为空数组，会话全部由 RPC 懒创建。",
      why: "启动期不创建任何 agent；每个 Action 的会话在 session/prompt 时按自己的定义创建。",
    },
  },
  {
    package: "@deepseek-ai/dsh-scope",
    group: 1,
    decision: "必挂",
    workflowToggle: false,
    reason: "按 agent 的作用域注册原语；库，不是组合行。会话级收窄全靠它。",
  },
  {
    package: "@deepseek-ai/dsh-sdk-protocol",
    group: 1,
    decision: "必挂",
    workflowToggle: false,
    reason: "换行分隔 JSON-RPC 的传输与协议类型；Next 侧与 ontoflow-rpc 共用，不是组合行。",
  },
  {
    package: "@deepseek-ai/schemastery",
    group: 1,
    decision: "必挂",
    workflowToggle: false,
    reason: "每个插件的 Config schema；库。",
  },
  {
    package: "@deepseek-ai/cosmokit",
    group: 1,
    decision: "必挂",
    workflowToggle: false,
    reason: "框架基础工具库。",
  },
  {
    package: "@deepseek-ai/cordis-plugin-include",
    group: 1,
    decision: "必挂",
    workflowToggle: false,
    reason:
      "Loader 的 cordis:include builtin：boot() 用它把运行的 cordis.yml 挂成根 include（激活清单里每行都带 include: 前缀）；分层 patch 的用法不用（ADR-0013）。机制，不是组合行。",
  },
  {
    package: "@deepseek-ai/cordis-plugin-group",
    group: 1,
    decision: "必挂",
    workflowToggle: false,
    reason:
      "Loader 的 cordis:group builtin，与 include 同为 boot() 注册的机制；平铺清单不用嵌套分组。机制，不是组合行。",
  },
  {
    package: "@deepseek-ai/dsh-home-paths",
    group: 1,
    decision: "必挂",
    workflowToggle: false,
    reason:
      "DSH_HOME 路径解析库；attachment-local、skill-filesystem 等已挂行经它把根解析进运行目录。库。",
  },
  {
    package: "@deepseek-ai/dsh-launch-environment",
    group: 1,
    decision: "必挂",
    workflowToggle: false,
    reason:
      "启动环境记录库，app-boot 的依赖；本项目由 Next 侧显式注入白名单环境，不用它的分层来源。库。",
  },

  // ───────────────────────── 组 2：模型的手脚 ─────────────────────────
  {
    package: "@deepseek-ai/dsh-fs",
    group: 2,
    decision: "挂",
    workflowToggle: false,
    reason: "文件系统 seam 定义；fs-sandbox 是它的 provider。",
  },
  {
    package: "@deepseek-ai/dsh-fs-sandbox",
    group: 2,
    decision: "挂",
    entry: { id: "fs-sandbox" },
    workflowToggle: false,
    reason: "write/edit 按沙箱策略围栏、read 直通的 fs provider；换掉 fs-local（ADR-0011）。",
  },
  {
    package: "@deepseek-ai/dsh-fs-observation-policy",
    group: 2,
    decision: "挂",
    entry: { id: "fs-observation-policy" },
    workflowToggle: false,
    reason: "先读后写/编辑的策略门；上游要求与 tool-fs 一起挂。",
  },
  {
    package: "@deepseek-ai/dsh-tool-fs",
    group: 2,
    decision: "挂",
    entry: { id: "tool-fs" },
    workflowToggle: false,
    reason: "read / write / edit / read_image：所有 Action 的基础工具。",
  },
  {
    package: "@deepseek-ai/dsh-attachment",
    group: 2,
    decision: "挂",
    workflowToggle: false,
    reason: "附件存储 seam 定义；没有它 read_image 根本不注册。",
  },
  {
    package: "@deepseek-ai/dsh-attachment-local",
    group: 2,
    decision: "挂",
    entry: { id: "attachment-local" },
    workflowToggle: false,
    reason: "图片字节的内容寻址存储，根随 DSH_HOME 落在 <run>/home。",
  },
  {
    package: "@deepseek-ai/dsh-subprocess",
    group: 2,
    decision: "挂",
    workflowToggle: false,
    reason: "子进程 seam 定义；bash、glob/grep 都经它 spawn。",
  },
  {
    package: "@deepseek-ai/dsh-subprocess-local",
    group: 2,
    decision: "挂",
    entry: { id: "subprocess" },
    workflowToggle: false,
    reason: "本地子进程 provider；长输出经 spill store 落盘。",
  },
  {
    package: "@deepseek-ai/dsh-shell",
    group: 2,
    decision: "挂",
    workflowToggle: false,
    reason: "bash 执行器 seam 定义。",
  },
  {
    package: "@deepseek-ai/dsh-shell-env",
    group: 2,
    decision: "挂",
    entry: { id: "shell-env" },
    workflowToggle: false,
    reason: "托管的 DSH_* shell 变量注册表；tool-bash 的 provider。",
    customization: {
      kind: "配置",
      what: "dshHome 钉到 <run>/home。",
      why: "shell 里的 DSH_HOME 必须与子进程的隔离 home 一致。",
    },
  },
  {
    package: "@deepseek-ai/dsh-bash-sandbox",
    group: 2,
    decision: "挂",
    entry: { id: "bash" },
    workflowToggle: false,
    reason: "经 ctx.sandbox 围栏每条命令的 bash 执行器；换掉 bash-local（ADR-0011）。",
    customization: {
      kind: "配置",
      what: "cwd 钉到工作区、timeoutMs 120 秒。",
      why: "executor 的 cwd 兜底是 process.cwd()；Action 是有界前台任务，长命令靠拆节点。",
    },
  },
  {
    package: "@deepseek-ai/dsh-tool-bash",
    group: 2,
    decision: "挂",
    entry: { id: "tool-bash" },
    workflowToggle: false,
    reason: "bash 工具：所有 Action 可见的基础能力，格式转换在会话里做（ADR-0011）。",
    customization: {
      kind: "配置",
      what: "enableRunInBackground=false，参数从 schema 里整个移除。",
      why: "后台作业通道不挂（ADR-0014），不让模型走进注定报错的分支。",
    },
  },
  {
    package: "@deepseek-ai/dsh-sandbox",
    group: 2,
    decision: "挂",
    workflowToggle: false,
    reason: "进程沙箱 seam 定义。",
  },
  {
    package: "@deepseek-ai/dsh-sandbox-policy",
    group: 2,
    decision: "挂",
    entry: { id: "sandbox-policy" },
    workflowToggle: false,
    reason: "bash 与 write/edit 共用的一份策略解析器。",
    customization: {
      kind: "配置",
      what: "mode 固定 workspace-write，workspaceRoot 钉到工作区。",
      why: "写入圈在工作区 + 临时根；read 与网络不圈是上游词汇的边界（ADR-0011）。",
    },
  },
  {
    package: "@deepseek-ai/dsh-sandbox-local",
    group: 2,
    decision: "挂",
    entry: { id: "sandbox" },
    workflowToggle: false,
    reason: "macOS Seatbelt / Linux landlock-run 的内核围栏；runner 不可用则 fail-closed。",
    customization: {
      kind: "配置",
      what: "经环境变量 TMPDIR=<run>/tmp 把它的临时根钉进运行目录。",
      why: "围栏允许写系统临时目录；不钉的话模型的临时文件落在 /tmp，清理与磁盘统计都管不到。",
    },
  },
  {
    package: "@deepseek-ai/dsh-user-approval",
    group: 2,
    decision: "挂",
    entry: { id: "approval" },
    workflowToggle: false,
    reason: "审批 seam；沙箱升级请求需要一个明确的回答者。",
    customization: {
      kind: "配置",
      what: "policy 固定 never。",
      why: "无人值守：升级一律拒绝，且报错语义是「拒绝」而不是「没有审批服务」。",
    },
  },
  {
    package: "@deepseek-ai/dsh-tool-fs-search",
    group: 2,
    decision: "挂",
    entry: { id: "tool-fs-search" },
    workflowToggle: true,
    toggle: "fsSearch",
    reason: "glob / grep：包内 ripgrep、不经 shell；CLI 会话里有的发现工具。",
    customization: {
      kind: "配置",
      what: "sampleOverCapGlobResults=false（必填项，取上游 base 值）。",
      why: "结果超上限时保留确定性的前缀而不是采样。",
    },
  },
  {
    package: "@deepseek-ai/dsh-tool-str-replace-editor",
    group: 2,
    decision: "挂",
    entry: { id: "tool-str-replace-editor" },
    workflowToggle: true,
    toggle: "strReplaceEditor",
    reason: "view / create / str_replace / insert；与 edit 重叠但上游两套并存，对等保留。",
  },
  {
    package: "@deepseek-ai/dsh-skill",
    group: 2,
    decision: "挂",
    entry: { id: "skill" },
    workflowToggle: false,
    reason: "技能提供方注册表；Skill 库经它到达模型。",
  },
  {
    package: "@deepseek-ai/dsh-skill-filesystem",
    group: 2,
    decision: "挂",
    entry: { id: "skill-filesystem" },
    workflowToggle: false,
    reason: "从工作区 .agents/skills 发现技能目录；模型看描述自行加载。",
    customization: {
      kind: "配置",
      what: "watch=false；dshHome 与 agentsHome 都钉进 <run>/home。",
      why: "并发运行不开 watcher；agentsHome 默认 ~/.agents 会加载机器主人的技能，实测出过事（ADR-0007）。",
    },
  },
  {
    package: "@deepseek-ai/dsh-tool-skill",
    group: 2,
    decision: "挂",
    entry: { id: "tool-skill" },
    workflowToggle: false,
    reason: "skill 工具：把技能目录与加载器交给模型。",
  },
  {
    package: "@deepseek-ai/dsh-mcp-client",
    group: 2,
    decision: "挂",
    entry: { idPrefix: "mcp-" },
    workflowToggle: true,
    reason: "全局登记的 MCP 服务器逐台一行；连接失败不失败整棵树。",
    customization: {
      kind: "配置",
      what: "failOnStartupError 恒为 false；stdio env 拒绝凭据形键名。",
      why: "单台 MCP 不能绑架整个运行；env 会原样落进组合文件。",
    },
  },
  {
    package: "@deepseek-ai/dsh-web",
    group: 2,
    decision: "挂",
    entry: { id: "web" },
    mountedByDefault: false,
    workflowToggle: true,
    toggle: "webSearch",
    reason: "web 能力 seam；随搜索开关挂载。",
    customization: {
      kind: "配置",
      what: "searchProvider 钉 deepseek-official。",
      why: "只挂一个 provider 时上游会自动选中，钉死是为了读组合文件时一目了然。",
    },
  },
  {
    package: "@deepseek-ai/dsh-web-search-deepseek",
    group: 2,
    decision: "挂",
    entry: { id: "web-search-deepseek" },
    mountedByDefault: false,
    workflowToggle: true,
    toggle: "webSearch",
    reason:
      "DeepSeek 搜索 provider，用与模型相同的凭据引用名。默认关：搜索用量不经 llm/stream，是账外支出。",
  },
  {
    package: "@deepseek-ai/dsh-tool-web",
    group: 2,
    decision: "挂",
    entry: { id: "tool-web" },
    mountedByDefault: false,
    workflowToggle: true,
    toggle: "webSearch",
    reason: "web_search 工具；随搜索开关挂载。",
    customization: {
      kind: "配置",
      what: "search=true、fetch=false、searchTimeoutMs 60 秒。",
      why: "与上游一致不挂 fetch provider（目标由模型选、SSRF 防护未做）；搜索是服务端检索的完整模型请求，给 60 秒。",
    },
  },
  {
    package: "@deepseek-ai/dsh-code-runtime",
    group: 2,
    decision: "不挂",
    workflowToggle: false,
    reason:
      "Code Mode（run_code）的执行 seam；上游自己标注 DSH_TOOLS_MODE 是临时开关，等它稳定成按会话配置再评估。",
  },
  {
    package: "@deepseek-ai/dsh-code-runtime-worker-thread",
    group: 2,
    decision: "不挂",
    workflowToggle: false,
    reason: "随 code-runtime 一起不挂。",
  },
  {
    package: "@deepseek-ai/dsh-terminal",
    group: 2,
    decision: "不挂",
    workflowToggle: false,
    reason: "持久 PTY seam；Action 是有界任务，每次 bash 调用都是新 shell 就够了。",
  },
  {
    package: "@deepseek-ai/dsh-terminal-bash",
    group: 2,
    decision: "不挂",
    workflowToggle: false,
    reason: "随 terminal 一起不挂。",
  },
  {
    package: "@deepseek-ai/dsh-tool-terminal",
    group: 2,
    decision: "不挂",
    workflowToggle: false,
    reason: "六个 PTY 工具，随 terminal 一起不挂。",
  },
  {
    package: "@deepseek-ai/dsh-tool-bash-persistent",
    group: 2,
    decision: "不挂",
    workflowToggle: false,
    reason: "持久 bash 需要 PTY 后端；与无状态 bash 注册同一个 bash 名，二选一。",
  },
  {
    package: "@deepseek-ai/dsh-lsp",
    group: 2,
    decision: "不挂",
    workflowToggle: false,
    reason: "语言服务器 seam；工作区里没有代码库与语言服务器，编码专用能力。",
  },
  {
    package: "@deepseek-ai/dsh-tool-lsp",
    group: 2,
    decision: "不挂",
    workflowToggle: false,
    reason: "随 lsp 一起不挂。",
  },
  {
    package: "@deepseek-ai/dsh-web-fetch-http",
    group: 2,
    decision: "不挂",
    workflowToggle: false,
    reason:
      "匿名 HTTP 抓取 provider；上游自己也不挂：目标由模型选、SSRF 防护未做。网络本就经 bash 不受限。",
  },

  // ───────────────────────── 组 3：模型的上下文 ─────────────────────────
  {
    package: "@deepseek-ai/dsh-agent-instructions",
    group: 3,
    decision: "挂",
    entry: { id: "agent-instructions" },
    workflowToggle: false,
    reason:
      "从工作区 AGENTS.md 载入工作流级共同指令；工作区内的空 .git 把 projectRoot 钉在运行边界内。",
    customization: {
      kind: "配置",
      what: "maxBytes = 全局默认指令上限 + 工作流指令上限 + 帧余量（65536 + 65536 + 4096），不是上游 base 的 65536。",
      why: "上游预算是整批的：$DSH_HOME/AGENTS.md 与 workspace/AGENTS.md 合在一起算，超限先整份省略前者；两份各 64 KiB 的写入口上限合计超过 65536 时全局默认指令会被静默丢掉。预算盖过两份之和，超限只可能在编辑期出现。",
    },
  },
  {
    package: "@deepseek-ai/dsh-spill",
    group: 3,
    decision: "挂",
    workflowToggle: false,
    reason: "spill 存储 seam 定义。",
  },
  {
    package: "@deepseek-ai/dsh-spill-local",
    group: 3,
    decision: "挂",
    entry: { id: "spill-local" },
    workflowToggle: false,
    reason:
      "超大工具结果整份落盘的私有存储；消费方是 spill-policy 与 glob/grep 的超上限结果。bash 的完整输出由 subprocess-local 自己写在 TMPDIR 下，不经它。",
    customization: {
      kind: "配置",
      what: "root 钉到 <run>/home/spill。",
      why: "不钉 root 时默认在 os.tmpdir() 下建进程级私有目录，落点跑出运行目录。",
    },
  },
  {
    package: "@deepseek-ai/dsh-spill-policy",
    group: 3,
    decision: "挂",
    entry: { id: "spill-policy" },
    workflowToggle: false,
    reason: "超过 50000 字节的纯文本工具结果换成首尾预览 + 路径，模型可 read/grep 回读。",
  },
  {
    package: "@deepseek-ai/dsh-output-retention",
    group: 3,
    decision: "挂",
    workflowToggle: false,
    reason: "spill 预览用的有界保留原语；库。",
  },
  {
    package: "@deepseek-ai/dsh-token-meter",
    group: 3,
    decision: "挂",
    entry: { id: "token-meter" },
    workflowToggle: true,
    toggle: "compaction",
    reason: "回放感知的 token 计量；compaction-basic 的必需依赖。",
  },
  {
    package: "@deepseek-ai/dsh-compaction",
    group: 3,
    decision: "挂",
    workflowToggle: false,
    reason: "压缩 seam 定义。",
  },
  {
    package: "@deepseek-ai/dsh-compaction-basic",
    group: 3,
    decision: "挂",
    entry: { id: "compaction-basic" },
    workflowToggle: true,
    toggle: "compaction",
    reason:
      "上下文压力到阈值时先剪枝再摘要；产物在文件里，摘要丢的细节模型可重读（ADR-0008）。摘要用量由 engine/events.ts 从 compaction/summary 事件计费；摘要在提交阶段失败时上游不写该事件，那笔费用无法计费。",
  },
  {
    package: "@deepseek-ai/dsh-compaction-tool-result-pruner",
    group: 3,
    decision: "挂",
    entry: { id: "tool-result-pruner" },
    workflowToggle: true,
    toggle: "compaction",
    reason: "无模型的首中尾剪枝；compaction-basic 的可选配套，先于摘要运行。",
  },
  {
    package: "@deepseek-ai/dsh-repeat-tool-reminder",
    group: 3,
    decision: "挂",
    entry: { id: "repeat-tool-reminder" },
    workflowToggle: false,
    reason: "连续相同工具调用达 3/5/8 次时注入递进提醒；不否决、不改写。直接针对空转 agent。",
  },
  {
    package: "@deepseek-ai/dsh-tool-call-timeout-policy",
    group: 3,
    decision: "挂",
    entry: { id: "timeout-policy" },
    workflowToggle: false,
    reason:
      "对声明了 timeoutMs 的工具加协作式截止；零配置。今天经它的是 tool-web 与 glob/grep；MCP 工具的超时由 MCP SDK 的请求超时自己强制，不经它。",
  },
  {
    package: "@deepseek-ai/dsh-timeout",
    group: 3,
    decision: "挂",
    workflowToggle: false,
    reason: "timeout/deadline 原语；库。",
  },
  {
    package: "@deepseek-ai/dsh-tool-todo",
    group: 3,
    decision: "挂",
    entry: { id: "tool-todo" },
    workflowToggle: true,
    toggle: "todo",
    reason: "todo_write：模型的自我组织工具，事件进会话日志；不需要有人在。",
    customization: {
      kind: "配置",
      what: "allowParallelInProgress=true（必填项，取上游 base 值）。",
      why: "多步任务允许同时几项进行中。",
    },
  },
  {
    package: "@deepseek-ai/dsh-time-context",
    group: 3,
    decision: "不挂",
    workflowToggle: false,
    reason: "每步注入当前时间；上游 base 也不挂。需要日期的 Action 由 prompt 或 bash date 解决。",
  },
  {
    package: "@deepseek-ai/dsh-tmux-context",
    group: 3,
    decision: "不挂",
    workflowToggle: false,
    reason: "tmux 窗格位置上下文；运行不在 tmux 里。",
  },
  {
    package: "@deepseek-ai/dsh-file-reference",
    group: 3,
    decision: "不挂",
    workflowToggle: false,
    reason: "Web 客户端 @file 引用的发现契约；没有人在打字。",
  },
  {
    package: "@deepseek-ai/dsh-file-reference-local",
    group: 3,
    decision: "不挂",
    workflowToggle: false,
    reason: "随 file-reference 一起不挂。",
  },
  {
    package: "@deepseek-ai/dsh-session-reference",
    group: 3,
    decision: "不挂",
    workflowToggle: false,
    reason: "跨会话快照引用；Action 之间只经工作区文件交流（ADR-0008）。",
  },
  {
    package: "@deepseek-ai/dsh-persona",
    group: 3,
    decision: "不挂",
    workflowToggle: false,
    reason: "组合层写死的部署 persona；我们的 persona 留空，规范全走文件。",
  },
  {
    package: "@deepseek-ai/dsh-agent-tool-presentation",
    group: 3,
    decision: "不挂",
    workflowToggle: false,
    reason: "按 agent 选 Code Mode / native 的呈现器；Code Mode 不挂。",
  },

  // ───────────────────────── 组 4：会话的记录 ─────────────────────────
  {
    package: "@deepseek-ai/dsh-session-persistence",
    group: 4,
    decision: "挂",
    workflowToggle: false,
    reason: "持久化 seam 定义。",
  },
  {
    package: "@deepseek-ai/dsh-session-persistence-jsonl",
    group: 4,
    decision: "挂",
    entry: { id: "session-persistence-jsonl" },
    workflowToggle: false,
    reason: "会话 JSONL 是 Action 轨迹的权威源；运行详情从它投影。",
    customization: {
      kind: "配置",
      what: "root 钉到 <run>/sessions，compression=none。",
      why: "运行目录是调试证据的一部分，可读性优先于压缩比。",
    },
  },
  {
    package: "@deepseek-ai/dsh-session-checkpoint-policy",
    group: 4,
    decision: "挂",
    entry: { id: "session-checkpoint-policy" },
    workflowToggle: false,
    reason: "每次模型请求前、顶层工具执行前刷盘；子进程崩溃不丢 JSONL 尾部。",
  },
  {
    package: "@deepseek-ai/dsh-atomic-write",
    group: 4,
    decision: "挂",
    workflowToggle: false,
    reason: "原子文件替换原语；库。",
  },
  {
    package: "@deepseek-ai/dsh-invariants",
    group: 4,
    decision: "不挂",
    workflowToggle: false,
    reason: "包自有运行时不变量的注册表；上游 base 也不挂，各包在它缺席时自行降级。",
  },
  {
    package: "@deepseek-ai/dsh-session-projection",
    group: 4,
    decision: "不挂",
    workflowToggle: false,
    reason:
      "按会话投影注册表，服务 Web 列表行与 subagent 目录；我们的投影在 Next 侧（trajectory.ts）。",
  },
  {
    package: "@deepseek-ai/dsh-session-projection-cache",
    group: 4,
    decision: "不挂",
    workflowToggle: false,
    reason: "随 session-projection 一起不挂。",
  },
  {
    package: "@deepseek-ai/dsh-session-stats",
    group: 4,
    decision: "不挂",
    workflowToggle: false,
    reason: "聊天统计条投影；Web 专用。",
  },
  {
    package: "@deepseek-ai/dsh-session-query",
    group: 4,
    decision: "不挂",
    workflowToggle: false,
    reason: "会话全文检索契约；运行详情按 runDir 直接读 JSONL，不需要检索服务。",
  },
  {
    package: "@deepseek-ai/dsh-tool-session-query",
    group: 4,
    decision: "不挂",
    workflowToggle: false,
    reason: "让模型搜自己历史会话的工具；每轮都是全新会话，历史经文件传递。",
  },
  {
    package: "@deepseek-ai/dsh-session-log-export",
    group: 4,
    decision: "不挂",
    workflowToggle: false,
    reason: "Web 的 /export 命令；没有人在。",
  },

  // ───────────────────────── 组 5：委派与自编排（ADR-0014） ─────────────────────────
  {
    package: "@deepseek-ai/dsh-subagent",
    group: 5,
    decision: "不挂",
    workflowToggle: false,
    reason: "子 agent 逃出工具收窄、计费、轨迹与步数上限（ADR-0014）。",
  },
  {
    package: "@deepseek-ai/dsh-subagent-spawn-in-process",
    group: 5,
    decision: "不挂",
    workflowToggle: false,
    reason: "随 subagent 一起不挂。",
  },
  {
    package: "@deepseek-ai/dsh-subagent-fork-in-process",
    group: 5,
    decision: "不挂",
    workflowToggle: false,
    reason: "随 subagent 一起不挂。",
  },
  {
    package: "@deepseek-ai/dsh-subagent-in-process-driver",
    group: 5,
    decision: "不挂",
    workflowToggle: false,
    reason: "不作为运行时依赖；其 structured.ts 是本项目结构化输出运行时的 fork 原型（见组 10）。",
  },
  {
    package: "@deepseek-ai/dsh-tool-subagent",
    group: 5,
    decision: "不挂",
    workflowToggle: false,
    reason: "subagent / subagent_fork 工具；ADR-0014。",
  },
  {
    package: "@deepseek-ai/dsh-tool-subagent-control",
    group: 5,
    decision: "不挂",
    workflowToggle: false,
    reason: "send_message / interrupt_agent / list_agents；ADR-0014。",
  },
  {
    package: "@deepseek-ai/dsh-tool-subagent-report",
    group: 5,
    decision: "不挂",
    workflowToggle: false,
    reason: "子级 report 工具；ADR-0014。",
  },
  {
    package: "@deepseek-ai/dsh-workflow",
    group: 5,
    decision: "不挂",
    workflowToggle: false,
    reason:
      "上游的「workflow」是模型写的编排脚本；本项目的工作流是人画的图，两套并存没有单一答案（ADR-0014）。",
  },
  {
    package: "@deepseek-ai/dsh-workflow-worker-thread",
    group: 5,
    decision: "不挂",
    workflowToggle: false,
    reason: "随 workflow 一起不挂。",
  },
  {
    package: "@deepseek-ai/dsh-tool-workflow",
    group: 5,
    decision: "不挂",
    workflowToggle: false,
    reason: "随 workflow 一起不挂。",
  },
  {
    package: "@deepseek-ai/dsh-tool-ralph",
    group: 5,
    decision: "不挂",
    workflowToggle: false,
    reason: "全新 agent 的 Ralph 循环：本项目的循环是图上的回边与轮次（ADR-0009）。",
  },
  {
    package: "@deepseek-ai/dsh-goal",
    group: 5,
    decision: "不挂",
    workflowToggle: false,
    reason: "同会话持久目标与 Goal Round：与本项目的「轮次」是两套循环词汇，且需要人来 resume。",
  },
  {
    package: "@deepseek-ai/dsh-goal-round-driver",
    group: 5,
    decision: "不挂",
    workflowToggle: false,
    reason: "随 goal 一起不挂。",
  },
  {
    package: "@deepseek-ai/dsh-tool-goal",
    group: 5,
    decision: "不挂",
    workflowToggle: false,
    reason: "随 goal 一起不挂。",
  },
  {
    package: "@deepseek-ai/dsh-jobs",
    group: 5,
    decision: "不挂",
    workflowToggle: false,
    reason: "后台作业注册表：Action 是有界前台任务，后台作业只会让模型用步数轮询。",
  },
  {
    package: "@deepseek-ai/dsh-jobs-local",
    group: 5,
    decision: "不挂",
    workflowToggle: false,
    reason: "随 jobs 一起不挂。",
  },
  {
    package: "@deepseek-ai/dsh-tool-jobs",
    group: 5,
    decision: "不挂",
    workflowToggle: false,
    reason: "job_* 工具；随 jobs 一起不挂。tool-bash 因此关掉 run_in_background。",
  },
  {
    package: "@deepseek-ai/dsh-schedule",
    group: 5,
    decision: "不挂",
    workflowToggle: false,
    reason: "会话内的定时提醒；运行没有等待某个时刻的语义，调度归外部调用方。",
  },
  {
    package: "@deepseek-ai/dsh-experimental-agent-team",
    group: 5,
    decision: "不挂",
    workflowToggle: false,
    reason: "实验性 Agent Teams；不在上游任何一层 patch 里，private 包也不进闭包。",
  },
  {
    package: "@deepseek-ai/dsh-experimental-tool-agent-team",
    group: 5,
    decision: "不挂",
    workflowToggle: false,
    reason: "随 agent-team 一起不挂。",
  },

  // ───────────────────────── 组 6：面向人的交互 ─────────────────────────
  {
    package: "@deepseek-ai/dsh-user-questions",
    group: 6,
    decision: "不挂",
    workflowToggle: false,
    reason:
      "向人提问的 seam；运行中没有人：只挂 seam 时 ask() 立即抛 NO_PROVIDER，挂了桥接 provider 则挂到墙钟超时，两种都不能要。",
  },
  {
    package: "@deepseek-ai/dsh-tool-ask-user",
    group: 6,
    decision: "不挂",
    workflowToggle: false,
    reason: "ask_user_question 工具；随 user-questions 一起不挂。",
  },
  {
    package: "@deepseek-ai/dsh-plan-mode",
    group: 6,
    decision: "不挂",
    workflowToggle: false,
    reason: "需要人评审计划才能退出；无人值守。",
  },
  {
    package: "@deepseek-ai/dsh-permission-presets",
    group: 6,
    decision: "不挂",
    workflowToggle: false,
    reason: "面向用户的权限档位切换器；沙箱姿态是组合里钉死的全局决定。",
  },
  {
    package: "@deepseek-ai/dsh-commands",
    group: 6,
    decision: "不挂",
    workflowToggle: false,
    reason: "人的斜杠命令注册表；「Action 预载技能」由引擎代敲，不需要命令平面（ADR-0016）。",
  },
  {
    package: "@deepseek-ai/dsh-command-feedback",
    group: 6,
    decision: "不挂",
    workflowToggle: false,
    reason: "/feedback 命令；没有人。",
  },
  {
    package: "@deepseek-ai/dsh-command-goal",
    group: 6,
    decision: "不挂",
    workflowToggle: false,
    reason: "/goal 命令；goal 不挂。",
  },
  {
    package: "@deepseek-ai/dsh-command-compact",
    group: 6,
    decision: "不挂",
    workflowToggle: false,
    reason: "/compact 命令；自动压缩已挂，人的手动触发无人可按。",
  },
  {
    package: "@deepseek-ai/dsh-session-title",
    group: 6,
    decision: "不挂",
    workflowToggle: false,
    reason: "会话标题服务；节点名就是标题。",
  },
  {
    package: "@deepseek-ai/dsh-session-title-first-prompt-llm",
    group: 6,
    decision: "不挂",
    workflowToggle: false,
    reason: "每个会话多一次付费模型调用只为起标题。",
  },
  {
    package: "@deepseek-ai/dsh-session-title-all-prompts-llm",
    group: 6,
    decision: "不挂",
    workflowToggle: false,
    reason: "同上。",
  },
  {
    package: "@deepseek-ai/dsh-session-title-llm",
    group: 6,
    decision: "不挂",
    workflowToggle: false,
    reason: "标题 provider 的共享策略；随 session-title 一起不挂。",
  },
  {
    package: "@deepseek-ai/dsh-authorization",
    group: 6,
    decision: "不挂",
    workflowToggle: false,
    reason: "经对话向人索取凭据的 seam；凭据只以引用名进入（ADR-0006）。",
  },
  {
    package: "@deepseek-ai/dsh-skill-badge",
    group: 6,
    decision: "不挂",
    workflowToggle: false,
    reason: "上游自带的 badge 技能；上游 base 也禁用。",
  },

  // ───────────────────────── 组 7：宿主与界面 ─────────────────────────
  {
    package: "@deepseek-ai/dsh-client-*",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason: "浏览器半边四十余个包（ui-*、connection、runtime、web）：网页 UI 不影响 agent 运行。",
  },
  {
    package: "@deepseek-ai/dsh-host-*",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason:
      "webserver / frontend-static / apiproxy / plugin-inventory / directory-picker：本项目的宿主是 Next 进程。",
  },
  {
    package: "@deepseek-ai/dsh-web-app",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason: "浏览器界面 bundle；参照用。",
  },
  {
    package: "@deepseek-ai/dsh-headless",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason: "一次性运行器 bundle：我们不叠它，但它是体验基线（ADR-0013）。",
  },
  {
    package: "@deepseek-ai/dsh-base",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason: "核心 bundle：不叠，逐行审（ADR-0013）。",
  },
  {
    package: "@deepseek-ai/dsh-api-gateway",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason: "Typert Remote 分发器；服务浏览器客户端。",
  },
  {
    package: "@deepseek-ai/dsh-api-remotes",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason: "Remote BFF 组装；随 api-gateway 一起不挂。",
  },
  {
    package: "@deepseek-ai/dsh-typert-*",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason: "registry / loader / generator / protocol：生成的远程反射，只为宿主 RPC 服务。",
  },
  {
    package: "@deepseek-ai/dsh-storage",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason:
      "KV 存储枢纽（storage-json / storage-sqlite / storage-domain）；本项目的状态在 SQLite 与运行目录。",
  },
  {
    package: "@deepseek-ai/dsh-workspace",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason: "宿主的工作区实体登记；本项目的「工作区」是运行目录，由 Next 侧管理。",
  },
  {
    package: "@deepseek-ai/dsh-settings",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason: "用户设置 seam；本项目的设置是单行 JSON 文档，运行受理时冻结进组合。",
  },
  {
    package: "@deepseek-ai/dsh-settings-file",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason: "settings.yaml 热加载；每次运行自己起进程，没有热加载的对象。",
  },
  {
    package: "@deepseek-ai/dsh-agent-default-model",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason: "入口点共享的默认模型；本项目每个会话经 RPC 显式给出 provider/model。",
  },
  {
    package: "@deepseek-ai/dsh-cmdline",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason: "CLI 参数交接；runner 只取 argv 里的组合路径。",
  },
  {
    package: "@deepseek-ai/cordis-plugin-hmr",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason: "插件热替换；每运行一个短命进程，没有热替换的对象。",
  },
  {
    package: "@deepseek-ai/cordis-plugin-logger-console",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason:
      "stdout logger：stdout 是 RPC 协议帧，挂了整条协议就坏。harness stderr 写 logs/harness.stderr.log。",
  },
  {
    package: "@deepseek-ai/dsh-cordis-host-runner",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason:
      "模型动态挂载插件的 vm 沙箱（tool-cordis 家族）：让模型改运行时与「运行快照冻结定义」冲突。",
  },
  {
    package: "@deepseek-ai/dsh-tool-cordis",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason: "自指的 cordis 工具集；随 cordis-host-runner 一起不挂。",
  },
  {
    package: "@deepseek-ai/dsh-cordis-client-runner",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason: "模型动态挂载插件的浏览器半边；随 cordis-host-runner 一起不挂。",
  },
  {
    package: "@deepseek-ai/dsh-brand",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason: "Branded 类型原语；库。",
  },
  {
    package: "@deepseek-ai/dsh-native-command",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason: "宿主原生命令的无 shell 执行；目录选择器等宿主集成用。",
  },
  {
    package: "@deepseek-ai/dsh-*-demo / test-support",
    group: 7,
    decision: "不挂",
    workflowToggle: false,
    reason:
      "examples 与 test-support 家族（acp-demo、agent-spine-demo、jsonrpc-demo、llm-replay、llm-mock-server、loader-smoke…）：上游开发用。",
  },

  // ───────────────────────── 组 8：遥测与身份 ─────────────────────────
  {
    package: "@deepseek-ai/dsh-session-telemetry",
    group: 8,
    decision: "不挂",
    workflowToggle: false,
    reason: "会话遥测 seam；运行内容不出本机。",
  },
  {
    package: "@deepseek-ai/dsh-session-telemetry-otel",
    group: 8,
    decision: "不挂",
    workflowToggle: false,
    reason: "上游 base 默认挂、指向 deepseeksvc.com、靠环境变量关；我们根本不挂，不存在误开。",
  },
  {
    package: "@deepseek-ai/dsh-anonymous-user-id",
    group: 8,
    decision: "不挂",
    workflowToggle: false,
    reason:
      "匿名身份库：它是 llm-deepseek 的依赖、随每次模型请求作请求头发出，与遥测开关无关；home 钉在运行目录内，每次运行因此是新身份。作为插件行不挂。",
  },
  {
    package: "@deepseek-ai/dsh-message-feedback",
    group: 8,
    decision: "不挂",
    workflowToggle: false,
    reason: "逐消息点赞与备注；没有人。",
  },

  // ───────────────────────── 组 9：同一 seam 的替代 provider ─────────────────────────
  {
    package: "@deepseek-ai/dsh-llm-pi-ai",
    group: 9,
    decision: "备选",
    workflowToggle: false,
    reason:
      "OpenAI 兼容网关的路径（ADR-0006 提到的那条）：挂它并给 provider 配置即得新路由，需要同时在 seed 的 models 表加行。",
  },
  {
    package: "@deepseek-ai/dsh-bash-local",
    group: 9,
    decision: "备选",
    workflowToggle: false,
    reason: "不围栏的 bash 执行器；与 bash-sandbox 注册同一个 bash 服务，二选一。",
  },
  {
    package: "@deepseek-ai/dsh-fs-local",
    group: 9,
    decision: "备选",
    workflowToggle: false,
    reason: "不围栏的 fs provider；与 fs-sandbox 并挂会重复注册 ctx.fs 而加载失败。",
  },
  {
    package: "@deepseek-ai/dsh-pwsh-*",
    group: 9,
    decision: "备选",
    workflowToggle: false,
    reason:
      "Windows 的 PowerShell 执行器家族（pwsh-local / pwsh-sandbox / tool-pwsh / tool-pwsh-persistent）；本项目只跑 macOS。",
  },
  {
    package: "@deepseek-ai/dsh-sandbox-windows-acl",
    group: 9,
    decision: "备选",
    workflowToggle: false,
    reason: "Windows 受限令牌围栏；sandbox-local 在 win32 上的链路。",
  },
  {
    package: "@deepseek-ai/dsh-session-persistence-sqlite",
    group: 9,
    decision: "备选",
    workflowToggle: false,
    reason: "SQLite 持久化；JSONL 的可读性对运行目录更重要。",
  },
  {
    package: "@deepseek-ai/dsh-session-query-sqlite",
    group: 9,
    decision: "备选",
    workflowToggle: false,
    reason: "FTS5 检索后端；随 session-query 一起不挂。",
  },
  {
    package: "@deepseek-ai/dsh-storage-json",
    group: 9,
    decision: "备选",
    workflowToggle: false,
    reason: "storage 枢纽的 JSON 后端；随 storage 一起不挂。",
  },
  {
    package: "@deepseek-ai/dsh-storage-sqlite",
    group: 9,
    decision: "备选",
    workflowToggle: false,
    reason: "storage 枢纽的 SQLite 后端；随 storage 一起不挂。",
  },
  {
    package: "@deepseek-ai/dsh-e2b",
    group: 9,
    decision: "备选",
    workflowToggle: false,
    reason:
      "E2B 远程沙箱（e2b / fs-e2b / subprocess-e2b）：把 fs 与 subprocess 指向远程即整套搬走；将来要隔离到云端时走这里。",
  },
  {
    package: "@deepseek-ai/dsh-web-search-exa",
    group: 9,
    decision: "备选",
    workflowToggle: false,
    reason: "Exa 搜索 provider；需要另一把凭据。",
  },
  {
    package: "@deepseek-ai/dsh-web-search-perplexity",
    group: 9,
    decision: "备选",
    workflowToggle: false,
    reason: "Perplexity 搜索 provider；需要另一把凭据。",
  },
  {
    package: "@deepseek-ai/dsh-code-runtime-python",
    group: 9,
    decision: "备选",
    workflowToggle: false,
    reason: "Code Mode 的 Python 协议包：rc.2 只导出协议词汇、没有插件入口；Code Mode 本身也不挂。",
  },
  {
    package: "@deepseek-ai/dsh-lsp-stdio",
    group: 9,
    decision: "备选",
    workflowToggle: false,
    reason: "stdio 语言服务器 provider；lsp 不挂。",
  },
  {
    package: "@deepseek-ai/dsh-subagent-acp / claude-code / codex / dsh-sdk",
    group: 9,
    decision: "备选",
    workflowToggle: false,
    reason: "进程外 subagent provider 家族；subagent 不挂（ADR-0014）。",
  },
  {
    package: "@deepseek-ai/dsh-hooks-* / hook-protocol",
    group: 9,
    decision: "备选",
    workflowToggle: false,
    reason:
      "把 Claude Code / Codex 的 hooks.json 桥到 dsh 拦截点；本项目的拦截点由 ontoflow-rpc 直接注册。",
  },
  {
    package: "@deepseek-ai/dsh-acp",
    group: 9,
    decision: "备选",
    workflowToggle: false,
    reason:
      "Agent Client Protocol 的 stdio 服务端；本项目的线协议是 ontoflow-rpc（上游 SDK 协议的超集）。",
  },
  {
    package: "@deepseek-ai/dsh-sdk-jsonrpc-server",
    group: 9,
    decision: "备选",
    workflowToggle: false,
    reason:
      "上游的 stdio JSON-RPC 服务端：ontoflow-rpc 的 fork 原型；缺 cancel/close/output 与按会话组合。",
  },
  {
    package: "@deepseek-ai/dsh-sdk-client",
    group: 9,
    decision: "备选",
    workflowToggle: false,
    reason: "上游 TS 客户端；Next 侧的 RunProcess 直接用 sdk-protocol 的传输。",
  },

  // ───────────────────────── 组 10：本项目自有 ─────────────────────────
  {
    package: "src/server/harness/rpc",
    group: 10,
    decision: "自有",
    entry: { id: "ontoflow-rpc" },
    workflowToggle: false,
    reason: "运行子进程的 JSON-RPC 服务端插件；以绝对路径进组合。",
    customization: {
      kind: "fork",
      what: "补 session/cancel、session/close、session/output；prompt 懒创建时接受 agentOptions 与 nodeOptions；不转发 subagent 通知。",
      why: "引擎要按节点取消、关闭并读回结构化结果；上游协议没有逐会话关闭与取消。",
      upstream: { path: "packages/sdk/server/src/server.ts", version: V },
    },
  },
  {
    package: "src/server/harness/rpc/structured.ts",
    group: 10,
    decision: "自有",
    workflowToggle: false,
    reason:
      "会话作用域的 structured_output 工具、提示段、终态守卫与两阶段提交：数据面的实现（ADR-0008）。",
    customization: {
      kind: "fork",
      what: "抄上游进程内 subagent 驱动器的同一机制，去掉 subagent 依赖。",
      why: "那个包的运行时入口经 peer 链拖入 subagent/sandbox/jobs 等本项目不挂的能力。",
      upstream: {
        path: "packages/subagent/subagent-in-process-driver/src/structured.ts",
        version: V,
      },
    },
  },
  {
    package: "src/server/harness/rpc/server.ts#composeNodeScope",
    group: 10,
    decision: "自有",
    workflowToggle: false,
    reason:
      "Action 会话的创建期组合：步数上限、思考强度、工具收窄，全在会话 scope 上（ADR-0015）。",
    customization: {
      kind: "包装",
      what: "agent/pre-step 拒绝超步；agent/request waterfall 无条件盖 reasoningEffort；tools.restrict + guard 双层 deny。",
      why: "上游 agent-loop 无步数上限、AgentOptions 无思考强度、晚注册的工具会击穿创建期快照。",
    },
  },
  {
    package: "<run>/plugins/tool-*.ts",
    group: 10,
    decision: "自有",
    entry: { idPrefix: "tool-" },
    workflowToggle: false,
    reason:
      "工作流 Tool 集物化的 cordis 插件（平台包装 + execute 模块），按运行生成、以绝对路径进组合；每个 Action 再按可见子集收窄。",
  },
  {
    package: "src/server/harness/tool-plugin.ts",
    group: 10,
    decision: "自有",
    workflowToggle: false,
    reason:
      "Tool 契约的 cordis 包装生成器（ADR-0017）：作者只写 execute 模块，注册形状与 ctx.run() 围栏归平台。",
    customization: {
      kind: "包装",
      what: "按契约生成 tool-<id>.ts：ctx.tools.register 的 name/parameters/output/timeoutMs 与 render，execute 组装 ToolContext（路径、env 白名单、sandboxPolicy + shell 的 run）。",
      why: "上游 ToolDefinition 的注册形状（output 必填、render(args, value)、JSON Schema 子集）漂移时只改这一处，库里的 Tool 不动。",
      upstream: { path: "packages/core/tools/src/index.ts", version: V },
    },
  },
  {
    package: "src/server/harness/composition.ts",
    group: 10,
    decision: "自有",
    workflowToggle: false,
    reason:
      "每运行组合的生成器：相当于上游的 profile + bundle patch，只是平铺、程序化（ADR-0013）。",
  },
  {
    package: "src/server/harness/runner.ts",
    group: 10,
    decision: "自有",
    workflowToggle: false,
    reason: "子进程入口：相当于 dsh-headless/startup，只取 argv 里的组合路径、不读 .env。",
  },
];

/** 组合 entry id 是否被目录里某一行声明（固定 id 或前缀）。 */
export function catalogRowForEntryId(entryId: string): PluginCatalogRow | undefined {
  // 先精确匹配固定 id，再退到前缀行：否则一个没进目录的固定 `tool-*` / `mcp-*` 行会被 Tool 插件
  // 或 MCP 的前缀行吸收，三方一致测试对上游 dsh-tool-* 整族失效。
  const exact = PLUGIN_CATALOG.find(
    (row) => row.entry !== undefined && "id" in row.entry && row.entry.id === entryId,
  );
  if (exact) return exact;
  return PLUGIN_CATALOG.find(
    (row) =>
      row.entry !== undefined && "idPrefix" in row.entry && entryId.startsWith(row.entry.idPrefix),
  );
}

/** 目录里应当出现在默认组合的固定行。 */
export function defaultMountedEntryIds(): string[] {
  return PLUGIN_CATALOG.flatMap((row) =>
    row.entry !== undefined &&
    "id" in row.entry &&
    (row.decision === "必挂" || row.decision === "挂" || row.decision === "自有") &&
    row.mountedByDefault !== false
      ? [row.entry.id]
      : [],
  );
}

/** 目录里由开关决定挂载的固定行。 */
export function toggleMountedEntryIds(): string[] {
  return PLUGIN_CATALOG.flatMap((row) =>
    row.entry !== undefined && "id" in row.entry && row.mountedByDefault === false
      ? [row.entry.id]
      : [],
  );
}
