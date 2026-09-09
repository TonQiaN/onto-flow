# AGENTS.md

OntoFlow 是本机工作台：Action 通过工作流图编排，每次运行独占目录和 DeepSeek Harness 子进程，每个 Action 的每轮执行是独立会话。命名先读 [CONTEXT.md](CONTEXT.md)；其中 ADR-0010 的节点自带定义模型尚未实施，当前画布仍引用共享 Action。

## 开始工作

- 先核对分支、远端与 `git status`，保留用户已有修改；有交叉改动时用独立 worktree。命令一律在所用 checkout 的根目录运行，`data/` 按 `process.cwd()` 解析，换目录就换数据库。
- 按下表读取与任务有关的专题，并检查目标目录到仓库根之间的 `AGENTS.md`。从根目录启动不会保证自动加载所有深层指令；表内文档必须主动读取，跨模块任务读齐相关项。
- 先看当前源码、测试、package.json 与 CI，再引用设计或历史记录；发现文档过时，在同一改动中修正其权威位置。

| 修改范围 | 必读入口 |
| --- | --- |
| 页面、API、共享规则、数据库、写入、引用、修订 | [应用约束与目录导航](docs/development/application.md) |
| 全局/工作流设置、模型、Tool、Skill、预载 | [能力约束](docs/development/capabilities.md) |
| 图、调度、运行页面、快照、事件、业务结果、清理 | [运行约束](docs/development/runs.md) |
| Harness、RPC、会话、计费、取消、组合或依赖 | [Harness 接缝](docs/development/harness.md)；改组合另读 [上游审查规则](docs/harness/AGENTS.md) |
| 命令、CI、测试、夹具或付费验收 | [验证指南](docs/development/checks.md) |
| 文档、术语、ADR、技能或本指令 | [文档维护](docs/development/documentation.md) |
| PR 与代码评审 | [评审清单](.github/REVIEW.md)、[PR 模板](.github/pull_request_template.md) |

## 项目边界

- 不保留兼容层、旧路径、别名 API 或迁移文件；废弃子系统连表、API、组件一起删除。schema 直接改 [src/db/schema.ts](src/db/schema.ts)，用 `drizzle-kit push` 原地应用（ADR-0005）。
- `data/` 是 gitignored 的真实运行根；`.data/` 是无代码引用的私人残留，不读不写。`_reference/` 只作第三方源码参照，不 import、不编辑。
- 模型凭据只传环境变量名；值在启动子进程时取自 Next 进程环境，不写进组合、日志或运行目录。
- 不把工作流当 DAG：回边合法，汇总必须等所有入边收束；输入与节点间的实质内容走工作区文件，声明的产物必须实际存在（ADR-0008、ADR-0009、ADR-0012）。
- 一次运行在受理时冻结可执行定义和设置；Skill 内容是有意保留的活链接例外。运行互相独立，状态和资源按 runId 或运行目录归属；观察运行只去 `/runs/<id>`（ADR-0018）。
- 能力归属是全局基线 → 工作流声明 → Action 收窄；Action 不开关插件，模型不自行派生 agent，编排由图负责（ADR-0014、ADR-0016）。

## 常用命令与完成条件

Node 版本以 [.nvmrc](.nvmrc) 与 [package.json](package.json) 为准；干净安装用 `npm ci`。

```sh
npm run db:push     # 原地应用 schema
npm run db:seed     # 只装平台基线，不生成业务案例或运行历史
npm run dev         # 3592 端口
npm run check       # typecheck + lint + fmt:check + knip + vitest
npm run build       # Next 路由与配置检查
npx vitest run src/rules.test.ts
```

- 声明完成前必须跑 `npm run check`；触及 `src/app/`、`next.config.ts` 或 `tsconfig.json` 另跑 `npm run build`；用户可见改动跑对应的一个 e2e spec。
- 改指令或工程规则先跑 `npx vitest run src/rules.test.ts`；改组合跑 `npx vitest run src/server/harness/catalog.test.ts`。Harness 接缝改动至少跑 `smoke-harness`，或在 PR 写明可跳过的理由；付费命令和前提见验证指南。
- 单元测试不碰真实数据库：服务测试先经 `createTestDb()` 创建内存库并赋给 `globalThis.ontoflowDb`，再动态导入被测模块。e2e 自建并清理夹具，不断言真实数据会增长的计数、首行或种子字面量。
- e2e 不运行含 Action 的付费图，不点执行清理、确认删除或中止；清理只验 `dryRun`。复用 3592 服务前核对其 checkout，尤其在 worktree 中。
- PR 按模板说明行为变化、实际命令及结果、REVIEW 自查项；关联已有 Issue。合并前确认当前 PR 提交的 CI 门禁通过，合并后核对远端 main、PR 和关联 Issue 状态。

## 工程约束

- 用户可见字符串、错误、代码注释、测试名用中文，标识符用英文。注释解释行为、失败、时序与归属；保留说明绕行原因的注释，`any` 必须解释为何无法窄化。
- 客户端不从 `@/server` 或 `@/db` 导入，类型导入也不例外；共享类型与纯规则放 `src/lib/`。没有 Server Actions，页面从客户端经 `/api/*` 读写。
- API 都导出 `dynamic = "force-dynamic"`；HTTP 方法用函数声明，首句 `return handle(`；唯一例外是运行 events 的原始 SSE Response。
- 实体校验放 writer，名称冲突交数据库；写路径用共享 `WriteResult`，引擎抛错；实体写入与完整修订在同一事务，还原复用 writer。
- better-sqlite3 同步，不 `await db.*`。原生 SQL 只经 drizzle 的 `sql` 标签且仅在规则测试允许的位置；LIKE 用户输入转义。进程级可变状态放 `globalThis.ontoflow*`，防止 HMR 丢失。
- 五个库页复用 `src/components/library/`，筛选状态进 URL；库列表和运行列表共用分页参数，返回 `{ items, total, page, pageSize }`。引用查询与破坏性清理各有唯一归属，详见应用和运行约束。

## Code Review Rules

- 按 [.github/REVIEW.md](.github/REVIEW.md) 读取对应专题，只报告可定位到文件与行号的实质问题，说明触发条件与后果；不复述 diff、不夸奖。格式与可机械验证项交给 CI。
- 优先查跨边界的错误：受理后回查共享定义、重入串轮、取消与成功竞态、子进程未收束就释放目录、漏计用量、清理掉持久业务结果、修订遗漏关系。
- 没有可行动问题就明确说明，并如实列出验证缺口；不能把未跑的检查或旧提交上的 CI 当作本次证据。

## 维护本文件

根文件只放稳定、适用于整个仓库的操作规则与导航；详细契约、故障论证、版本/数量清单下沉到专题、源码、测试或 ADR。只写已经遵守的规则，未实施决定明确标注；不因一次偶发错误无条件加规则。

根文件含自动区块不得超过 **8 KiB**；新增先合并、删减或下沉。确需提高预算，在 Issue/PR 解释代价并同改规则测试。规则、专题、机械测试和人工评审条目在同一提交更新；格式和机械检查不再复制成人工清单。`CLAUDE.md` 是本文件的 symlink，只编辑 `AGENTS.md`；Next.js 自动区块保留并随改动提交。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
