# 评审清单

给 Codex 自动评审与 `@claude` 按需评审共用，人工评审也照此勾选。清单把根 [AGENTS.md](../AGENTS.md) 的不变量按「评审时看什么」重排成可勾选条目；每条括注 AGENTS.md 里对应的那句或那节，规则的理由在那里，这里不重复。

评审的产出只有一种：带文件与行号的具体问题。不复述 diff、不评价风格、不夸奖。能被 `src/rules.test.ts` 机械核对的条目 CI 已经跑过，评审盯 CI 看不见的那些。

## 0. 门槛先看（PR 描述「跑了哪些命令」一节）

- [ ] 写明跑过 `npm run check`（typecheck + vitest）。仓库没有 CI 之外的任何钩子，命令就是全部门槛（Checks）
- [ ] diff 触及 `src/app/`、`next.config.ts` 或 `tsconfig.json` → 写明跑过 `npm run build`；`build` 抓得到 `typecheck` 抓不到的路由与配置破损（Checks）
- [ ] 用户可见的改动 → 跑了**对应的那一个** e2e spec 并写明是哪个，不是「跑了全套」也不是没跑（Checks）
- [ ] 触及 harness 接缝（会话、事件、用量、取消、组合）→ 写明是否跑了付费冒烟（`smoke-harness` / `smoke-engine`）与结论；没跑要说为什么可以不跑（The harness seam）
- [ ] 新增原生或 server-only 依赖 → `next.config.ts` 的 `serverExternalPackages` 有它；Turbopack `root` 钉住没动（Checks）
- [ ] `@deepseek-ai/*` 版本精确钉死，没有 `^` / `~`；不是 `latest`（Pin `@deepseek-ai` versions exactly）

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
- [ ] 原生 SQL 只经 `sql` 标签（`sql\`…\`` 与 `sql<T>\`…\`` 两种拼法都算）、只出现在查询构建器表达不了聚合的地方；白名单是 AGENTS.md 那句点名的 `monitor/` 与五个文件，`src/rules.test.ts` 钉住并要求名单里的文件今天仍在用；`LIKE` 里的用户输入已转义并配 `escape '\'`
- [ ] 全局设置仍是单行表里的一份 JSON 文档，整份在 `src/server/settings.ts` 写边界校验；凭据只以环境变量**名**出现，值从 Next 进程环境在 spawn 时取；插件开关是 `toggles` 五键、默认指令是 `defaultInstructions`，没有回到 `webSearchEnabled` 或硬编码指令
- [ ] 三层归属没有越界（Settings have three tiers）：全局给基线；工作流拥有 `instructions` / `settings.toggles`（只写覆盖键）/ `settings.mcpServers` / 技能集 / Tool 集；Action 只有预载 ⊆ 技能集、可见 Tool ⊆ Tool 集。⊆ 在**工作流保存**（`parseGraphPayload` 400，指名 Action 与技能 / Tool）与**运行受理**（`resolveWorkflow` 抛 `WorkflowResolveError` → 422）两处校验，没有挪到 Action 保存，也没有只留一处
- [ ] 工作流 PUT 对 `instructions` / `settings` / `skillIds` / `toolIds` 仍是「缺省沿用现值、出现即整体替换」；画布只发图的保存没有清空集合

## 3. 删除保护与引用（Delete protection is per-owner and there are exactly four）

- [ ] 没有新增第五种删除保护。四种是：四个可被引用库经 `usedByNames()` 答 409；workflow DELETE 的运行中守卫；folder DELETE 的重名守卫；run DELETE 经 `monitor/cleanup.ts` 的 `deleteRun` 拒绝运行中
- [ ] 没有手写引用 join：`src/server/references.ts` 是唯一 join 引用关系的模块；Skill / Tool 的引用方是**工作流**（`workflow_skills` / `workflow_tools`，detail「技能集」/「Tool 集」，href 指向工作流设置页），Action 的预载与可见 Tool 不是引用、不进删除保护
- [ ] 破坏性路径仍只在 `src/server/monitor/cleanup.ts`；没有第二处删 `run_events` / `runs` / `data/runs/<id>`
- [ ] 文件夹路径一律用 `isFolderEntityKind` 守门；工作流没有进文件夹（ADR-0005）

## 4. 路由与客户端边界（Conventions）

- [ ] 每个 API route 体都跑在 `@/lib/http` 的 `handle()` 里；`api/monitor/stream`、`api/runs/[id]/events`（原生 SSE）与 `api/models`、`api/documents`（早于规则的单语句 GET）是仅有的四个例外，没有被复制
- [ ] 每个 route `export const dynamic = "force-dynamic"`
- [ ] 客户端代码（含 `"use client"` 文件与 `src/app`（`api/` 除外）、`src/components` 下没有指令的共享模块）没有从 `@/server` 或 `@/db` 导入运行时值；`import type` 只从 `@/server/monitor/types`。没有 Server Action，所有变更是 `fetch` 到 `/api/*`
- [ ] 能到达修订还原的 route 带 `import "@/server/writers";`，否则 restore 静默答 501
- [ ] 五个库的列表 GET 仍返回 `{ items, total, page, pageSize }`，由 `parseListQuery` + `selectLibraryPage` + `listEnvelope` 组出；其它 GET 各自定形
- [ ] 五个库页复用 `src/components/library/`，没有长出自己的树、工具栏、文件夹选择器或修订面板；筛选状态在 URL（`use-library-query`）不在组件 state
- [ ] 不可信路径过 `@/server/fs-safety`：请求边界 `isWithinData`，使用处 `resolveWithinData` / `safeBasename`

## 5. 进程级状态与运行隔离（Conventions / The harness seam）

- [ ] 进程级可变状态挂在 `globalThis` 且键以 `ontoflow` 开头；模块级 `const map = new Map()` 是这条规则要防的 bug
- [ ] 跨运行状态按 runId 键在 `globalThis` 上或落在运行自己的目录里；没有任何东西把运行串行化。`startRun` 仍是唯一准入口，满 `MAX_CONCURRENT_RUNS` 答 429 不排队
- [ ] 运行在准入时冻结定义（`resolveWorkflow` 一次事件循环内取完：图、Action、模型、端口、工作流指令与设置、技能集、Tool 集、每个 Action 的预载与可见 Tool），后续节点没有再回查共享库；`runs.settingsSnapshot` 与 runs 行同一事务写入，组合的开关 / MCP / Tool 插件都从冻结对象合成
- [ ] 预载没有绕过上游手势：`buildPrompt` 在正文前每个预载技能一行 `/<slug>`，没有把 SKILL.md 正文拼进 prompt，也没有在会话创建窗口里注册技能（A Skill is a directory…）
- [ ] 运行绝不停留在 `running`：新增的终态路径与 `executeRun` / `cancelRun` / `failWholeRun` / `reconcileOrphanRuns` 一致；`cancelled` 与 `failed` 仍是两个终态，前者 `run.error` 为 null
- [ ] 子进程收束失败时运行被隔离（留在 `activeRuns`、保留进程句柄），预览 / 清理 / 删除 / 新运行容量 fail-closed
- [ ] 会话事件到达即写 `run_events`（两个 SSE 端点轮询 SQLite，没有进程内 pubsub）；没有把事件攒到节点结束再写
- [ ] 用量按 chunk 求和、`outputTokens` 已含推理，没有把推理另算一桶；费用在写入时按到达时刻定价，未知模型为 0 而不是猜价
- [ ] 每运行组合没有 stdout logger（stdout 属于协议）；`dshHome` / `agentsHome` 钉在运行目录内；节点步数上限仍在
- [ ] 声明的产物必须真在盘上；模型说写了不算证据（ADR-0008）
- [ ] 压缩摘要的用量仍经 `compaction/summary` 记成 `node_usage` 行 `compaction:<seq>`、进 `run_nodes.cost`，Trace 与成本页不把它算成 assistant 消息；提交阶段失败那次无法计费是已知例外（Compaction summary usage arrives on `compaction/summary`）
- [ ] 搜索三件套只在生效的 `toggles.webSearch` 为真时挂、全局默认关；改了别的开关行也只挂目录标了那个键的行（DeepSeek search is off by default）
- [ ] `TMPDIR=<run>/tmp` 与 spill root `<run>/home/spill` 仍钉在运行目录内；`spill-policy.maxInlineBytes`、`tool-todo.allowParallelInProgress`、`tool-fs-search.sampleOverCapGlobResults` 三个隐性必填键没被删（`TMPDIR` is pinned / Every composition row is decided in three places）
- [ ] `agent-instructions.maxBytes` 仍是 `INSTRUCTIONS_BATCH_MAX_BYTES`（两份 64 KiB 指令上限之和 + 帧余量），没有改回上游 base 的 65536——那会让全局默认指令在合计超限时被静默丢掉（Global settings are one JSON document）

## 6. 三方同步：组合 / 目录 / docs/harness（ADR-0013）

- [ ] 改了 `src/server/harness/composition.ts` 的条目 → `src/server/harness/catalog.ts` 的 `PLUGIN_CATALOG` 与 `docs/harness/` 的散文同一 PR 里跟上；`catalog.test.ts` 会红，但评审要看散文是否**说对了**，不只是不红
- [ ] 新插件的 `decision` / `mountedByDefault` / `workflowToggle` / `reason` 与它在组合里的实际挂载一致
- [ ] 新增 `models` 行走 `scripts/seed.ts` 的 `upsertModel`；新 provider 路由有 `runCompositionEntries` 里的 adapter；没有 route 写 `models`
- [ ] Tool 仍是契约、包装仍归平台（A Tool is an OntoFlow contract）：库里的 `code` 只是 `export default async function execute(args, ctx)`，没有 `name` / `inject` / `apply`，不 import `@deepseek-ai/*`（写入口拒绝）；上游注册形状只出现在 `src/server/harness/tool-plugin.ts`，改了它就跑 `tool-plugin.test.ts` 与 `composition-boot.test.ts`（真 boot 带样例契约 Tool 的组合）；Tool 要围栏只经 `ctx.run()`，谨慎的 Tool 以 `sandbox.enforced && !sandbox.runnerFailed` 为门禁
- [ ] JSON Schema 子集在**写入口**拦（`objectSchemaProblem`，`parameters` 与 `output` 都查，客户端 `tool-form.ts` 镜像形状规则）；没有把 type 数组的拒绝寄托在插件加载上——上游 `register` 不校验 `parameters`
- [ ] Tool 公名不在 `TOOL_RESERVED_PUBLIC_NAMES`（上游内建工具名 + `structured_output` / `run_code` / `web_fetch`）里，写入口拒绝；同名包装会让 boot 撞名倒下、或遮蔽会话的 `structured_output`（A Tool is an OntoFlow contract）

## 7. 专用付费入口的行为钉死（A specialized paid invocation pins behavior, not names）

- [ ] 改了参与专用入口的 Action 的 prompt / rule / provider / model / 思考强度 / 重入策略 / 预载技能 / 可见 Tool，或工作流的指令 / 开关覆盖 / MCP 子集 / 技能集 / Tool 集，或校验 Tool 的任一契约字段 → 对应的三类 digest pin（`src/lib/resume-match.ts` 的 `RESUME_MATCH_WORKFLOW_BEHAVIOR_SHA256` / `RESUME_MATCH_ACTION_BEHAVIOR_SHA256` / `RESUME_MATCH_VALIDATOR_TOOL_SHA256`，经 `src/server/resume-match-*-integrity.ts` 与其测试）**显式**审阅并更新，PR 描述列出新旧值；种子改了而 pin 没动，种子与测试必须红。工作流描述与 Tool 展示名不进契约，改它们不该动 pin
- [ ] 专用入口的业务结果仍写 `run_results`，没有塞进 `runs.imports`（运行列表 / 详情 API 会暴露它）
- [ ] Skill 投影仍是 `data/skills/<slug>` 链接指向 `.versions/<slug>-<stamp>/`，重写只换链接、路径没有空档，旧版本等持有释放再删（A Skill is a directory…）
- [ ] Skill 目录名仍是 id 稳定的 ASCII slug（`skillSlug()`），没有用中文库名；预载手势用的也是这个 slug。一定要生效的内容放进 Action 的 rule、工作流指令或全局默认指令，必定要用的技能由 Action 预载，不是靠模型「判断相关」；预载有 token 代价，编辑器旁的估算没有被拿掉

## 8. 测试（Checks / Test fixtures）

- [ ] e2e **没有**断言会随真实使用增长的东西：计数、首页包含、某一行恰好是种子 / 最新一次运行。正确写法是在用例里取 API 载荷、断言 DOM 与载荷一致。这个 bug 已经修过三次
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
