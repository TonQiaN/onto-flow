# 09 同一 seam 的替代 provider

> 默认方向：不挂，记为备选。参照：上游 headless 会话（ADR-0013）。上游版本见 README。

上游把每个能力做成 seam 加若干 provider：`ctx.shell` 有 bash-local 与 bash-sandbox，`ctx.fs` 有 fs-local 与 fs-sandbox，`SessionPersistence` 有 JSONL 与 SQLite，`ctx.web` 有 DeepSeek、Exa、Perplexity 三家搜索，`ctx.subagents` 有进程内与四种进程外后端，线协议有 ACP 与 SDK JSON-RPC 两种服务端。这组收的是「同一 seam 里本项目没选的那一个」：与已挂行注册同一个服务、二选一的（bash-local、fs-local、session-persistence-sqlite）；本项目根本没挂那个 seam、于是 provider 无处注册的（session-query-sqlite、storage 两个后端、code-runtime-python、lsp-stdio、四个进程外 subagent、hooks 桥接）；需要另一把凭据、另一个平台或另一台机器的（Exa、Perplexity、pwsh 家族、Windows ACL 围栏、E2B）；以及与本项目自有的 `ontoflow-rpc` 争同一条 stdio 的宿主协议（ACP、上游 SDK 服务端与客户端）。判据只有一条：它不是「不要这个能力」（那是组 5–8 的事），而是「这个能力选了另一个实现」。

这组的十九行全部「备选」、没有一行进组合、没有一行可按工作流切换。备选与不挂的差别在于用途：不挂的行是论证过不要，备选的行是换实现时从这里找——每一节的「理由」都写到「换上它要动什么」为止。与 headless 基线的关系分两类：base 本来就不挂的行（多数），本项目与基线一致、不需要额外理由；base 挂了而本项目换掉或不挂的行只有三处——`llm-pi-ai`（base 休眠挂载）、`session-query-sqlite`（base 以 `openAt: never` 挂着撑 seam）、pwsh 两行（base 按 win32 互斥启用）——各自的差异写在该行里。

一个横跨全组的事实：这些包里只有三个在本项目的 npm 闭包里，而且都是作为库进来的——`dsh-bash-local` 与 `dsh-fs-local` 是 `bash-sandbox`、`fs-sandbox` 各自继承的基类，`package.json` 直接钉版；`dsh-sandbox-windows-acl` 是 `sandbox-local` 的依赖。其余十六行今天不在 `node_modules` 里，换上任何一行都要先按 `0.1.1-rc.2` 钉版加依赖，再走 README「怎么加、删、改一行」的四步。

## 逐行

### `@deepseek-ai/dsh-llm-pi-ai`
- **seam 角色**：Service Provider（向 `ctx.llm` 注册路由的多提供方适配器，基于 `@earendil-works/pi-ai`）
- **决定**：备选
- **它给会话带来什么**：所选 catalog 模型收到 `GenerateOptions.system`、历史、工具与 pi-ai 通用流式 API 支持的采样字段；pi-ai 事件变为 harness 的推理、文本、工具调用、usage 与 finish 分片，工具参数以原始 JSON 字符串交回；推理 token 折叠进输出 usage，没有独立计数。
- **理由**：上游 base 挂它且不带配置——「休眠」姿态：零路由、模型选择器不多一条，直到 `$DSH_HOME/settings.yaml` 的 `llm-pi-ai:` 分节给出 provider profile，那正是 Web 模型页写的东西；headless 会话没有人写 settings，所以它在基线里同样是空的。本项目不挂 `settings-file`（组 7），按上游 README，没有 settings 服务时适配器只由 entry 配置驱动——挂它就得把路由写进 `composition.ts`，这与本项目「组合是显式平铺清单」（ADR-0013）反而更合。今天不挂的理由只有一个：没有第二条路由。`models` 表只有 `deepseek-official` 下的三行，`llm-deepseek` 是唯一路由（组 1）。这一行是 ADR-0006 提到的那条路径——OpenAI 兼容网关、自建服务、比已安装 catalog 更新的提供方，「都属于配置而非改代码」：手工声明的路由要 `api`、`baseURL` 与非空 `models`，pi-ai 认不出的端点会被当成 OpenAI 本身发请求（`developer` 角色、`max_completion_tokens`、裸 `reasoning_effort`），多数网关至少拒绝其中一项，所以 `compat` 的 `thinkingFormat` / `supportsDeveloperRole` / `maxTokensField` 要按网关逐个写。两个适配器可以并存：向 `ctx.llm` 的注册是原子的，只有与另一适配器已有的路由同名才加载失败，而 `llm-deepseek` 注册的路由名固定是 `deepseek-official`，与 pi-ai 目录里的 `deepseek` 本就不同名（`entries.ts` 的 `DEEPSEEK_PROVIDER` 注释记着这一区分），所以将来挂它是「加一条路由」而不是「换掉 llm-deepseek」。凭据形状与本项目一致：`apiKeyEnv` 是按请求解析的引用，值不进文件；已配置却解析不出值以 `MISSING_CREDENTIAL` 失败而不是拿环境里恰好有的别的密钥去认证。一处要提防：profile 的 `headers` 是纯字符串字典，放进去的 `Authorization` 会被脱敏后的 `describe()` 原样返回——本项目设置页拒绝形似凭据的 MCP `env` 键，是同一类规则，挂它时 `headers` 里不得放凭据。挂之前要动本项目三条契约：其一，计费——`pricing.ts` 只有 DeepSeek 官方价目，未知 provider/model 计 0，运行列表的用量汇总会全是 0，新路由先加价目；pi-ai 把推理 token 折叠进输出 usage，与本项目「outputTokens 已含 reasoning、不再单独计」的规则一致，不会重复计。其二，思考强度——`composeNodeScope` 在 `agent/request` 上无条件盖 `reasoningEffort`（本项目档位 off/low/high/max），而 pi-ai 对不在该模型能力里的档位在网络 I/O 之前就以 `UNSUPPORTED_REASONING_EFFORT` 让请求失败、不自动调整；所以 pi-ai 路由上的每个模型都得在 `reasoningEfforts` 里把本项目会发的档位声明出来，未声明的档位一律是「不支持」而不是交给 pi-ai 的默认规则。其三，seed——没有任何路由写 `models`，新路由的每个模型都要在 `scripts/seed.ts` 里 `upsertModel`（providerId 就是路由名），同时 `runCompositionEntries` 加这一行。其它已查实的事实：每条 profile 可设 `retryPolicy`，省略时 normal 模式重试五次，由本项目已挂的 `llm-retry`（组 1）在 agent 的失败步骤上执行，pi-ai SDK 自身重试固定为零；`supportedProtocols()` 刻意窄于 pi-ai——Bedrock、Vertex、Azure、Codex 因为无法用密钥加端点完整描述而不提供；它以作用域方式依赖 `authorization`（组 6 不挂），seam 缺席时静默不注册登录 flow，走 `apiKeyEnv` 不需要 flow；pi-ai 安装多个提供方 SDK，依赖体量隔离在这个可选包里。
- **可按工作流切换**：否（模型路由归全局设置与 Action 选的模型，不是插件开关）

### `@deepseek-ai/dsh-bash-local`
- **seam 角色**：Service Provider（`ctx.shell` 执行器，基于 `ctx.subprocess`）
- **决定**：备选
- **它给会话带来什么**：经 `dsh-tool-bash` 间接——有界的 stdout/stderr 尾部、后台进程增量、spill 文件路径与基础设施失败；`bash` 工具不公布 `sandbox_permissions` 与 `justification`，那两个字段只在执行器报告 `sandboxMode` 能力时才出现。
- **理由**：一个宿主只组装一个 `ctx.shell` 提供方——上游 shell README 明言同时挂载两者会因服务重复注册在加载期失败，所以它与本项目挂的 `bash-sandbox`（组 2，ADR-0011）是二选一。上游 base 挂的也是 `bash-sandbox`（`timeoutMs: 60000`，win32 禁用），不挂 bash-local，本项目与 headless 基线一致。它在闭包里，但作为库：`bash-sandbox` 的进程机制（spawn、进程组终止、输出收集与 spill、后台句柄、凭据清理）逐字继承自它，`package.json` 直接钉版。不换它的理由是它「自身不提供隔离：始终以 harness 进程的权限运行命令」。本项目的运行无人值守，审批策略固定 `never`（组 2），命令一旦裸跑就没有任何东西拦得住它写出工作区；ADR-0011 把 bash 放进每个 Action 会话的前提正是 Seatbelt 围栏在、runner 不可用时 fail-closed 拒绝执行而不是静默无约束运行。会想换的情形只有两种：Apple 真的移除了 `sandbox-exec`（上游功能探测会让执行被拒绝），或者要跑在没有 runner 的环境——两种情形的正确做法都是换 runner（`sandbox-local` 的 `runnerCommand`）或换平台围栏，不是退回裸跑。换上它时：entry id 仍是 `bash`，config 同形——`cwd`（默认 `process.cwd()`）、`timeoutMs` 120000、`maxTimeoutMs` 600000、`maxOutputBytes` 64000、`maxSpillBytes` 67108864、`graceMs` 3000——本项目钉进工作区的 `cwd` 与 120000 的 `timeoutMs` 能原样带过去；`sandbox` 与 `sandbox-policy` 两行对 bash 失效，但 `fs-sandbox` 仍需要策略行，不能顺手删；`tool-bash` 会自动不再公布升级字段。
- **可按工作流切换**：否

### `@deepseek-ai/dsh-fs-local`
- **seam 角色**：Service Provider（`ctx.fs` 的本地实现，十二个 `FileSystem` 原语）
- **决定**：备选
- **它给会话带来什么**：经 `dsh-tool-fs` 间接——带行窗口的 UTF-8 内容、变更确认、提供方消息原文；没有 `FS_SANDBOX_DENIED` 拒绝，也就没有 `[sandbox: file access denied under <mode> mode]` 标记。
- **理由**：`fs-sandbox` 的 `SandboxedFileSystem` 扩展 `LocalFileSystem` 并注册为同一个 `ctx.fs`，上游写法是「加载它来替代 dsh-fs-local」，并挂即重复注册。上游 base 挂的是 `fs-sandbox`（不带配置，`cwd` 默认 `process.cwd()`），本项目一致。fs-local 在闭包里是 fs-sandbox 的基类，逐字提供解析、stat、读取、列出、原子写入与编辑临界区；fs-sandbox 只给 `writeText`/`editText` 加按调用的模式围栏，读在两者里都直通，所以换不换对读没有任何差别。不换的理由在写：fs-local 的 `config.cwd` 「不是沙箱：它是解析默认值，绝对路径和 `..` 可以逃逸」。本项目的工作区是协作范围而不是安全边界（ADR-0011），但 `workspace-write` 的策略围栏是 Action 的写入只落在工作区与临时根的机械保证，产物契约（ADR-0008：声明的产物必须在磁盘上）靠它保住「写出去的文件就在运行目录里」；围栏与 bash runner 的可写集合由同一个 `writableRoots` 派生，两个能力族不会圈到不同的根。换上它时：entry id `fs-sandbox` 改 `fs-local`，config 同形（`cwd`、`diffBasisMaxBytes` 默认 10 MiB），无其它差异；`sandbox-policy` 仍被 `bash-sandbox` 需要。
- **可按工作流切换**：否

### `@deepseek-ai/dsh-pwsh-*`
- **seam 角色**：家族——`pwsh-local` 与 `pwsh-sandbox` 是 `ctx.shell` 的 Service Provider（bash-local / bash-sandbox 的 Windows 孪生）；`tool-pwsh` 是 Consumer（注入 `tools`、`bash`、`systemPrompt`、`bashEnv`，注册 `pwsh` 工具）；`tool-pwsh-persistent` 是 `ctx.terminals` 之上的 Consumer（持久 shell，`tool-bash-persistent` 的对应物）
- **决定**：备选（四行）
- **它给会话带来什么**：`pwsh` 工具——PowerShell 方言，原生 `C:\` 路径与 `$env:` 变量，schema 与 `bash` 逐调用对齐（`workdir`、`run_in_background`、`sandbox_permissions`）；另贡献 `tool:pwsh` 提示段（order 105）：非零退出以 `[exit code: N]` 报告，Windows 上被杀进程以无 signal 的 exit 1 结算。
- **理由**：上游 base 同时列出 bash 与 pwsh 两族，按 `process.platform === 'win32'` 互斥禁用：`bash-sandbox`、`tool-bash` 在 win32 禁用，`pwsh-sandbox`、`tool-pwsh` 在非 win32 禁用；两族共用一个 `bash` settings 命名空间，因为一个宿主只组装一个 `ctx.shell`。base 不挂 `pwsh-local`（与 bash 一侧同理，挂的是 sandbox 版），也不挂 `tool-pwsh-persistent`（依赖组 2 不挂的 `terminal` seam）。本项目只跑 macOS——Poppler 与 Seatbelt 都是 macOS 事实——而 `composition.ts` 是平铺清单、没有平台条件行（ADR-0013），所以不挂 pwsh 不是「禁用」而是「不存在」。将来若要跑 Windows，是换行不是加行：`subprocess` 与 `shell-env` 不动，`bash` 行换成 `pwsh-sandbox`，`tool-bash` 换成 `tool-pwsh`，`sandbox` 链在 win32 上自动解析到下一行的 ACL runner；代价不在组合而在内容——上游明言「没有方言翻译」，Action 规则、Skill、Tool 里所有 bash 语法都要改写成 PowerShell，Poppler 三件套也得有 Windows 版。pwsh 侧还有本项目会撞上的两条：受限模式拒绝 named-pipe 打开，受限命令内的管道 stdio spawn 以 EPERM 失败；`read-only` 下 pwsh 以 ConstrainedLanguage 启动（`Add-Type`、`[System.IO.*]::` 全失败），只有 `workspace-write` 的私有临时目录能让探针完成——本项目恰好是 `workspace-write`。
- **可按工作流切换**：否

### `@deepseek-ai/dsh-sandbox-windows-acl`
- **seam 角色**：runner 库——`sandbox-local` 在 win32 上选用的 argv 前缀包装（`./runner` 入口），与 bwrap / landlock-run / sandbox-exec 同架构；不是组合行，`sandbox-local` 把它列为依赖，随之进入本项目闭包
- **决定**：备选
- **它给会话带来什么**：无直接影响；经 `bash-sandbox` / `pwsh-sandbox` 及其工具间接——被拒绝的写以 `Access to the path '...' is denied.` 这类 stderr 分类为 `sandbox.denied`，每次受限运行报告 `enforcement: 'partial'`。
- **理由**：本项目在 macOS 上永远走 Seatbelt，这一级不会被选中；runner 选择按平台探测、在提供方生命周期内缓存，既不需要也不能配置，所以它的「备选」只在换平台时成立。单列它是因为它改变的是围栏语义而不是 API：`WRITE_RESTRICTED` 受限令牌只交叉检查写访问，读、网络、进程可见性不受限（这一点与 Seatbelt「只限文件写」一致）；但 Everyone 必须留在 restricting 列表里（否则 DLL 初始化与 CNG 崩溃），于是 DACL 向 Everyone 授写的外部对象在两种模式下都可写，NTFS 硬链接又是文件对象别名——两者合起来就是它只报 `partial` 的原因，工具层会把这个较弱的边界如实渲染给模型。与本项目每运行一工作区（ADR-0007）直接相撞的是它的授权模型：工作区写 SID 由规范工作区路径确定性派生，工作区根目录的 ACE **常驻**、绝不撤销（它就是跨实例的复用缓存），首次授权是急切的全树传播，大工作区以分钟计；本项目每次运行都是新目录，等于每次运行都付一次首次授权、都在磁盘上留一条常驻 ACE，运行目录被清理后 ACE 随目录消失，但「改名会留下失效 ACE」。真要跑 Windows 时先量这一项。其余边界：受限孙进程的管道 stdio 以 EPERM 失败（libuv 用 named pipe，默认 SD 模板不认 restricting SID），`whoami` 与令牌检查 cmdlet 在受限令牌下报错是噪音不是故障；被授权目录必须由调用者拥有；环境临时根绝不隐式授权，runner 会把 TMP/TEMP 改写成按会话私有的目录——与本项目把 `TMPDIR` 钉到 `<run>/tmp` 是同一目的的两种实现。
- **可按工作流切换**：否

### `@deepseek-ai/dsh-session-persistence-sqlite`
- **seam 角色**：Service Provider（`SessionPersistence`，`dsh-session-persistence` seam）
- **决定**：备选
- **它给会话带来什么**：无 SQLite 特有内容——恢复得到与 JSONL 相同的逻辑事件与派生消息，打包标签不进提示词、工具、回放或实时 `session/event`。
- **理由**：上游自己写明「随产品交付的组合均不选择它；部署方需显式挂载并提供数据库路径」，base 挂的是 `session-persistence-jsonl`（root `dshHomePath('sessions')`，默认 zstd 压缩、打包分片行）。本项目挂 jsonl 且 `compression: 'none'`（组 4），root 钉在 `<run>/sessions`。两者注册同一个 `SessionPersistence`，二选一。本项目要明文 JSONL 的理由在运行目录的用途上：`sessions/*.jsonl` 是 Agent 轨迹的权威源，运行详情按 runDir 直接读它，运行目录本身是调试证据。换成 SQLite 会同时失去三样东西：其一，逐会话可读文件——它「一个数据库存所有会话，`locate(meta)` 返回 `undefined`，不暴露逐会话原始产物」；其二，`DSH_SESSION_JSONL`——`tool-bash` 只在「活跃持久化后端定位到 JSONL」时才把它交给 shell；其三，每运行目录自包含——一个跨运行共享的库与「运行之间互不可见」（ADR-0007）相抵，要保持隔离就得每运行一个库文件，而它的收益（大 payload 的 zstd、来源序列 delta 编码、写后 200 ms 合并窗口）都是按长期累积的会话语料算的，在单运行规模上没有意义。运行期代价也不小：`DatabaseSync` 与 Zstandard 都阻塞事件循环；POSIX 上父目录与文件必须归当前用户、不得组或其他用户可写；schema 17 无迁移，旧 schema 与非空未版本化库一律拒绝。本项目已有一个 SQLite（`data/ontoflow.db`）承载运行元数据，再引一个会话库并不带来查询能力——检索 seam 不挂。换上它时：`path` 必填；`journalMode` 默认 `wal`、`busyTimeoutMs` 5000、`preparedSessionCacheSize` 5、`writeBatchMaxDelayMs` 200；轨迹投影要从读文件改成经这个提供方读库（外部 SQL 读取方必须理解物理打包标签，不能把每个 `events.type` 当逻辑事件）；`session-checkpoint-policy` 只要求有一个 `sessionPersistence`，后端不限。
- **可按工作流切换**：否

### `@deepseek-ai/dsh-session-query-sqlite`
- **seam 角色**：Service Provider（`ctx.sessionQuery`，SQLite FTS5 全文检索；从 Service Definition 继承精确读取、跟踪与过滤）
- **决定**：备选
- **它给会话带来什么**：无——可信搜索后端只向调用方返回命中，不注册提示词、schema、工具或消息。
- **理由**：上游 base 挂它，值是 `path: ':memory:'`、`openAt: never`，web-app 重述同样的值：这样挂是为了让 `ctx.sessionQuery` 上继承的精确读取、标题与谱系跟踪可用（会话导出、subagent-fork 的 Workspace 继承要它），搜索调用以 `SESSION_QUERY_SEARCH_DISABLED` 失败、`node:sqlite` 从不导入。本项目不挂 `session-query` seam（组 4：运行详情按 runDir 直接读 JSONL），它的三类消费者——会话导出（组 4）、subagent fork（组 5）、Web 侧栏搜索（组 7）——也全部不挂；seam 都没有，provider 无处注册，这一行随 seam 一起不挂。它是「派生索引」：可丢弃重建，绝不能指向 session-persistence 的库，每个索引路径在一个进程里只能归一个服务、不支持外部写入者或第二个进程——本项目并行运行各自一个子进程，若真要它，只能每运行一个索引，那正是没人会去搜的东西。将来若本站要跨运行全文搜 Agent 轨迹，正确落点是 Next 侧对已经在 SQLite 里的 `run_events` 建索引，而不是在每个运行子进程里各开一个 FTS。换上它时：`session-query` seam 一起挂；`path` 必填（`:memory:` 可）；`openAt` 默认 `startup`（激活时导入 `node:sqlite`，触发 Node 22 的 ExperimentalWarning；`first-search` 推迟到首次搜索）；`defaultLimit` 20、`maxLimit` 100、`snippetChars` 240、`readWindowMax` 50。
- **可按工作流切换**：否

### `@deepseek-ai/dsh-storage-json`、`@deepseek-ai/dsh-storage-sqlite`
- **seam 角色**：两者都是 `ctx.storage` 枢纽的后端（Service Provider，注册名 `json` / `sqlite`，唯一分面 `kv`）
- **决定**：备选（两行）
- **它给会话带来什么**：无——不贡献提示词、工具或 schema；在 `ctx.storage` 后面持久化非会话领域数据，只供宿主侧消费方。
- **理由**：base 不挂 storage 家族；web-app 挂 `storage` 加 `storage-json`（root `dshHomePath('storages')`）加 `storage-domain`（`backend: json`）；`storage-sqlite` 没有任何随产品交付的组合挂它。headless 会话没有 storage，本项目不挂 `storage` 枢纽（组 7）与基线一致。它服务的是 Web 宿主的领域记录——工作区记录、将来的会话伴随元数据——消费方 `storage-domain` 与 `workspace` 都是 Web 行；本项目的宿主状态在 `data/ontoflow.db` 与运行目录。两个后端可以并排挂载，为谁服务由消费方自己的路由表决定而不是枢纽的全局选择，所以「换后端」在上游是改领域层的 `backend`。记为备选的意义只有一个：将来若 Tool 插件或 `ontoflow-rpc` 要在子进程内存非会话状态，`ctx.storage` 是上游给的 seam；但更合理的落点仍是运行目录（每运行隔离）或 Next 侧的 SQLite，别为它把枢纽挂回来。换上时：json 的 `root` 与 sqlite 的 `path` 都必填、无默认（json 一侧上游注明 cwd 回退会让文件散落）；json 后端整文件原子替换、可读性优先、没有跨进程写锁；sqlite 后端每个写原语一条预处理语句、STRICT 表、没有忙等待重试、另一连接持写事务时立即拒绝。
- **可按工作流切换**：否

### `@deepseek-ai/dsh-e2b`
- **seam 角色**：家族——`dsh-e2b` 是 E2B 沙箱的共享生命周期所有者（`ctx.e2b`，钉 `e2b@2.29.1`）；`fs-e2b` 是 `ctx.fs` 的 Service Provider；`subprocess-e2b` 是 `ctx.subprocess` 的 Service Provider
- **决定**：备选
- **它给会话带来什么**：所有者无；两个 provider 经 `dsh-tool-fs` 与 `dsh-tool-bash` 间接——远程 UTF-8 内容、目录结果、变更确认、远程输出与退出事实、后台增量与 spill 路径。
- **理由**：目录一句话说的「把 fs 与 subprocess 指向远程即整套搬走」是上游原话的意思：先加载所有者，再用两个 provider 取代 `fs-local` 与 `subprocess-local`，现有的 Bash、PTY、LSP 消费方随之在共享远程沙箱执行，无需 E2B 专用的能力包。这是本项目将来要把执行隔离到云端时唯一现成的路径，值得记。今天不挂，因为它与本项目三条契约相抵。其一，工作区是产物的交换场所（ADR-0007、ADR-0008）：`fs-e2b` 「不提供宿主同步：本地文件既不会上传，也不会同步回本地」，把宿主路径当 `cwd` 只会在远程建一个拼写相同的空目录——输入物化（ADR-0012）落在本机工作区而远程 cwd 是空的，产物写在远程而引擎「声明的产物必须在磁盘上」的检查看不到它；要用它得先做上传与回传层，上游明言宿主工作区同步不在 POC 范围。其二，围栏：远程 `cwd` 「是解析约定，而不是包含边界」，网络按基础镜像策略；本项目的 `sandbox-policy` / `sandbox-local` / `bash-sandbox` 链是本机围栏，与远程无关——换到 E2B 后隔离由 E2B 提供，bash 执行器应换回 bash-local，Seatbelt 链整条退场。其三，凭据与账：`E2B_API_KEY` 是另一把凭据，只配置宿主 SDK 连接、绝不装进沙箱；沙箱寿命由 `timeoutMs` 控制、默认 5 分钟、超时即删，本项目节点墙钟远超它，得按运行配置。其它 POC 限制也要知道：状态短暂（无重连、pause、模板、卷、快照）；`subprocess-e2b` 在远程启动期 `pid` 为 `-1`，要求同步 PID 的消费方（ACP 子进程后端）不能用；E2B 的 `CommandHandle` 在宿主内存里保留完整命令输出，进程管理 seam 通常提供的宿主内存边界达不到；控制状态与沙箱用户同 UID，`0700` 挡不住并发的沙箱进程；E2B 不公开信号事实。换上时：`e2b` 行 `cwd`（默认 `/home/user/workspace`，必须是绝对 POSIX 路径）、`timeoutMs`（默认 300000）、`apiKey` 可省略读 `E2B_API_KEY`；`subprocess-e2b` 的 `pollMs` 默认 20（每 tick 一次控制面请求）；`fs-e2b` 无配置；两个 provider 必须在所有者之后加载、在它之前 dispose。
- **可按工作流切换**：否

### `@deepseek-ai/dsh-web-search-exa`、`@deepseek-ai/dsh-web-search-perplexity`
- **seam 角色**：两者都是 `ctx.web` 的 `WebSearchProvider`（Service Provider，`inject: ['web']`），与已挂的 `web-search-deepseek` 同 seam
- **决定**：备选（两行）
- **它给会话带来什么**：经 `dsh-tool-web` 间接。Exa 返回扁平结果，不返回生成答案——会话模型看到 URL、标题、首条 highlight 与发布日期；Perplexity 是一次独立的辅助模型请求（默认 `sonar`）以查询为唯一用户消息生成答案加引用——会话模型看到生成答案与结构化来源，或只含 URL 的引用。两者的错误文本固定（`Exa search request failed: <error>`、`Perplexity returned an unprocessable response body: <error>` 等）。
- **理由**：上游 base 只挂 DeepSeek 搜索（`web.searchProvider: deepseek-official`，`apiKeyEnv: DEEPSEEK_API_KEY`），两者都不在 base。本项目的搜索三件套默认关、可按工作流切换（组 2），provider 固定 DeepSeek；`web` seam 的 `searchProvider` 一次只选一个，换 provider 是改 `web` 行的 `searchProvider` 再挂对应 provider 行。不选它们的两个具体理由：其一，凭据形状——`web-search-deepseek` 有 `apiKeyEnv` 引用，每次搜索经 `ctx.credentials` 解析；Exa 与 Perplexity 的 config 只有 `apiKey` 字面值，省略时从启动环境读固定名 `EXA_API_KEY` / `PERPLEXITY_API_KEY`（`launchEnvironmentOf(ctx)`）。本项目凭据只以引用名进组合、值由 spawn 白名单注入，挂它们只能走「省略 `apiKey`、把固定名登记进全局设置的凭据引用」这一条路：`collectCredentialEnv` 按引用名从 Next 进程环境取值注入子进程，而 `launchEnvironmentOf(ctx)` 在没有启动环境快照时退回读子进程自己的 `process.env`（本项目的 runner 走上游 `boot()`，不装载 `launchEnvironment` 快照），所以固定名能被读到；引用名不可改，也没有 DeepSeek 那样的 `role('secret')` 脱敏声明。其二，账——DeepSeek 搜索已经是账外支出（组 2：用量不经 `llm/stream`，`node_usage` 收不到）；Perplexity 每次搜索是另一家模型的 token（`maxTokens` 默认 1024）、另一张账单，Exa 的请求同样不经 `llm/stream`，本站同样收不到。换上时：Exa 的 `baseURL` `https://api.exa.ai`、`searchType` `auto`、`highlightsPerResult` 1、`numResults` 未设（没有 highlight 的结果整个丢弃，返回可能少于请求数）；Perplexity 的 `baseURL` `https://api.perplexity.ai`、`model` `sonar`、`maxTokens` 1024、`searchRecency` 未设（协议没有结果数控制，`maxResults` 由 seam 事后截断）；两者对 HTTP 重定向一律拒绝；只有 `AbortError` 映射为 `WEB_ABORTED`，带自定义原因的中止（`dsh-timeout` 的 `TimeoutReason`）呈现为 `WEB_PROVIDER_ERROR`。
- **可按工作流切换**：否（provider 归全局设置；能切换的是组 2 的搜索开关本身）

### `@deepseek-ai/dsh-code-runtime-python`
- **seam 角色**：`dsh-code-runtime` seam 的 CPython 子进程实现——但在 `0.1.1-rc.2`，包入口只导出 fd-3 wire protocol 的 host 侧 codec 与敌意帧校验器（`src/index.ts`），`py/` 是 Python 侧的镜像；README 自己写明「本包不含子进程执行路径」，上游 `code-runtime` README 也写明 `language` 的已知值里「只有 `typescript` 有已发布的后端」
- **决定**：备选
- **它给会话带来什么**：经 Code Mode 间接——`run_code` 结果里的精确完成值（放得下时）或明确的 `invalid-output` / `output-limit` 失败，连同固定的 `[dsh-code-runtime-python] log capture truncated at <maxLogBytes> bytes` 日志标记。
- **理由**：Code Mode 整体不挂（组 2：`code-runtime` 与 `code-runtime-worker-thread` 不挂，因为上游标注 `DSH_TOOLS_MODE` 是临时的进程级开关，等它稳定成按会话配置再评估）；headless 与 web-app 都 insert `code-runtime-worker-thread`，都没有 Python 行，本项目与基线一致。记这一行是因为本项目的 Tool 契约（ADR-0017）与 Code Mode 是两条并行的路：Tool 是按运行生成的 cordis 插件、在子进程内运行；Code Mode 让模型写脚本去调工具。若将来 Code Mode 稳定后挂回来，脚本语言选 TS（worker-thread，已发布）还是 Python（这一行）是届时的决定；Python 后端要 `python3` 在 PATH，本项目 Action 已经靠 bash 调 Poppler，环境依赖不是新问题。协议本身的立场值得记：host 把每个入站帧当敌意输入——模型代码对 fd 3 有完全访问权，`validateChildFrame` 逐帧校验并重建，伪造字段不随行；完成值以无损 JSON 穿越，超出安全整数范围的 double 以 `BigInt` 序列化。现状是这一版没有可挂的插件（无 `apply`），「备选」在这一版是对协议包说的——见待核对。
- **可按工作流切换**：否

### `@deepseek-ai/dsh-lsp-stdio`
- **seam 角色**：Service Provider（`ctx.lsp` 的通用 stdio 语言服务器后端；经 `ctx.fs` 读源文件、经 `ctx.subprocess` 启动服务器）
- **决定**：备选
- **它给会话带来什么**：经 `dsh-tool-lsp` 间接——该工具呈现它规范化后的定义、实现与 hover 结果；提供方自身不贡献提示词或 schema。
- **理由**：`lsp` seam 不挂（组 2：工作区里没有代码库与语言服务器，编码专用能力），base 也不挂 lsp 家族，本项目与基线一致。它「是通用主机，而不是语言服务器目录或安装器」：`servers` 表至少一项，每项 `command` 与 `extensionToLanguage` 必填，预设要放在组合里——挂它等于本项目替每个工作流决定装哪个语言服务器。两条与本项目机制相撞的边界：其一，`initialize.processId` 固定为 `null`，服务器不监视 harness 进程，「被 SIGKILL 的 harness 会让它们继续运行，直到自行退出」——本项目 dispose 阶梯的最后一级就是 SIGKILL（ADR-0007 清理到静止），挂它意味着每次强杀都可能漏一个语言服务器进程，与本项目「dispose 不能证明子进程退出就隔离运行」的规则对冲；其二，它「信任所配置的服务器，不提供任何沙箱隔离」，本项目的围栏只圈 bash 与 write/edit，语言服务器进程不在圈里。换上时：`lsp` 与 `tool-lsp` 一起挂；默认 `maxMessageBytes` 16000000、`maxStderrBytes` 1000000、`maxDocumentBytes` 4000000、`shutdownTimeoutMs` 5000、`killGraceMs` 2000；`env` 里匹配 `KEY` / `PASSWORD` / `SECRET` / `TOKEN` 的变量不转发；每个 (server, workspace) 惰性一个进程、逐 Workspace 串行，长生命周期进程占内存直到 dispose。
- **可按工作流切换**：否

### `@deepseek-ai/dsh-subagent-acp / claude-code / codex / dsh-sdk`
- **seam 角色**：四个都是 `ctx.subagents` 的进程外 Service Provider（注册名默认 `acp` / `claude-code` / `codex` / `dsh-sdk`），与 base 挂的进程内 spawn / fork 同 seam
- **决定**：备选（家族）
- **它给会话带来什么**：子 agent 在自己的进程里收到独立任务与全新会话，不接收父级对话（四者都报告 `inheritsParentContext: false`）；父级经 `dsh-tool-subagent` 只收到最终 assistant 文本或精确的停止原因错误，不收中间消息与工具流量；子进程的 token 绝不进入父级上下文。
- **理由**：subagent 整组不挂（组 5，ADR-0014），base 挂的是进程内 `spawn-in-process` 与 `fork-in-process`，四个进程外 provider 都不在 base；`claude-code` 与 `codex` 是可选 Profile Bundle，各自的 `cordis.patch.yml` 只 insert 一行休眠 provider，工具行要人从 preset 里手工去掉 `disabled`。为什么连「进程外」也不作为 ADR-0014 的例外：四者都「不声明任何启动时能力」——`outputSchema`、`depthLimit`、`toolFilter`、`persona` 全为 false，本地服务对要求这些的请求直接拒绝而不是静默省略。本项目 Action 会话的全部收窄（结构化输出、工具子集、步数、思考强度）都在会话创建窗口里做（ADR-0015），子 agent 恰好逃出这一切，用量也在子进程自己的账上、`node_usage` 收不到——这就是「子 agent 逃出工具收窄、计费、轨迹与步数上限」在进程外的形态。`claude-code` 与 `codex` 各自还有两条：它们读宿主机的原生设置与登录状态（Claude Code 相对父会话 cwd 读用户、项目、本地设置；Codex 由 `HOME` 与 `CODEX_HOME` 决定），上游明言「宿主设置有意保持权威」——与 `~/.agents` 泄漏是同一类工作区隔离破功（ADR-0007）；载荷巨大且要另一把凭据经 `env` 显式转发（`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`）：darwin-arm64 的 Claude Agent SDK 0.3.220 加 CLI 2.1.220 压缩 74,858,812 字节、解包 256,908,856 字节，`@openai/codex@0.147.0` 压缩 111,199,052 字节、解包 274,777,843 字节。`acp` 与 `dsh-sdk` 都要 `command` 指定可执行文件；`dsh-sdk` 每次 spawn 一整棵 harness 树，子进程的 transcript 留在它自己的会话根、不桥接到父级日志。本项目里「委派」的等价物是图：扇出与汇总是图的形状而不是节点类型（CONTEXT.md）；若真有「让另一家模型做子任务」的需求，正确形态是让那家模型成为一条路由（`llm-pi-ai` 行）、由 Action 节点选它，而不是让会话里的模型去起它。
- **可按工作流切换**：否

### `@deepseek-ai/dsh-hooks-* / hook-protocol`
- **seam 角色**：`hook-protocol` 是库（不注册、不注入）；`hooks-claude-code` 与 `hooks-codex` 是在 `agent/session-start`、`agent/pre-step`、`tools/pre-execute`、`tools/post-execute`、`agent/turn-stopping`（CC 方言另有 `subagent/start` / `subagent/end`）上跑用户现有 `hooks.json` 里 command hook 子集的桥接插件
- **决定**：备选
- **它给会话带来什么**：hook 返回的 `additionalContext` 成为带来源标记（`{ kind: 'plugin', plugin: 'hooks-claude-code' }`）的上下文消息；阻塞的提示词、工具与停止以固定文本呈现——`blocked by UserPromptSubmit hook`、`Error: blocked by PreToolUse hook`、`continue: blocked by Stop hook`；`systemMessage` 与 `updatedInput` 只记录不呈现。
- **理由**：base 不挂。上游自己的定位是「原生 Cordis 插件可以完成此桥接的所有工作，功能更强，且具有类型化返回，没有序列化边界；该桥接只是已映射子集的兼容路径」。本项目走的正是原生路径：`composeNodeScope` 在 `agent/pre-step` 上拒绝超步、在 `agent/request` 上盖思考强度、用 `tools.restrict` 与 `guard` 收窄（组 10，包装）——同一批拦截点，直接在会话 scope 上注册，不经 shell 与 stdin JSON，这就是目录一句话里「拦截点由 ontoflow-rpc 直接注册」的含义。桥接的形状也不合本项目：`configPath` 是进程级配置、加载时解析一次（上游自己标 `TODO(per-session-hook-config)`），而本项目一个子进程里跑多个 Action 会话、各自规则不同，进程级 `hooks.json` 无法按 Action 分；hook 经 `ctx.shell` 跑（在本项目就是 bash-sandbox 围栏内），默认超时 10 分钟；`Stop` hook 无条件阻塞会每步强制续行、没有上限（`TODO(stop-loop-guard)`），与本项目的步数守卫对冲。CC 方言只支持 30 个事件里的 7 个，Codex 方言只支持 10 个里的 5 个，且 Codex 的 `PreToolUse` 只有 `block` 没有 `allow` / `ask`。换上时：`configPath` 必填；CC 另有 `pluginRoot`、`projectDir`，Codex 另有 `model`；`defaultTimeoutMs` 600000、`stderrSummaryMaxChars` 500；只跑 `type: 'command'`，其余类型解析后跳过并警告。
- **可按工作流切换**：否

### `@deepseek-ai/dsh-acp`
- **seam 角色**：传输适配器——stdio JSON-RPC 的 Agent Client Protocol 服务端，驱动 `ctx.agents`；stdout 专用于协议帧，与 `ontoflow-rpc` 争同一条 stdio
- **决定**：备选
- **它给会话带来什么**：`session/prompt` 的文本与图片按序成为一条用户消息，相邻文本拼接，资源链接展平为 `[resource_link name=… uri=…]` 引用；协议元数据、客户端能力、权限选择与会话 id 绝不进入模型请求。
- **理由**：本项目的线协议是 `ontoflow-rpc`（组 10），一个子进程的 stdout 只能给一个协议。就算不争 stdout，ACP 也不传本项目要的东西：它「仅已提交答案：实时进度、推理、工具活动、计划、标题和用量不会通过协议传输」，`session/update` 只为已提交 `assistant/message` 的文本与图片块发 `agent_message_chunk`——而本项目的 `run_events` 实时落库、`node_usage` 按 usage chunk 计费、Agent 轨迹按步骤展开，全部依赖 `session.event` 逐条到达。它也没有本项目的三个关键动作：没有逐会话关闭（「由连接管理的生命周期：一个连接会释放其所有会话；尚未实现单个会话关闭」）、没有结构化输出通道、`session/new` 拒绝非空 `mcpServers` 且不公布 MCP 能力（本项目按运行挂 MCP 服务器）。它有意义的场景是把本项目的运行子进程暴露给外部 ACP 客户端（编辑器）——那是另一个产品；仓库内它的主要客户端是上一节的 `subagent-acp`。换上时：`provider` 与 `model` 可选但可运行的组合两者都要；图片提示词能力只在挂了持久附件存储且精确路由声明支持图片时才公布。
- **可按工作流切换**：否

### `@deepseek-ai/dsh-sdk-jsonrpc-server`
- **seam 角色**：上游的 stdio JSON-RPC 服务端插件（`inject: ['agents']`）；传输与协议类型在组 1 必挂的库 `dsh-sdk-protocol` 里，与客户端 SDK 共享
- **决定**：备选——它是 `ontoflow-rpc` 的 fork 原型
- **它给会话带来什么**：每个已接受的 `session/prompt` 把调用方的 `contentBlocks` 原样作为该会话的一条用户消息交给模型；本包不添加系统提示词文本或工具 schema，那些来自外围组合的插件。
- **理由**：它就是 `ontoflow-rpc` 的上游（`packages/sdk/server/src/server.ts`@`0.1.1-rc.2`，组 10 记为 fork）。fork 而不是包装的原因写在这里：上游协议缺三样东西，都是引擎必须的。其一，没有逐会话关闭与取消——上游「协议没有逐会话关闭或提示词取消方法：SDK 创建的 agent 会一直存活到进程关闭」；本项目一个子进程跑整条工作流，节点结束要关会话，人取消运行时要按节点取消并落 `cancelled` 终态（ADR-0007），于是补了 `session/cancel` 与 `session/close`。其二，没有逐提示词结果——`MessageId` 只标识 inbox 准入，「拥有自动化活动区间的客户端必须自行定义并观察该区间」；本项目要读回结构化输出（ADR-0008 的数据面），于是补了 `session/output`，捕获值由会话 scope 上的 `structured_output` 工具两阶段提交确立。其三，没有按会话组合——上游 `initialize` 定一个 provider/model 给所有会话；本项目每个 Action 自己的模型、思考强度、工具子集、技能与结构化 schema 都在 prompt 懒创建时经 `agentOptions` 与 `nodeOptions` 进会话（ADR-0015）。另有一处刻意去掉：不转发 subagent 完成通知（subagent 不挂）。保留的上游语义：`initialize` 是运行时就绪边界，由 Loader 组合挂载时等当前插件树的全部加载任务完成再响应，所以首次提示词能看到 MCP 的初始工具发现；`shutdown` 刷新响应、dispose 根上下文后以 0 退出；stdout 纯净由部署保证，插件不检查也不否决 stdout logger——本项目组合文件的头注释因此禁止它；`deepseek-official` 无适配器时自动挂 `dsh-llm-deepseek`、其它 provider 无适配器则初始化失败——本项目组合显式挂了 `llm-deepseek`，这条兜底不触发。`serverInfo.name` 上游固定 `deepseek-harness-sdk-runtime`，本项目是 `ontoflow-harness-runtime`。升级上游时按本文件夹 AGENTS.md 的流程重看这个 fork：它依赖的 seam 形状任一处变了都要跟。
- **可按工作流切换**：否

### `@deepseek-ai/dsh-sdk-client`
- **seam 角色**：纯库——不在任何 Cordis 上下文注册；`DeepSeekHarness`（高层自有运行 API）与 `HarnessClient`（低层协议客户端），Python SDK 的设计孪生，共享同一个运行时对端
- **决定**：备选
- **它给会话带来什么**：无——模型运行在它 spawn 的运行时里，体验由那个运行时的组合决定。
- **理由**：Next 侧的 `RunProcess`（`runtime.ts`）直接用 `dsh-sdk-protocol` 的 `JsonRpcLineTransport` 自己 spawn、自己收束，这就是目录一句话里「直接用 sdk-protocol 的传输」的含义。不用现成客户端的理由有三。其一，它只会说上游协议：`prompt()` 只返回入队回执，`run()` 收集到整个 agent 下一次进入 `idle`，`finalResponse` 是区间内最后提交的 assistant 文本、「并非因果上归属于该提示词」，没有 cancel、close、output——本项目的方法集是 `ontoflow-rpc` 的超集，客户端也得跟着是超集。其二，结算模型不同：它以「收到 idle」为一次运行的边界，本项目以一个节点一个会话、结构化输出两阶段提交为边界，取消也按节点而不是关整个运行时（它「无轮次中取消：放弃轮次意味着关闭运行时」）。其三，关闭阶梯——`shutdown`（默认 1000 ms）→ stdin-EOF（`disposeEofGraceMs` 6000）→ SIGTERM（`disposeGraceMs` 3000）→ SIGKILL——本项目在 `RunProcess` 里自有一份同形的阶梯，理由与它相同：客户端运行在任何 harness 上下文之外，搭不上 `dsh-subprocess` 服务（上游记录的「SDK 托管传输例外」）；不同的是本项目在阶梯走完仍不能证明子进程退出时隔离整条运行、留住进程句柄（AGENTS.md），而它只是拒绝复用已关闭的客户端。凭据策略归调用方这一点两边一致：它的 `HarnessClientOptions.env` 整体替换子进程环境，建议以 `scrubbedParentEnv` 为擦除基底；本项目 `buildChildEnv` 正是洗刷后的父环境加显式白名单。仓库内它的唯一消费方是 `subagent-dsh-sdk`。
- **可按工作流切换**：否

## 待核对

- `@deepseek-ai/dsh-code-runtime-python` 在 `0.1.1-rc.2` 只导出 fd-3 协议词汇、没有插件入口，上游 `code-runtime` README 也说只有 `typescript` 有已发布的后端。目录把它记为「Code Mode 的 CPython 后端」备选；是否改口为协议包、或等上游发布后端再列，由维护者定。
- `llm-pi-ai` 路由上模型未声明某档位或没有推理能力时，`composeNodeScope` 无条件覆盖的 `reasoningEffort` 会否让请求在网络 I/O 前以 `UNSUPPORTED_REASONING_EFFORT` 失败——本项目每个 Action 都带档位（schema 默认 `high`），没有「未设」一说，`off` 也会照发——上游 README 写明「未出现在确切模型能力中的档位」一律这样失败，但没有说无推理元数据的模型收到 `off` 算不算；未在真实网关上验证，挂它之前先验这一条。
- `dsh-sandbox-windows-acl` 是 `sandbox-local` 的依赖、随之在闭包里，与 `node-addon-landlock-run` 同一地位；目录把它单列在组 9 而不视为 `sandbox-local` 的内部，是否保留单列由维护者定。
