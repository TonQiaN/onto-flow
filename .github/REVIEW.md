# 评审清单

给 Codex 自动评审与 `@claude` 按需评审共用，人工评审也照此勾选。清单把根 [AGENTS.md](../AGENTS.md) 的不变量按「评审时看什么」重排成可勾选条目；每条括注 AGENTS.md 里对应的那句或那节，规则的理由在那里，这里不重复。

评审的产出只有一种：带文件与行号的具体问题。不复述 diff、不评价风格、不夸奖。能被 `src/rules.test.ts` 机械核对的条目 CI 已经跑过，评审盯 CI 看不见的那些。

## 0. 门槛先看（PR 描述「跑了哪些命令」一节）

- [ ] 写明跑过 `npm run check`（typecheck + lint + fmt:check + vitest）。仓库没有 CI 之外的任何钩子，命令就是全部门槛（Checks）
- [ ] 关掉一条 lint 规则只在 `.oxlintrc.json` 里带理由地关，行内 `oxlint-disable-next-line` 必须带 `-- 理由`；没有整文件关闭（Checks / ADR-0019）
- [ ] diff 触及 `src/app/`、`next.config.ts` 或 `tsconfig.json` → 写明跑过 `npm run build`；`build` 抓得到 `typecheck` 抓不到的路由与配置破损（Checks）
- [ ] 用户可见的改动 → 跑了**对应的那一个** e2e spec 并写明是哪个，不是「跑了全套」也不是没跑（Checks）
- [ ] 触及 harness 接缝（会话、事件、用量、取消、组合）→ 写明是否跑了付费冒烟（`smoke-harness` / `smoke-engine`）与结论；没跑要说为什么可以不跑（The harness seam）
- [ ] 新增原生或 server-only 依赖 → `next.config.ts` 的 `serverExternalPackages` 有它；Turbopack `root` 钉住没动（Checks）
- [ ] `@deepseek-ai/*` 版本精确钉死，没有 `^` / `~`；不是 `latest`；`@deepseek-ai/dsh-*` 直接与传递依赖同时在 `overrides` 里同版（Pin `@deepseek-ai` versions exactly）

## 1. 立场：不做兼容层（Stance: no compatibility layers）

- [ ] 没有为「旧数据 / 旧调用方 / 旧字段」保留分支、回退默认值、别名导出、迁移脚本。废弃的路径要删，不是留着
- [ ] schema 改动直接改 `src/db/schema.ts` 由 `drizzle-kit push` 原地应用，没有提交 migration 文件
- [ ] 删子系统就整个删：表、API、组件、文档一起走，没有留 alias 层（ADR-0005 是先例）

## 2. 写路径与数据库（Conventions）

- [ ] 写路径返回结果对象（`WriteResult` + `writeOk` / `writeFail`）；只有引擎 `throw`，由 `runner.ts` 变成 `run_nodes.error`。没有出现第四种 `Result<T>` 副本（`folders.ts` / `revisions.ts` 的两份要向 `WriteResult` 收敛，不再复制）
- [ ] 没有 `await db.…`：better-sqlite3 是同步的，Drizzle 调用以 `.get()` / `.all()` / `.run()` 结尾
- [ ] 名称冲突交给数据库：writer 没有预查名字，`handle()` 把 `UNIQUE constraint failed` 映射成 409；folders 是唯一例外（根级 parent 为 NULL 无法约束）
- [ ] 实体体校验在 writer 的 `parse…Payload` 里，route 只窄化自己的非实体参数；仍是手写 `typeof` 窄化，没有引入 schema 库
- [ ] 每次实体写入在**同一事务**里记一版修订，包含关系；回滚复用同一个 `write<Kind>()`
- [ ] 原生 SQL 只经 `sql` 标签（`sql\`…\`` 与 `sql<T>\`…\`` 两种拼法都算）、只出现在查询构建器表达不了聚合的地方；白名单是 AGENTS.md 那句点名的七个文件（`monitor/cleanup.ts`、`monitor/health.ts` 与另外五个），`src/rules.test.ts` 钉住并要求名单里的文件今天仍在用；`LIKE` 里的用户输入已转义并配 `escape '\'`
- [ ] 全局设置仍是单行表里的一份 JSON 文档，整份在 `src/server/settings.ts` 写边界校验；凭据只以环境变量**名**出现，值从 Next 进程环境在 spawn 时取；插件开关是 `toggles` 五键、默认指令是 `defaultInstructions`，没有回到 `webSearchEnabled` 或硬编码指令
- [ ] 三层归属没有越界（Settings have three tiers）：全局给基线；工作流拥有 `instructions` / `settings.toggles`（只写覆盖键）/ `settings.mcpServers` / 技能集 / Tool 集；Action 只有预载 ⊆ 技能集、可见 Tool ⊆ Tool 集。⊆ 在**工作流保存**（`parseGraphPayload` 400，指名 Action 与技能 / Tool）与**运行受理**（`resolveWorkflow` 抛 `WorkflowResolveError` → 422）两处校验，没有挪到 Action 保存，也没有只留一处
- [ ] 工作流 PUT 对 `instructions` / `settings` / `skillIds` / `toolIds` 仍是「缺省沿用现值、出现即整体替换」；画布只发图的保存没有清空集合

## 3. 删除保护与引用（Delete protection is per-owner and there are exactly four）

- [ ] 没有新增第五种删除保护。四种是：四个可被引用库经 `usedByNames()` 答 409；workflow DELETE 的运行中守卫；folder DELETE 的重名守卫；run DELETE 经 `monitor/cleanup.ts` 的 `deleteRun` 拒绝运行中
- [ ] 没有手写引用 join：`src/server/references.ts` 是唯一 join 引用关系的模块；Skill / Tool 的引用方是**工作流**（`workflow_skills` / `workflow_tools`，detail「技能集」/「Tool 集」，href 指向工作流设置页），Action 的预载与可见 Tool 不是引用、不进删除保护
- [ ] 破坏性路径仍只在 `src/server/monitor/cleanup.ts`；没有第二处删 `run_events` / `runs` / `data/runs/<id>`
- [ ] 轮次行的线上形态没变（A round row has a skeleton and a payload）：`/api/runs/[id]` 与 SSE `snapshot` 帧的 `rounds` 只有骨架，且是 `listRoundSkeletons`（`src/server/run-rounds.ts`）在 `select` 时就不取重载荷，不是取回来再删；`inputs` / `outputs` / `snapshot` 只经 `/api/runs/[id]/nodes/[nodeId]/rounds/[round]` 按轮出去，抽屉在页签打开或换轮时取一轮并缓存，停在轨迹页签一条都不发
- [ ] 清理的保留分层没变（A round row has a skeleton and a payload）：events 目标删 `run_events` 并把 `run_node_rounds` **与 `run_nodes`** 的 `inputs` / `outputs` / `snapshot` 一起置空（后者是最新一轮的副本，漏了就仍整行经 `/api/runs/[id]` 返回），**不删行**；置空的资格按**运行**算（已终态且 `finished_at` 早于截止），不是「该运行有够龄事件行」——免费的输入→输出运行与首个事件前就失败的 Action 没有事件行，同样要被置空并计进预览；runs 目标与 `deleteRun` 才随 `runs` 级联删掉整行；预览与真做用同一份统计（被置空的轮次行数 / 节点行数，以及级联的轮次行数）
- [ ] 文件夹路径一律用 `isFolderEntityKind` 守门；工作流没有进文件夹（ADR-0005）

## 4. 路由与客户端边界（Conventions）

- [ ] 每个 API route 体都跑在 `@/lib/http` 的 `handle()` 里；`api/runs/[id]/events`（原生 SSE）与 `api/models`（早于规则的单语句 GET）是仅有的两个例外，没有被复制
- [ ] 每个 route `export const dynamic = "force-dynamic"`
- [ ] 客户端代码（含 `"use client"` 文件与 `src/app`（`api/` 除外）、`src/components` 下没有指令的共享模块）没有从 `@/server` 或 `@/db` 导入运行时值；`import type` 只从 `@/server/monitor/types`。没有 Server Action，所有变更是 `fetch` 到 `/api/*`
- [ ] 能到达修订还原的 route 带 `import "@/server/writers";`，否则 restore 静默答 501
- [ ] 五个库的列表 GET 与 `/api/runs` 仍返回 `{ items, total, page, pageSize }`（`/api/runs` 另带 `summary`）：库五个由 `parseListQuery` + `selectLibraryPage` + `listEnvelope` 组出，`/api/runs` 自组信封但分页参数走同一个 `parsePageQuery`（没有第二处写死 30 / 100）；其它 GET 各自定形
- [ ] 改了 `/api/runs` 的筛选或汇总 → `summary` 仍按同一组筛选**不分页**算：`runs` 是 distinct 的运行数（零用量的运行也算），token / 费用与每行同源、从按 `run_id` 预聚合的 `run_nodes` 子查询 **left join** 求和（权威汇总，`node_usage` 缺一条明细时不掉账），只有 `byModel` 走 `node_usage`；没有退化成内连接把无用量的运行挤掉；数组消费者一个不剩地改读 `items`（`rg -n '"/api/runs' src e2e scripts`）
- [ ] 受理来源仍是 `imports.invocation.source` 的**读时投影**：`/api/runs` 用 `json_extract` 推导 `items[].source` 与 `source=` 筛选（无 invocation 的行 coalesce 成 `workflow`），没有为它新增列、没有回填历史行、没有第二份表示（The five library list GETs and `/api/runs`…）
- [ ] 五个库页复用 `src/components/library/`，没有长出自己的树、工具栏、文件夹选择器或修订面板；筛选状态在 URL（`use-library-query`）不在组件 state
- [ ] 不可信路径过 `@/server/fs-safety`：请求边界 `isWithinData`，使用处 `resolveWithinData` / `safeBasename`

## 5. 进程级状态与运行隔离（Conventions / The harness seam）

- [ ] 进程级可变状态挂在 `globalThis` 且键以 `ontoflow` 开头；模块级 `const map = new Map()` 是这条规则要防的 bug
- [ ] 跨运行状态按 runId 键在 `globalThis` 上或落在运行自己的目录里；没有任何东西把运行串行化。`startRun` 仍是唯一准入口，满 `MAX_CONCURRENT_RUNS` 答 429 不排队
- [ ] 运行在准入时冻结定义（`resolveWorkflow` 一次事件循环内取完：图、Action、模型、端口、工作流指令与设置、技能集、Tool 集、每个 Action 的预载与可见 Tool），后续节点没有再回查共享库；`runs.settingsSnapshot` 与 runs 行同一事务写入，组合的开关 / MCP / Tool 插件都从冻结对象合成
- [ ] 预载没有绕过上游手势：`buildPrompt` 在正文前每个预载技能一行 `/<slug>`，没有把 SKILL.md 正文拼进 prompt，也没有在会话创建窗口里注册技能（A Skill is a directory…）
- [ ] 运行绝不停留在 `running`：新增的终态路径与 `executeRun` / `cancelRun` / `failWholeRun` / `reconcileOrphanRuns` 一致；`cancelled` 与 `failed` 仍是两个终态，前者 `run.error` 为 null
- [ ] 轮次行也绝不停留在 `running`（A run never stays `running`, and neither does a round）：上面四条路径加 `runner.ts` 对 `runActionNode` 抛出的 catch，都经 `engine/rounds.ts` 把仍 running 的 `run_node_rounds` 行收口成对应终态，并给被批量跳过的 pending 节点各补一行零时长 `skipped`；`runActionNode` 的骨架行 insert 仍是函数第一条语句，排在任何会抛的准备步骤之前，它的成功收口仍走带 `status = 'running'` 条件的 `settleRoundIfRunning`（取消赶在收束前落下时先到的终态赢），而 `runner.ts` 取消分支那次改写仍是**无条件**的 `settleRound`（反向次序：成功先落、取消后到，`closeRunningRounds` 找不到 running 的行，只有这一处能把轮次行拉回 cancelled）——两处条件性相反是有意的，节点与轮次的终态必须一致
- [ ] 重入的轮次号按**节点**取自己的下一个未用值（`NodeState.usedRound + 1`），没有回到「触发重入那个节点的轮次 + 1」——嵌套 / 重叠回边会据此撞 `(run_id, node_id, round)` 唯一键；输入 / 输出 / 被跳过的节点同样各占一行轮次（ADR-0018）
- [ ] 重入仍等环体收束（The workflow graph is not a DAG）：回边满足时只排队（`pendingReentries`），受影响节点里还有在 `running` 表里的就不重置，挂起期间 `pickReady` 也不放它们开跑；重入次数在真正重置时才计；取消与整运行失败让排队中的重入作废。直接在回边满足处重置正在跑的节点 = 串轮 + 运行可能在会话仍在飞时被判结束
- [ ] 子进程收束失败时运行被隔离（留在 `activeRuns`、保留进程句柄），预览 / 清理 / 删除 / 新运行容量 fail-closed
- [ ] 看一次运行只有 `/runs/<id>`（ADR-0018）：它只读受理时冻结的 `runs.graph`，不回查 `workflow_nodes` / `workflow_edges`；编辑器没有运行条、并行切换器与 `?runId=` 深链，发起后跳运行页；导航「运行中」面板每一路深链 `/runs/<id>`
- [ ] 会话事件到达即写 `run_events`（运行页那条 SSE 端点轮询 SQLite，没有进程内 pubsub）；没有把事件攒到节点结束再写；每条新写入的行都带 `session_id`（`events.ts` 的通用落库与 `action.ts` 自插的 `usage` 事件两处都要写）
- [ ] 用量按 chunk 求和、`outputTokens` 已含推理，没有把推理另算一桶；费用在写入时按到达时刻定价，未知模型为 0 而不是猜价
- [ ] 每运行组合没有 stdout logger（stdout 属于协议）；`dshHome` / `agentsHome` 钉在运行目录内；节点步数上限仍在
- [ ] 声明的产物必须真在盘上；模型说写了不算证据（ADR-0008）
- [ ] 压缩摘要的用量仍经 `compaction/summary` 记成 `node_usage` 行 `compaction:<seq>`、进 `run_nodes.cost`；提交阶段失败那次无法计费是已知例外（Compaction summary usage arrives on `compaction/summary`）
- [ ] 搜索三件套只在生效的 `toggles.webSearch` 为真时挂、全局默认关；改了别的开关行也只挂目录标了那个键的行（DeepSeek search is off by default）
- [ ] `TMPDIR=<run>/tmp` 与 spill root `<run>/home/spill` 仍钉在运行目录内；`spill-policy.maxInlineBytes`、`tool-todo.allowParallelInProgress`、`tool-fs-search.sampleOverCapGlobResults` 三个隐性必填键没被删（`TMPDIR` is pinned / Every composition row is decided in three places）
- [ ] `agent-instructions.maxBytes` 仍是 `INSTRUCTIONS_BATCH_MAX_BYTES`（两份 64 KiB 指令上限之和 + 帧余量），没有改回上游 base 的 65536——那会让全局默认指令在合计超限时被静默丢掉（Global settings are one JSON document）

## 6. 三方同步：组合 / 目录 / docs/harness（ADR-0013）

- [ ] 改了 `src/server/harness/composition.ts` 的条目 → `src/server/harness/catalog.ts` 的 `PLUGIN_CATALOG` 与 `docs/harness/` 的散文同一 PR 里跟上；`catalog.test.ts` 会红，但评审要看散文是否**说对了**，不只是不红
- [ ] 新插件的 `decision` / `mountedByDefault` / `workflowToggle` / `reason` 与它在组合里的实际挂载一致
- [ ] 新增 `models` 行走 `scripts/seed.ts` 的 `upsertModel`；新 provider 路由有 `runCompositionEntries` 里的 adapter；没有 route 写 `models`
- [ ] Tool 仍是契约、包装仍归平台（A Tool is an OntoFlow contract）：库里的 `code` 只是 `export default async function execute(args, ctx)`，没有 `name` / `inject` / `apply`，不 import `@deepseek-ai/*`（写入口拒绝）；上游注册形状只出现在 `src/server/harness/tool-plugin.ts`，改了它就跑 `tool-plugin.test.ts` 与 `composition-boot.test.ts`（真 boot 带样例契约 Tool 的组合）；Tool 要围栏只经 `ctx.run()`，谨慎的 Tool 以 `sandbox.enforced && !sandbox.runnerFailed` 为门禁
- [ ] JSON Schema 子集在**写入口**拦（`objectSchemaProblem`，`parameters` 与 `output` 都查，客户端 `tool-form.ts` 镜像形状规则）；没有把 type 数组的拒绝寄托在插件加载上——上游 `register` 不校验 `parameters`
- [ ] Tool 公名不在 `TOOL_RESERVED_PUBLIC_NAMES`（上游内建工具名 + `structured_output` / `run_code` / `web_fetch`）里、也不以 `mcp__` 开头，写入口拒绝；同名包装会让 boot 撞名倒下、遮蔽会话的 `structured_output`、或让整台 MCP 服务器的工具在同步时被丢弃（A Tool is an OntoFlow contract）

## 7. 专用付费入口的行为钉死（A specialized paid invocation pins behavior, not names）

- [ ] 改了参与专用入口的 Action 的 prompt / rule / provider / model / 思考强度 / 重入策略 / 预载技能 / 可见 Tool，或工作流的指令 / 开关覆盖 / MCP 子集 / 技能集 / Tool 集，或校验 Tool 的任一契约字段 → 对应的三类 digest pin（`src/lib/resume-match.ts` 的 `RESUME_MATCH_WORKFLOW_BEHAVIOR_SHA256` / `RESUME_MATCH_ACTION_BEHAVIOR_SHA256` / `RESUME_MATCH_VALIDATOR_TOOL_SHA256`，经 `src/server/resume-match-*-integrity.ts` 与其测试）**显式**审阅并更新，PR 描述列出新旧值；种子改了而 pin 没动，种子与测试必须红。工作流描述与 Tool 展示名不进契约，改它们不该动 pin
- [ ] 专用入口的业务结果仍写 `run_results`，没有塞进 `runs.imports`（运行列表 / 详情 API 会暴露它）
- [ ] Skill 投影仍是 `data/skills/<slug>` 链接指向 `.versions/<slug>-<stamp>/`，重写只换链接、路径没有空档，旧版本等持有释放再删（A Skill is a directory…）
- [ ] Skill 目录名仍是 id 稳定的 ASCII slug（`skillSlug()`），没有用中文库名；预载手势用的也是这个 slug。一定要生效的内容放进 Action 的 rule、工作流指令或全局默认指令，必定要用的技能由 Action 预载，不是靠模型「判断相关」；预载有 token 代价，编辑器旁的估算没有被拿掉

## 8. 测试（Checks / Test fixtures）

- [ ] e2e **没有**断言会随真实使用增长的东西：计数、首页包含、某一行恰好是种子 / 最新一次运行。正确写法是在用例里取 API 载荷、断言 DOM 与载荷一致。这个 bug 已经修过三次
- [ ] e2e 不依赖任何种子实体：`db:seed` 只种平台基线（内置对象类型与模型表），夹具由本 spec 在 `beforeAll` 自建、`afterAll` 收走；断言只对自建夹具或 API 载荷
- [ ] e2e 没有发起含 Action 节点的运行，没有点「执行清理 / 确认删除 / 中止该运行」；自建实体用本 spec 的 `e2e-` 中文前缀并在 teardown 经 `cleanupByPrefix` 收走
- [ ] 新单元测试是 `src/**` 或 `scripts/**` 下的 `*.test.ts`；服务层测试先把内存库挂到 `globalThis.ontoflowDb` 再 `await import()`，静态导入会碰到真实 `data/ontoflow.db`
- [ ] 改动的不变量若是纯逻辑（图、文件夹、定价、解析）→ 有单元测试；用户可见的 → 有 e2e

## 9. 文字、注释与文档（Conventions / Comments and documentation）

- [ ] 用户可见文字、错误信息、代码注释、测试名是中文；标识符是英文
- [ ] 没有删掉记录「为什么要这么绕」的注释（`longHaulFetch`、每工作区事件泵、`SUM` 汇总、`LIKE` 转义、静默 tick 收流）；新注释说的是行为、失败、时序、归属，不是复述控制流
- [ ] 新增的 `any` 带注释说明为何无法窄化
- [ ] 改了 `docs/DESIGN.md` / `docs/DESIGN-V2.md` 所陈述的契约 → 同一 PR 更新那份文档；定了新术语 → `CONTEXT.md` 只放词汇与语义，不放实现
- [ ] README 与 AGENTS.md 的 Commands 块、引擎 spec 三者要一起改或都不改（README 复述了它们）
- [ ] 改了 `.claude/skills/` → `.codex/skills/` 同一 PR 保持字节一致

## 10. ADR（Decisions and the glossary）

- [ ] 决定同时满足「难以逆转、脱离上下文会令人费解、真有取舍」三条 → 立 ADR `docs/adr/NNNN-slug.md`：中文标题、决定、`理由：` 段落以代价收尾；三条不全满足的不立
- [ ] 被取代的 ADR 原地留着，新旧互相链接（ADR-0003 ↔ ADR-0005 的写法）
- [ ] 代码里引用 ADR 用裸 id，写在被该决定约束的那一行的注释里（`（ADR-0005）`）
- [ ] 改了 AGENTS.md → 只陈述仓库已经遵守的规则；代码不再遵守的那条要删掉，不是改软
- [ ] 删减类改动有对应的 `docs/simplifications/` 记录：实施 PR 链接它、合并时移到 `done/` 并补「落地」；否决理由留在 `rejected/`，不回流 AGENTS.md（Decisions and the glossary）
