# OntoFlow 设计契约

实现阶段所有模块共同遵守的契约。领域语义见 [CONTEXT.md](../CONTEXT.md)，架构决策见 [adr/](./adr/)。

## 目录结构

```
src/
├── app/
│   ├── layout.tsx / globals.css        # 工作台外壳（已建）
│   ├── workflows/                      # 工作流列表 + [id]/ 画布编辑器
│   ├── actions/  skills/  tools/  object-types/   # 四个库的管理页
│   ├── runs/                           # 运行历史列表 + [id]/ 详情
│   └── api/                            # REST 路由（下表）
├── components/                         # 共享 UI（nav 已建）
├── db/  schema.ts  index.ts            # Drizzle（已建，改动需全员同步）
├── lib/
│   ├── graph.ts                        # 图校验、回边分类、出口与下游闭包
│   └── values.ts                       # PortValue 封装（已建）
└── server/
    ├── resolve.ts                      # DB 行 → ResolvedNode（图解析）
    ├── engine/                         # 就绪驱动编排、Action 执行与事件落库
    └── harness/                        # 每运行 dsh 子进程、组合、工作区与 RPC
```

## API 面（全部 JSON；错误统一 `{ error: string }` + 4xx/5xx）

| 路由 | 方法 | 说明 |
|---|---|---|
| /api/object-types, /api/skills, /api/tools | GET, POST | 列表/新建。Skill 载荷 `{ name, description?, content?, files?: [{ path, contentBase64 }] }`：`content` 是 SKILL.md 正文，`files` 是资源文件、缺省即空、整体替换（≤ 32 个、单个 ≤ 1 MiB、相对 `/` 分段路径、不含 `.`/`..`/空段/控制字符、≤ 200 字符、不能叫 SKILL.md、不能既是文件又是目录）；Tool 载荷是完整契约 `{ name, publicName, description?, parameters, output?, timeoutMs?, code }`（ADR-0017：`publicName` 匹配 `^[a-z][a-z0-9_]{0,63}$` 且唯一、`parameters`/`output` 是对象根 JSON Schema 且不含 type 数组、`timeoutMs` 正整数或 null、`code` 非空且不引用 `@deepseek-ai/*`） |
| /api/object-types/[id] 等同上三者 | GET, PUT, DELETE | 详情/更新/删除；GET /api/skills/[id] 另带 `files: [{ path, contentBase64, size }]`（按 path 排序；列表 GET 不带）；被引用时 DELETE 返回 409 `{ error, usedBy }`——Skill / Tool 的引用方是工作流的技能集 / Tool 集，`usedBy` 是工作流名；builtin 类型不可删改 |
| /api/models | GET | 模型白名单 |
| /api/actions | GET, POST | POST/PUT 载荷含 `ports: {direction,name,objectTypeId,position,artifactPath,exitName}[]`、`maxReentries`、`onExhausted`、`preloadSkillIds`（预载技能，ADR-0016）、`toolIds`（可见 Tool），整体替换；每个输出端口的 `artifactPath` 必填，输入端口两字段归一为 null。预载 ⊆ 技能集 / 可见 Tool ⊆ Tool 集不在这里校验（Action 是共享实体，只有放进工作流时才知道集合是什么），在工作流保存与运行受理两处校验 |
| /api/actions/[id] | GET, PUT, DELETE | 被 workflow 节点引用时 DELETE 409 |
| /api/workflows | GET, POST | POST body `{ name, description?, instructions?, settings?, skillIds?, toolIds? }`，图为空 |
| /api/workflows/[id] | GET, PUT, DELETE | GET 返回 `workflow`（含 `instructions`、`settings: { toggles, mcpServers }`、`skillIds`、`toolIds`）+ nodes + edges + 校验结果；PUT 的每个部分都是「缺省沿用现值、出现即整体替换」：`nodes` 与 `edges` 必须同时提供或同时省略（只给其一 400 `nodes 与 edges 必须同时提供或同时省略`），提供时整图替换（节点 id 由前端生成保持连线引用），同时省略时沿用库里当前的图、⊆ 校验与修订载荷都按当前图；`instructions` / `settings` / `skillIds` / `toolIds` 同理。画布只发图（不清空集合），设置页只发设置与集合（不发图，画布并发保存的图不会被设置页读来的旧图覆盖）；400：`instructions` 非字符串或 > 64 KiB、`settings.toggles` 出现未知键或非布尔、`settings.mcpServers` 不是合规名字数组、集合里的 id 不存在、`Action「X」预载的技能「Y」不在工作流技能集里，请先在工作流设置里加入`（可见 Tool 同款）。修订回滚走同一路径 |
| /api/workflows/[id]/run | POST | body: `{ inputs: { [inputNodeId]: PortValue } }`；图校验不通过、或某个 Action 的预载 / 可见 Tool 越出工作流集合（`WorkflowResolveError`）都是 422 `{ error, issues }`；通过则建 run 异步执行，返回 `{ runId }`；同时 running 的运行数达上限（16）时 429，排队归调用方 |
| /api/internal/resume-matches | POST | 「简历匹配评分」工作流调用入口；body 严格为 `{ job: PortValue(file), resume: PortValue(file) }`，调用方先经 `/api/uploads` 取得两个值；202 返回 `runId`、`statusUrl`、`historyUrl`，不暴露工作流或节点 id |
| /api/internal/resume-matches/[id] | GET | 只查询由该入口 POST 受理并在 run 元数据中留下来源证明的运行（同名工作流经通用入口启动仍为 404）；running/failed/cancelled 时 `result=null`，success 时读取完成门禁写入 `run_results` 的精确 JSON，再次严格校验并核对完成证据里的内容 SHA-256 后返回；工作区/事件清理不影响结果，删除 run 才级联删除 |
| /api/runs?workflowId=&status=&source=&from=&to=&page=&pageSize= | GET | 运行列表信封 `{ items, total, page, pageSize, summary }`，`items` 按 `startedAt` 倒序、每行带 `source`（受理来源）与 `nodesTotal` / `nodesDone` 进度（导航「运行中」面板与列表页共用）。七个参数：`status` 四值之一、`source` 匹配 `^[a-z][a-z0-9-]*$`、`from` / `to` 是 epoch 毫秒整数且窗口左闭右开（`startedAt ∈ [from, to)`），非法一律 400；`page` / `pageSize` 与五个库同一套（默认 30、上限 100，`parsePageQuery`）。`summary = { runs, tokens, cost, byModel: [{ providerId, modelId, tokens, cost }] }` 按同一组筛选**不分页**聚合：`runs` 数筛选集里 distinct 的运行（零用量的运行也算，因此等于 `total`），token 与费用与每行同源，来自按 `run_id` 预聚合的 `run_nodes` 子查询 left join（权威汇总；`node_usage` 插入瞬时失败的 chunk 只折进 `run_nodes`），只有 `byModel` 来自 `node_usage` 的预聚合、可能略小于 `tokens`——两处内连接都会把无用量的运行挤掉 |
| /api/runs/[id] | GET, DELETE | GET：`{ run, nodes, rounds }`——run 是全列，含受理时冻结的 `settingsSnapshot`（`global` / `workflow` / `effective` 三层，见「三层设置与快照」）与 `graph`（受理时冻结的图，ADR-0018；早于该列的运行是空图 `{version:1,nodes:[],edges:[]}`，形状与校验见 `src/lib/run-graph.ts`），`nodes` 是 run_nodes 全量（节点的最新状态），`rounds` 是 run_node_rounds 全量（每个节点的每一次执行一行，回放与抽屉只读它）；DELETE：删除单个已结束运行（run_nodes / run_node_rounds / run_events / node_usage / run_results 外键级联，连同运行目录），running 时 409 |
| /api/runs/[id]/files?path= | GET | 只读预览已结束运行目录内的 UTF-8 文本文件（执行中 409；路径收敛在该 run 的 run_dir 内；256KB 按完整字符截断，二进制或非法 UTF-8 为 415）；运行详情看输入与产物正文的唯一通道（ADR-0012） |
| /api/runs/[id]/events | GET | SSE：`event: snapshot`（`{ run, nodes, rounds }` 全量，与 GET /api/runs/[id] 同一形状；三者任一变化就重发）、`event: log`（run_events 增量，行带 `sessionId`，据此把事件归到轮）、`event: end`（终态且静默三拍后关闭）；连接即发一次 snapshot，事件从 id=0 起逐条回放再跟增量 |
| /api/runs/[id]/nodes/[nodeId]/trajectory | GET | 按需读取该 Action 各轮会话 JSONL，返回按回合与步骤组织的系统、用户、上下文、模型及工具折叠轨迹；工作区已清理时返回可展示的 unavailable 结果 |
| /api/uploads | POST | multipart 单文件 → 存 `data/uploads/<uuid>/<原名>`，返回 PortValue(file) |
| /api/settings | GET, PUT | 全局设置单文档 `SettingsDocument`（`modelApiKeyEnv`、`modelBaseUrl`、`credentialRefs[]`、`mcpServers[]`、`disabledTools[]`、`toggles`（五键全量，只发部分键时其余取默认，非布尔 400）、`defaultInstructions`（≤ 65536 字节，非字符串 400，空串合法））；写入口整份校验 |
| /api/settings/composition | GET | 插件面板：按**全局**开关推导的下次组合 `entries`、停用的 MCP、`PLUGIN_CATALOG` 十组投影 `groups`、最近一次运行落盘的 `cordis.yml`；工作流覆盖不在这里，看运行的 `settingsSnapshot` |

## 约定

- 所有 route handler 顶部 `export const dynamic = "force-dynamic"`（sqlite 本地读写，禁静态化）。
- 服务端校验：name 非空且唯一冲突返回 409；未知 id 返回 404。
- 前端数据获取：凡是要数据的页面都是 client component（`"use client"` 起手），一律 `fetch` 打 `/api/*` 后在 `useEffect` 里取数。没有 Server Action，也没有任何 Server Component 读 DB——只有根 `app/page.tsx`（仅 redirect）与 `app/layout.tsx`（静态外壳）不带 `"use client"`。
- UI 文案全部中文；Tailwind 工具类直接写，不引组件库；整体风格与既有外壳（zinc 系工作台）一致。
- 画布：@xyflow/react 12。node.data 只放展示与引用所需（actionId、端口清单、objectType 名与 kind），实体真身在 DB；连线校验用 `isValidConnection` 调 graph.ts 的同款逻辑（Object Type id 相等）。
- 执行引擎：就绪节点并行、并发上限 10；前向边决定首轮就绪，具名出口激活分支，回边触发受上限约束的新一轮会话，且要等环体里全部在跑的节点收束后才重置（ADR-0009）。
- 运行之间并行且互相独立：同一个工作流可同时发起多次运行，跨运行状态一律按 runId 隔离（工作区目录、子进程、globalThis 上的取消/进程/输入表）。唯一的准入闸门在 `startRun`：同时 running 的运行数达 `MAX_CONCURRENT_RUNS`（16）即返回 429 而不排队——每个运行是一整个 node+tsx+dsh 子进程，队列归外部调用方管。仓库内付费批量脚本实行全有或全撤：任一项被拒时取消并等齐同批已经受理的运行后才报错。
- 运行页是看一次运行的唯一地方（ADR-0018）：`/runs/<id>` 只读画受理时冻结进 `runs.graph` 的图（从不回查 `workflow_nodes` / `workflow_edges`，早于该决定的运行拿到空图，同一条渲染路径），底部时间轴一节点一行、一轮一段（段来自 `run_node_rounds`），事件按 `run_events.session_id` 落在所属段上；单一时间光标经纯函数 `visualsAt(t)` 推出任一时刻每个节点处于哪一轮、什么状态、哪些连线已激活，进行中默认钉在「现在」跟 SSE、往回拖即暂停跟随，已结束默认停在 `finishedAt`，事件被清理后退化为轮次级；点节点开抽屉看**光标所在那一轮**的轨迹、输入输出与快照。多路并行的切换在导航与运行列表上：导航侧栏的「运行中」面板逐路列出进行中的运行（轮询 `/api/runs?status=running&pageSize=100`，一页取完不翻页），每一路深链 `/runs/<runId>`；工作流卡片的「运行中」徽标链到按该工作流筛选的运行列表。编辑器只编排与发起——运行对话框受理成功即跳 `/runs/<runId>`，画布上没有运行条、没有并行切换器、没有 `?runId=` 深链。
- 一次运行独占 `data/runs/<workflowId>/<runId>/`、其中的共同 `workspace/` 与一个 dsh 子进程；每个 Action 的每一轮独占一个会话。全部输入物化到 `workspace/inputs/<节点id>/`——文件拷原件，文字物化为 `<节点名>.md`、JSON 为 `<节点名>.json`，提示里只给路径不内联（ADR-0012）；Action 之间只经共同工作区的产物文件交流（ADR-0006 / ADR-0008）。
- 运行期间 dsh 会话事件到达即写 `run_events` / `node_usage`，每条 `run_events` 行带 `session_id`（`events.ts` 的通用落库与 `action.ts` 自插的 `usage` 事件两处都写），事件据此归到轮；运行页那条 SSE 端点轮询 SQLite 回放与追增量，不依赖进程内 pubsub。`run_events` 只是跨节点实时摘要；单个 Action 的完整轨迹以运行目录内的会话 JSONL 为权威源，用户展开面板时才读取并投影，不把原始 token chunk 复制进 SQLite 或默认下载到浏览器。
- 专用工作流调用入口可注册完成门禁；门禁核对最终产物后，引擎在同一事务内把完成证据写进 run 元数据、把精确 UTF-8 结果写进 `run_results`，随后才把运行标为 success。工作区与事件清理不删除持久业务结果；删除 run 时由外键级联删除。
- 清理的保留分层（ADR-0018）：轮次行分骨架（轮次、会话、起止、终态、出口、错误）与重载荷（`inputs` / `outputs` / `snapshot`）。events 目标删 `run_events`（按事件自己的 `ts` 够龄），并把**够龄运行**的轮次行与 `run_nodes` 行上那三个重载荷列一起置空（`run_nodes` 上那三列是最新一轮的副本，不一起清就仍会整行经 `/api/runs/[id]` 返回），**保留骨架**——回放退化到轮次级仍要有依据；runs 目标与单条删除才随 `runs` 级联删掉整行。置空的资格按**运行**算（已终态且 `finished_at` 早于截止），不按「该运行有够龄事件行」算：免费的输入→输出运行与首个事件之前就失败的 Action 都没有 `run_events` 行，按事件推运行集合会把它们的重载荷永远留在库里。预览与真做共用同一份统计，两者报出的行数逐字相同。快照被清空后轨迹面板退回显示技能 slug，是这条策略的既定代价。

## 引擎实现规范（DeepSeek Harness）

DeepSeek Harness（`dsh`）是唯一执行引擎（ADR-0006）。Next 进程负责运行编排，运行专属子进程
负责 cordis 组合、会话与模型循环；两者只经 stdio JSON-RPC 通信。

- **每运行一套运行时**：先创建共同工作区，再生成 `cordis.yml`，最后以
  `node --import tsx src/server/harness/runner.ts <cordis.yml>` 启动子进程；无常驻共享 host。
  子进程 stdout 只承载 JSON-RPC，stderr 写 `<run>/logs/harness.stderr.log`，运行结束在 `finally`
  中逐级收束子进程，任何路径都不得遗留 `running`。
- **受理时执行快照**：`resolveWorkflow` 在同一个事件循环片段内一次读取图所引用的 Object Type、
  Action、模型、端口，工作流的 `instructions` 与规范化后的 `settings`（只留五个开关键的布尔与
  字符串形的服务器名），工作流技能集（`ResolvedSkillRef { id, name, slug }`，按 position）与
  Tool 集（`tools` 行全量），以及每个 Action 的预载（`ResolvedActionDefinition.preloads`）与可见
  Tool 公名（`capabilities.toolNamesByActionId`）。预载 ⊄ 技能集或可见 Tool ⊄ Tool 集时抛
  `WorkflowResolveError`（status 422，`issues[]` 一次列出全部越界项，文案指名 Action 与技能 /
  Tool），`startRun` 与专用入口都把它映射成 422。运行受理、Tool 物化和稍后启动的每个 Action 都
  消费同一对象；共享库的并发保存只影响下一次运行。Skill 正文仍按下条的活链接契约读取，并在各
  Action 会话启动前把当时可读的工作区投影全文写进节点快照；受理边界先验证并持有全部 Skill 投影，
  库内删除不会在运行与子进程完全收束前拆掉链接目标。图同样在这一刻冻结：`buildRunGraph(resolved)`
  与 `runs` 行同一事务写进 `runs.graph`（ADR-0018），运行页只画它。
- **一次执行一行轮次（ADR-0018）**：`run_node_rounds` 的 `(run_id, node_id, round)` 唯一，记这一轮的
  会话、起止、终态、所走出口、错误与本轮自己的 `inputs` / `outputs` / `snapshot`。Action 的一轮由
  `runActionNode` 一进门 insert 骨架行（running + startedAt + inputs，排在任何会抛的准备步骤之前，
  快照渲染完再补），收束时写终态；输入节点、输出节点与被跳过的节点由 `runner.ts` 落成起止同刻的一行。
  取消、整运行失败、启动对账与 `runActionNode` 抛出这四条路径都要收口——仍 running 的轮次行改写成对应
  终态，被批量跳过的 pending 节点各补一行零时长 `skipped`。Action 侧的成功收口带条件 `status = 'running'`
（`settleRoundIfRunning`）：取消可能在它等最后一次 sessionOutput / closeSession 时到达，先到的终态赢。重入把整个环体一起推进，但轮次号按**节点**
  取自己的下一个未用值（`NodeState.usedRound + 1`）：嵌套或重叠的回边会让内环已经跑过第 N 轮的节点被
  外环再次重置，一律取「触发重入那个节点的轮次 + 1」就会撞唯一键。**重入还要等受影响的节点全部收束**：
  回边满足时先排队（`pendingReentries`），受影响节点里一个都不在跑了才执行重置，挂起期间它们也不许被调度。
  环体扇出时一条快分支满足回边、另一条慢分支还在跑，直接重置会让调度器用同一个节点 id 启动慢分支的下一轮、
  顶掉正在跟踪的 promise：那次执行完成时写进的是已经代表下一轮的状态（outputs 与出口结算到新一轮头上），
  `finally` 又把新一轮摘出跟踪表，运行可能在会话仍在飞时就被判成结束。重入次数在真正重置时才计，
  取消或整运行失败会让排队中的重入作废。`run_nodes` 继续是节点的最新状态行，
  不再承担轮次历史；重入耗尽不是一轮，只在 `run_nodes` 上留终态、时刻与 error。
- **三层设置与快照（ADR-0016）**：全局设置是基线，工作流设置声明本工作流有什么，Action 只在其中
  收窄；Action 从不开关插件。合成规则：开关 `effectiveToggles(global.toggles, workflow.settings.toggles)`
  （工作流只写要覆盖的键）；MCP = 全局登记且启用 ∩ 工作流子集（子集里登记表已没有的名字静默忽略）；
  Tool 集全部物化、按 Action 可见子集收窄；技能集全部 symlink 进工作区、按 Action 预载。指令分两
  份文件：工作流 `instructions` 原样写 `workspace/AGENTS.md`（空时写 `# <工作流名>\n`），全局
  `defaultInstructions` 写 `<run>/home/AGENTS.md`——上游 `agent-instructions` 把 `$DSH_HOME/AGENTS.md`
  当用户级指令读，每个 Action 会话都无条件读到；出厂默认是原先硬编码在引擎里的四条运行约定。
  `runs.settingsSnapshot`（`RunSettingsSnapshot`：`global.{toggles, mcpServers(启用名), disabledTools,
  defaultInstructionsSha256}`、`workflow.{settings, instructionsSha256（对实际写进 workspace/AGENTS.md
  的文本）, skills[{id,name,slug}], tools[{id,name,publicName}]}`、`effective.{toggles, mcpServers}`）
  在 `startResolvedRun` 里与 `runs`、`run_nodes` 行同一事务写入；运行详情的「设置快照」折叠区读它。
  `run_nodes.snapshot` 的形状随之为：`skills: [{ id, name, slug, preloaded, content }]`（技能集全量，
  content 在会话启动前从工作区投影读）、`tools: [{ name: publicName, visible }]`（Tool 集全量）、
  `renderedPrompt`（预载技能各一行 `/<slug>` 在正文之前）。
- **能力与隔离**：Skill 是目录——`data/skills/<slug>/SKILL.md` 加资源文件 `<path>`——以 ASCII
  slug 链进 `workspace/.agents/skills/`，由 `skill-filesystem` 按描述发现；预载不拼提示，是提示正文
  前的 `/<slug>` 行，由上游 `tool-skill` 在同一步以 `skill-invocation` 来源展开成 `<skill_content>`，
  轨迹面板标成「预载技能：<名>」。Tool 是契约（ADR-0017）：`<run>/plugins/tool-<id>.execute.ts`
  是库里的 execute 模块原样，`tool-<id>.ts` 是 `src/server/harness/tool-plugin.ts` 生成的 cordis
  包装（注册公名、描述、schema、`timeoutMs`，`render` 一律 `JSON.stringify`；`execute` 组装
  `ToolContext`：绝对路径、白名单 `env`、`signal`、经 `sandboxPolicy` + `shell` 的 `run()`），以绝对路径
  进组合；工作流 Tool 集进入全局工具面后，每个 Action 会话再按自己的 `action_tools` 收窄可见面
  （deny = 全局停用 ∪ (Tool 集公名 − 本 Action 可见公名)）。`DSH_HOME`、`dshHome` 与 `agentsHome`
  全部钉在运行目录内，避免发现机器所有者的个人能力；spawn 时另注入 `TMPDIR=<run>/tmp`——上游
  沙箱围栏允许写的临时根是 `os.tmpdir()`，它认 `TMPDIR`——于是 bash 的 `mktemp`、Python 的
  `tempfile`、Poppler 的临时文件与 `subprocess-local` 的完整输出文件全部落在运行目录内，随运行
  清理并计入磁盘统计；`<run>/tmp` 是工作区的兄弟目录，不在工作区内部。`spill-local` 的 root 钉为
  `<run>/home/spill`：不钉时它落在 `os.tmpdir()` 下的进程级私有目录，钉在 `home/` 而不是工作区是
  因为 spill 文件不是产物，不该被 `glob` 扫进或被下游当成上游写的文件。
- **提示与产物**：Action 的任务、规则、上游取用说明、产物路径和出口要求组成一条文本消息。
  文件输入与上游产物都只给工作区相对路径；实质内容不沿边复制。循环第 N 轮的产物写进
  `rounds/N/`，不覆盖前一轮（ADR-0008 / ADR-0009）。
- **结构化结果**：每个 Action 会话按真实输出 schema 注册一次性的 `structured_output` 工具；
  工具参数只报告产物路径与所选出口，实质内容仍在文件。捕获值以 `tools/result` 的权威结果
  两阶段提交；会话收束后未捕获、出口不合法或声明的产物文件不存在，节点都失败。
- **模型调用**：模型行的 `providerId` 是 dsh 路由；`deepseek-official` 由
  `llm-deepseek` 提供。思考强度经会话 scope 上的 `agent/request` waterfall 无条件覆盖到调用配置；
  每节点最多 40 步、墙钟 15 分钟。图、全局设置与工作流设置在运行准入时冻结并传给执行器；网页
  保存只影响下一次运行。全局停用工具从会话工具面移除，晚注册工具另由 guard 兜底。
- **组合清单**：每运行的 `cordis.yml` 由 `composition.ts` 逐行生成，是显式平铺清单，不叠上游
  bundle、不用 patch（ADR-0013）。每一行的决定、分组、开关与定制标记记在 `catalog.ts` 的
  `PLUGIN_CATALOG`，散文论证按十组记在 `docs/harness/`；`catalog.test.ts` 钉死三方——默认组合
  的 entry 与目录里默认挂载的行一一对应，`mountedByDefault: false` 的行只在开关打开时进入组合，
  每行的 package 字符串原样出现在它那组的文档里，`docs/harness/README.md` 的上游版本等于
  `package.json` 钉版与每个定制行记的版本。`composition-boot.test.ts` 真起子进程 boot 默认组合与
  开搜索的组合（不调模型、不需凭据）：必填配置缺失、裸名不是直接依赖、provider 顺序错都在这里
  现形，而不是等到第一次付费运行整棵树起不来。
- **上下文预算**：`session-checkpoint-policy` 在每次模型请求前与顶层工具执行前把会话 JSONL
  刷盘，子进程崩溃不丢轨迹尾部。`token-meter` 折叠会话压力；`compaction-basic`（上游默认：阈值
  0.8、保留 0.16、摘要上限 8192 token、压缩与溢出重试各 1 次、自动）越过阈值时先让
  `tool-result-pruner`（8192 码点以上的工具结果改写为前 4096 + 后 1024）无模型剪枝，仍超才以一次
  独立的 `llm/stream` 调用把最旧的完整单元摘要成 `<compacted-summary>` 检查点；摘要失败不替换、
  带完整历史继续；摘要路由默认回退到 Action 自己的模型。摘要那次调用的用量不以 usage chunk
  到达，按「事件、轨迹与用量」一条经 `compaction/summary` 计费，不是账外支出（例外：摘要在提交
  阶段失败时上游不发 `compaction/summary`，那一次已付费的调用无法计费，见该条）。任何工具的纯文本
  结果超过 `spill-policy` 的 `maxInlineBytes`（50000 字节；必须显式写，上游省略该键等于整个策略
  禁用）时替换为首尾预览加 spill 文件路径，模型用 `read` 的 offset/limit 回读；`read` 的结果本身
  不经 spill。
- **守卫与对等工具**：`timeout-policy` 只对在定义上声明了 `timeoutMs` 的工具生效——`tool-web`
  60 秒、`glob` / `grep` 30 秒、声明了它的 Tool 插件——bash 的超时靠 `bash-sandbox` 自己的
  120 秒与进程组终止。`repeat-tool-reminder` 在同一工具以完全相同参数连续调用第 3 / 5 / 8 次时
  向模型追加提醒（参数预览 500 字符），只提醒不否决，是 40 步硬上限之前更便宜的止损。
  `tool-fs-search` 给会话 `glob` / `grep`，走包内 ripgrep 的固定 argv、不经 shell，
  `sampleOverCapGlobResults: false`（必填项）让超上限的结果保留确定性前缀并落 spill；
  `tool-str-replace-editor`（`maxOutputChars` 16000）与 `read` / `write` / `edit` 并存，修改同样经
  观察政策与沙箱策略；`tool-todo` 给模型 `todo_write`，`allowParallelInProgress: true`（必填项）。
  `tool-bash` 关掉 `run_in_background`，后台作业、子 agent 与上游的 workflow / goal / schedule
  一律不挂（ADR-0014）：编排只有人画的图。
- **可切换插件**：目录里带 `toggle` 键的行由 `CompositionToggles`（`src/lib/workflow-settings.ts`，
  五键）决定是否进入 cordis.yml：`webSearch` 控制搜索三件套 web / web-search-deepseek / tool-web
  （`mountedByDefault: false`，默认关），`fsSearch` 控制 `tool-fs-search`，`strReplaceEditor` 控制
  `tool-str-replace-editor`，`todo` 控制 `tool-todo`，`compaction` 控制 token-meter / compaction-basic /
  tool-result-pruner 三行同进同出（后四个默认开，与上游 headless 一致）。全局设置文档
  `SettingsDocument.toggles` 是五键的全局默认值（只发部分键时其余取默认，非布尔 400），工作流
  设置 `settings.toggles` 只写要覆盖的键，受理时 `effectiveToggles` 合成后与凭据引用、MCP 子集一起
  冻结成 `composition.toggles` 交给 `launchRun`（ADR-0016）；只有目录标为 `workflowToggle` 的行可被
  工作流覆盖，`catalog.test.ts` 对每个键验开与关都只动它那些行。搜索默认关是账目原因：DeepSeek
  搜索是一次独立的辅助模型请求，用量不经 `llm/stream`，本站 `node_usage` 收不到，属账外
  支出；两个设置页的开关旁都写明这一点，文案各有一份：全局设置页用自己的 `TOGGLE_COPY`
  （「DeepSeek 搜索的费用不计入本站用量：……是账外支出」），工作流设置页与运行页的设置快照用
  `COMPOSITION_TOGGLE_LABELS`（`src/lib/workflow-settings.ts`，「……本站 node_usage 收不到，是账外支出」）。打开后
  `web-search-deepseek` 用与模型同一把凭据引用名，`tool-web` 只开 search 不开 fetch。
- **插件面板**：`GET /api/settings/composition` 返回 `entries`（按当前**全局**设置与开关推导的
  下次组合，不折入任何工作流的覆盖——那是每次运行 `settingsSnapshot` 的事）、`disabledEntries`
  （停用的 MCP）、`groups`（`catalog.ts` 十组的投影：每行 package / decision / entryId（固定 id 或
  「前缀*」，无 entry 为 null）/ mounted / workflowToggle / reason / customization）与
  `lastComposition`（最近一次运行落盘的 cordis.yml）。`mounted` 八值，按路由的 `mountedState`
  逐条判定：决定为不挂或待定 → 不挂；备选 → 备选；没有 entry 的行按决定分两值——自有 → 自有
  （生成器 / 入口 / 会话内改造），其余 → 库；前缀行（MCP / Tool 插件，按运行生成）看推导组合里
  有没有解析到本行的实例（经 `catalogRowForEntryId`，不是裸前缀匹配——`tool-` 也是上游 tool-fs
  等固定 id 的前缀）：有 → 会挂载，没有 → 按运行生成；固定 id 且 `mountedByDefault: false` 的行
  按 entry 在不在组合里给按开关已挂 / 按开关未挂，其余固定 id 行给会挂载 / 不挂。面板是目录的
  投影而不是第二份清单：目录钉住组合（catalog.test.ts），面板按组对齐 API
  （settings.spec.ts），三者不会各说各话。
- **完成、取消与错误**：`session/prompt` 懒创建会话，Next 侧等待同一会话依次进入 running / idle；
  人工取消走 `session/cancel`，运行与节点进入独立的 `cancelled` 终态。节点完成后关闭会话，一次
  运行完成后关闭子进程；崩溃、超时与无产物都写入 run / run_node 的失败事实。无论发生在
  initialize 失败后的收束，还是正常执行的 finally，若 dispose 在终止升级后仍不能确认子进程
  退出，该运行都保持 active 隔离所有权：预览、清理、删除与新准入容量 fail-closed，不能用
  数据库终态冒充工作区已经静止。若 Action 会话与整个进程都无法确认静止，该会话的用量结算
  保持活跃：每条迟到 usage 落明细后，以本会话前的节点历史为固定基线幂等刷新节点累计与同一
  usage 事件；确认进程退出后再做最后一次刷新。节点累计或 usage 事件任一落库失败时，运行继续
  占用 active 所有权并定时重试，二者都持久化后才释放进程句柄与内存兜底。
- **事件、轨迹与用量**：`session.event` 通知到达时立刻归一为 text / reasoning / tool /
  session.idle / session.error / compaction 六种并落库。每个 step 的 usage chunk 是不累积值，按
  `(runId, sessionId, messageId)` 唯一化后求和，messageId 取 `turnN-stepM`；完整原始会话另存
  `<run>/sessions/**/session.jsonl`。
  上下文压缩的记账：摘要那次模型调用由 compaction-basic 直接经 `llm/stream` 发起、不经
  agent-loop，没有 usage chunk，用量只挂在 `compaction/summary` 事件上。事件到达时落成
  `node_usage` 一条明细：messageId 取 `compaction:<事件 seq>`（会话内唯一，不与 `turnN-stepM`
  撞键，同一事件重放只落一行），provider/model 取事件自带的摘要路由（缺省回退会话路由），
  variant 记 `compaction`（摘要不经思考强度 waterfall，不能冒充会话档位），费用按到达时刻计峰谷；
  `action.ts` 按会话对 `node_usage` 求和，摘要费用随之进入 `run_nodes.cost` 与 usage 结算事件，
  不另设桶、不重复计。例外：摘要在提交阶段失败（中止、表层被并发改动、commit 抛错）时上游只发
  带 `error` 的 `compaction/end`、不发带 usage 的 `compaction/summary`，那一次已付费的调用无法
  计费——这是上游事件模型的限制，运行列表的用量汇总会少算，不能把这条链路说成完整计费。`run_events` 的
  compaction 事件：`compaction/start` 落
  `{ op: "summary", status: "running", compactionId, turn }`；`compaction/summary` 落
  `{ op: "summary", status: "ok", compactionId, provider, model, summaryChars, shadowedNodes,
  shadowedTokenCount, inputTokens, outputTokens, reasoningTokens, cacheReadTokens,
  cacheWriteTokens, costCny }`（上游未上报 usage 时改为 `usageReported: false`；摘要正文不进
  run_events，正文在 sessions/*.jsonl 与轨迹面板）；带 `error` 的 `compaction/end` 落
  `status: "error"`，正常关闭只是释放锁、不记；`compaction/prune` 落
  `{ op: "prune", status: "ok", shadowedNodes, shadowedTokenCount }`。以 `surfaceOp.op === "replace"`
  进入表层的 `tool/result` 是裁剪副本，原始结果已经落库，不再落第二条 tool 事件。compaction
  事件成行展示只在 Action 轨迹面板（见下段的轨迹投影）。
  轨迹投影把一次压缩的完整生命周期合成一条 context 记录：`compaction/start` 开锁、
  `compaction/summary` 记录摘要与调用事实、紧随其后带 `source.plugin === "compact"` 的 replace
  `user/message` 才是模型此后真正看到的检查点、`compaction/end` 释放锁；记录带摘要、替换后的
  检查点、压缩事实（compactionId / shadowedRange / shadowedSeqs / shadowedTokenCount / provider /
  model / maxTokens / llmStreamCall）、用量与时序，见到 summary 即视为表层已替换，未闭合的按会话
  活跃度显示「上下文压缩中」或「上下文压缩中断」，带 error 的 end 显示「上下文压缩失败」。
  `compaction/prune` 与紧随其后（seq 相邻，上游 `compaction/prune` 契约）的替换 `tool/result`
  合成一条「工具结果已裁剪」记录；
  `tool/result` 先到先得，替换副本不覆盖原始消息，工具记录仍是模型当时看到的全文。没有配对
  摘要事件的检查点单独成行（「上下文检查点」）。`todo/write` 快照不投影：`todo_write` 已作为
  工具调用与结果可见。
  正常会话与隔离会话都用会话前节点基线幂等结算；节点累计与 usage 事件任一写入失败，
  都保留结算状态并在子进程退出后持续重试，不能只留数字而永久缺失事件。
  DeepSeek 的 `outputTokens` 已含 reasoning；运行详情、历史 API、画布运行条与轨迹
  均只把 input/output/cacheRead/cacheWrite 计入总 token，reasoning 只保留为拆分明细。
  运行详情展开某个 Action 时，从数据库记录的 `runDir` 枚举 `nodeId` 与 `nodeId#N` 会话，使用
  dsh 公共 codec 解包 chunk 行，再按回合与步骤折叠、按 `callId` 配对 Tool 调用与结果。界面只
  返回有长度边界且物理路径脱敏的折叠记录，输入 / 模型 / 工具三泳道和选中记录详情由同一投影
  生成；折叠状态不预取正文。

## 安全与健壮性约束（终审确认项）

- **运行输入的 file PortValue 不可信**：`/api/workflows/[id]/run` 直接接收请求体里的
  PortValue，`file.path` 必须经 `src/server/fs-safety.ts` 的 `resolveWithinData` 约束在
  `data/` 内（`isWithinData` 在 startRun 入口 422 拦截，`resolveWithinData` 在 runner.ts
  物化时纵深兜底），`file.name` 用 `safeBasename` 只取 basename——防目录穿越读任意文件外泄、
  或覆盖工作区目标目录之外的文件。
- **输入在受理边界可完整物化**：文字与 JSON 内容上限都是 32 MiB；JSON 按落盘格式预先
  序列化，递归过深等无法安全序列化的输入以 422 拒绝，不得先建立运行再异步失败。
- **文件输入原样物化，平台不做任何预处理（ADR-0011）**：所有文件输入原样拷贝为
  `inputs/<节点id>/<文件名>`；格式转换（抽文本、栅格化、逐页 `read_image`）是 Action 会话里
  模型用 `bash` 自己的工作。上传请求体在 multipart 解析前流式限流，单文件上限 32 MiB。
- **节点 id 在 Workflow 写入边界限制为 120 个 ASCII 字符**：它会直接成为
  `inputs/<节点id>/` 的目录段，不能让超长 id 在运行已受理后才以 `ENAMETOOLONG` 异步失败。
- **每个会话都有 `bash`，写入被沙箱圈定**：`bash` 与 `read`/`write`/`edit`/`read_image`/`skill`
  同为基础工具面，对所有 Action 可见。bash 与 write/edit 共用一份 `workspace-write` 沙箱策略，
  写入只放行运行工作区与系统临时目录，但两族的围栏强度不同：bash 的命令经 Seatbelt
  （`sandbox-exec`）内核围栏执行，runner 不可用时 fail-closed 拒绝执行命令；write/edit 走
  `dsh-fs-sandbox` 的进程内路径检查，上游明言它是策略围栏而非内核边界，也不经 runner。
  read 与网络两族都不受限；模型请求的沙箱升级因 `approval policy: "never"` 一律拒绝。
- **孤儿运行对账**：`src/instrumentation.ts` 启动钩子调用 `reconcileOrphanRuns`，把上次进程
  遗留的 `running` run 及其 running/pending 节点失败化——否则 SSE 结束条件永假、无限轮询。
- **HMR 下的运行所有权**：取消标记与在跑子进程句柄挂在 `globalThis`，使开发期 HMR 不会丢失
  对现存运行的取消和收束能力；运行结束必须删除对应句柄与取消标记。

## 种子（scripts/seed.ts）

`scripts/seed.ts` 只种平台基线：内置对象类型（text / file / json）与模型表（DeepSeek V4 Flash
Vision / V4 Flash / V4 Pro，provider 路由均为 `deepseek-official`）；案例内容各自有种子脚本，
见 `scripts/seed-resume.ts` 与 `scripts/seed-leetcode.ts`。

## 案例种子：简历匹配评分（scripts/seed-resume.ts）

- 工作流「简历匹配评分」是两个文件输入 → 一个解析 Action → 六个评委扇出 → 一个汇总 →
  一个输出的 11 节点图。
- `岗位JD文件` 与 `简历文件` 都以原件进入工作区，PDF、Markdown、纯文本一视同仁。
- 只有「简历评分·解析」使用 `deepseek-v4-flash-vision-exp`。它必须把输入当不可信数据，自己用
  bash 处理 PDF：`pdfinfo` 确认页数、`pdftotext` 抽文本层、`pdftoppm` 逐页栅格化后逐页调用
  `read_image` 核对，需要时写脚本裁剪放大局部；扫描件文本层为空也不得跳页，页面与文本冲突时
  以可见页面为准。
- 六个评委与汇总使用 `deepseek-v4-flash`。评委只经 `job.md` / `resume.md` 读解析结果；汇总等
  六份 `scores/*.md` 全部结算后，再回看 `job.md` / `resume.md`，自动裁决评委分歧、证据缺口、
  分数不自洽与不允许的评分依据。最终产物固定为 `match-result.json`：JSON Schema 禁止额外字段，
  `src/lib/resume-match.ts` 再核对总分、档位、否决、证据充分度、硬性条件及改分记录的跨字段关系。
- 汇总 Action 独享 `validate_resume_match_result` Tool；它写出文件后必须反复调用，直到轨迹留下
  `valid=true`、错误为空且带实际读取内容 SHA-256 的回执。引擎在写 `success` 前核对该 SHA-256
  与最终产物字节，并把它固化进运行元数据，同时把精确 JSON 写入 `run_results`；工作区与事件明细
  随后可以清理，成功结果不会因此失去读取依据。
  只写出合法 JSON 却跳过 Tool、回执落库失败或校验后又改文件的运行都收束为失败。Agent 自检与
  API 边界不会各自维护一套规则。该入口还会验证工作流 Tool 集里仍有公名为
  `validate_resume_match_result` 的 Tool、汇总 Action 仍能看见它、它的契约摘要
  `toolContractSha256({ publicName, description, parameters, output, timeoutMs, code })`
  （`src/lib/tool-digest.ts`，规范 JSON 键排序，schema 只改键序不算变化）匹配内置 pin
  `RESUME_MATCH_VALIDATOR_TOOL_SHA256`，本次全局设置快照没有停用它或 `read`/`write`/`bash`/
  `read_image`/`structured_output` 这些必需基础工具，且汇总 Action 不在任何回边的重入范围内。
  受理时把结果输出节点和汇总校验节点 id 与来源证明一起持久化，不按 `startedAt` 反推修订。岗位
  JD 与简历输入还必须各自使用指定 Object Type，并分别连到解析 Action 的对应端口；八个固定
  Action 的完整输入输出端口集合、产物路径与 11 个指定节点间的 23 条业务边必须精确匹配种子定义，
  六位评审各自接齐岗位与简历且各有一份结论进入汇总。行为摘要 pin 有两类：工作流行为摘要
  `RESUME_MATCH_WORKFLOW_BEHAVIOR_SHA256` = sha256(规范 JSON `{ instructions, settings: { toggles,
  mcpServers(排序) }, skillNames(排序), toolPublicNames(排序) }`)，工作流指令是常量
  `RESUME_MATCH_WORKFLOW_INSTRUCTIONS`；每个参与 Action 的 `{ name, prompt, rule, providerId, modelId,
  reasoningEffort, maxReentries, onExhausted, preloadSkillNames(排序), toolPublicNames(排序) }` 匹配
  `RESUME_MATCH_ACTION_BEHAVIOR_SHA256[name]`。工作流描述与 Tool 展示名不进契约。预载或可见 Tool
  越出工作流集合时入口回 422（issues 与 `startRun` 同形）。网页编辑任一行为定义后，专用入口拒绝
  付费运行，直到 seed 定义与 pin 经过代码审查并同步更新（种子在 pin 不符时 throw 并打印新旧值；
  re-pin 是显式评审动作，PR 描述列新旧值）。随后把通过预检的同一图、Action/Tool 定义与设置对象
  交给 `startResolvedRun`，并发画布或共享库保存不能换掉实际执行快照。缺失或被改写的契约不得先
  产生模型费用再失败。
