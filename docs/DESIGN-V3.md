# OntoFlow v3 实现契约：清理、运行页与工具链

2026-09-03 一次十八题 grilling 的执行契约。决策本身记在 [CONTEXT.md](../CONTEXT.md) 头注、
[ADR-0018](adr/0018-run-page-frozen-graph-replay.md)、[ADR-0019](adr/0019-oxc-toolchain-not-eslint.md)；
本文只写**怎么做、做到什么算完、不许碰什么**。任何会话接手都从「进度」表读起，做完一批就
更新那一行，再开下一批。

## 进度

| 批 | 分支 | PR | 状态 |
|---|---|---|---|
| 0 共识文档（CONTEXT 术语、ADR-0018/0019、本文） | `cleanup/0-consensus-docs` | #18 | 待合并 |
| 0a 格式化基线 | `cleanup/0a-format-baseline` | #19 | 待合并（stacked 于 #18） |
| 0b lint / knip / CI / 记录树 / skill / proposed 记录 | `cleanup/0b-toolchain-and-notes` | #20 | 待合并（stacked 于 #19） |
| 1 删采购演示与归档链条；seed 只种平台级；e2e 自建夹具 | `cleanup/1-remove-procurement` | #21 | 待合并（stacked 于 #20） |
| 2 运行列表：信封、来源读时推导、筛选与用量汇总 | `cleanup/2-runs-list` | #22 | 待合并（stacked 于 #21） |
| 3 运行页：`graph` 列、只读画布、回放、抽屉；编辑器剥离跟随 | `cleanup/3-run-page` | — | 未开始 |
| 4 监控台收口为系统健康一页 | `cleanup/4-monitor-health-only` | — | 未开始 |
| 5 `find-simplifications` 第一轮 | `cleanup/5-simplifications-round-1` | — | 未开始 |

顺序 0 → 0a → 0b → 1 → 2 → 3 → 4 → 5；1 与 2 互不依赖，可并行开发、按序合并；3 依赖 2；
4 依赖 2 与 3；5 依赖全部合并。每批一个 stacked PR，PR 正文按 `.github/pull_request_template.md`
三段必填，等 Codex 自动评审与（按需）`@claude` 评审后合并。

## 全局约束（每批都适用）

- **动手前 `git fetch` 并核对 HEAD**：本机可能有另一个会话在同一工作树里工作。每批从最新
  `main`（或它依赖的那批的分支）开分支，不在 `main` 上直接提交。
- **不做兼容层**（AGENTS.md「Stance」）：删就删干净——路由、页面、表、测试、README 段、DESIGN 行、
  REVIEW 行、`rules.test.ts` 断言一起走；不留别名、不留 fallback、不写迁移。schema 改动就是改
  `src/db/schema.ts` 后 `npm run db:push`。
- **三处同步**：AGENTS.md 里的规则变了，同一提交改 `src/rules.test.ts` 与 `.github/REVIEW.md`；
  DESIGN.md / DESIGN-V2.md 陈述的契约变了，同一提交改那份文档；术语定了改 CONTEXT.md。
  AGENTS.md 只陈述仓库**已经**遵守的规则：某批落地前，不把它的规则提前写进去。
- **CI 作业名不改**：`main` 的分支保护按作业名 `typecheck · vitest · build` 与 `playwright` 认必过
  检查，只在作业里加步骤。
- **付费脚本**只在本文点名处跑（第 3 批收尾的 `smoke-engine` 与 `smoke-graph` 两条）；跑之前先停
  `next dev`——`reconcileOrphanRuns` 会把外部进程的 running 运行失败化。
- **验收口径**：每批至少 `npm run check`（0b 起含 lint 与 fmt:check）+ `npm run build`（触及
  `src/app/` 时）+ 本批点名的 e2e spec；界面批次（2、3、4）另在真实 Chrome 里按「Chrome 验收」
  清单走一遍并把结论写进 PR。
- 文案中文、标识符英文；注释写行为 / 失败 / 时序 / 归属，不复述控制流；新页面 `"use client"` +
  `useEffect` 取数，无 Server Action；客户端不从 `@/server` / `@/db` 引运行时值。
- 关于删除的每一项，先 `rg` 确认没有本文没列出的消费者；有就补进本文再删。

## 第 0 批：共识文档

已在工作树里：CONTEXT.md 两条术语与头注、ADR-0018、ADR-0019、本文。单独一个只含文档的 PR
合并，让后续每批都能引用。验收：`npx vitest run src/rules.test.ts` 通过；PR 不含代码。

## 第 0a 批：格式化基线

**范围**

- `npm i -D -E oxfmt@0.66.0`（精确钉版，与 `@deepseek-ai` 同一做法；ADR-0019）。
- `.oxfmtrc.json`：`printWidth: 100`（oxfmt 默认；仓库现有代码 10% 的行超过 80 列、4% 超过
  100 列，取 100 让基线 diff 最小），其余取默认；`ignorePatterns` 排除 `_reference/`、`data/`、
  `.data/`、`.next/`、`node_modules/`、`playwright-report/`、`test-results/`、`docs/`、`*.md`
  ——Markdown 不进格式器，中文文档不因换行规则被改写。
- `package.json` 脚本：`"fmt": "oxfmt"`，`"fmt:check": "oxfmt --check"`。
- 跑一次 `npm run fmt`，把全仓格式改动作为**唯一一个提交**。

**验收**

- `npm run fmt:check` 退出码 0；`npm run check`、`npm run build` 通过；
  `npx playwright test e2e/workflow-editor.spec.ts` 通过。
- PR 只含格式改动：抽查 diff 无语义变化；`package.json`、`package-lock.json`（装 oxfmt 必然改）与
  `.oxfmtrc.json` 是仅有的非格式文件。
- 不改 AGENTS.md（门禁句在 0b 一起改）。

## 第 0b 批：lint、knip、CI、记录树、skill、proposed 记录

**lint**

- `npm i -D -E oxlint@1.81.0 oxlint-tsgolint@7.0.2001 knip@6.34.0`（`oxlint-tsgolint` 版本号跟
  TypeScript 7.0.2；升级 TypeScript 时同步换它）。
- `.oxlintrc.json`（带 `$schema: ./node_modules/oxlint/configuration_schema.json`）：
  `plugins: ["typescript", "react", "nextjs", "import"]`；`categories.correctness: "error"`；
  显式 error：`typescript/await-thenable`（机械化「never `await db.…`」）、
  `typescript/no-floating-promises`、`typescript/no-misused-promises`、`react/rules-of-hooks`、
  `react/exhaustive-deps`；`ignorePatterns` 同 `.oxfmtrc.json`（Markdown 不在 lint 范围，不必排除）。
  react 插件 correctness 类里的 **React Compiler 规则族**（`set-state-in-effect` / `purity` / `refs` /
  `immutability` / `preserve-manual-memoization`）在配置里显式 `off` 并写明理由：仓库的取数模式
  （`"use client"` + useEffect 里 fetch，AGENTS.md 规定）在 effect 里同步写 loading 态，34 处被判为
  级联渲染；采用 Compiler 的编程模型是另一个决定，不在门禁批次里顺手做。`.oxlintrc.json` 允许
  `//` 注释（已验证），每条关闭都带理由。
- `options.typeAware: true` 与 `options.maxWarnings: 0` 写在配置里，脚本只是 `"lint": "oxlint"`，
  编辑器插件与 CI 跑同一套。首轮把其余报告逐条修掉；确实是有意为之的（控制字符正则、测试里的
  `new Function` 装载种子源码）用行内 `// oxlint-disable-next-line <rule> -- 原因` 关闭，不整文件关闭。
- `npm run check` 改为 `npm run typecheck && npm run lint && npm run fmt:check && npm test`。
- CI `check` 作业（名字不变）在 `npm run typecheck` 后加 `npm run lint`、`npm run fmt:check` 两步。

**knip**

- `knip.json`：入口 `src/instrumentation.ts`、`src/server/harness/runner.ts`（子进程入口）、
  `src/server/harness/rpc/**`（组合按绝对路径装载）、`scripts/*.ts`；Next / Vitest / Playwright
  插件自动识别其余入口。脚本 `"knip": "knip"`。**不进 CI**：它是 `find-simplifications` 的线索
  工具，误报调零后（第 5 批）再提为门禁。

**记录树 `docs/simplifications/`**

- `README.md`：何时写（一个候选一份；skill 每轮产出即 proposed）、三种状态目录
  `proposed/` `done/` `rejected/`、文件名 `yyyy-mm-dd-slug.md`（slug 用英文短横线）、骨架、与
  ADR / AGENTS.md / PR 的分工（三条全中才写 ADR；否决理由只留在 rejected，不回流 AGENTS.md）、
  保留期（done 移入后只补 PR 链接与实际落地差异，此后冻结；rejected 保留到理由失效，skill 每轮
  审计：对象已不存在或理由已被后来的决定覆盖即删）、何时跑 skill（按需 + 每个里程碑收尾一轮）。
- 骨架（`rules.test.ts` 机械核对）：第 1 行 `# 简化：<动作式标题>`；第 3 行 `状态: proposed`
  / `状态: done` / `状态: rejected — <一句理由>`，与所在目录一致；正文依次含 `## 问题`、`## 提议`、
  `## 放弃了什么`、`## 验收`、`## 风险` 五节；`## 问题` 里生产消费者与测试 / 文档消费者分开列。
  done 记录另有 `## 落地`（PR 链接、与提议的差异）。
- 首批 `proposed/`（按已定决策写，第 1、3、4 批各自的 PR 合并时移到 `done/`）：
  `2026-09-03-delete-procurement-demo-and-archive-chain.md`、
  `2026-09-03-seed-platform-only-e2e-self-fixtures.md`、
  `2026-09-03-dismantle-monitor-console.md`、
  `2026-09-03-editor-stops-following-runs.md`（链接 ADR-0018）。

**skill `find-simplifications`**

- `.claude/skills/find-simplifications/SKILL.md` 与 `.codex/skills/` 字节一致副本。内容：起手读
  AGENTS.md、`docs/simplifications/`（已定与已否决）、相关 ADR；候选六类（无生产消费者的路由 /
  导出 / 配置项 / 表列、两处表示同一事实、无主人的投机通用性、只为未用 API 存在的防御与回滚、
  手写了依赖或 Node 内置已有的东西、加了又拆的残留）；语料分类（生产：`src/` 非测试文件、
  `scripts/seed*.ts` / `smoke-*.ts` / `run-*.ts`；非生产：`*.test.ts`、`e2e/`、`docs/`、README、
  注释；`_reference/` 永不计）；证据标准（`rg` 到调用点，knip 输出只是线索）；「已记录的理由
  优先」——候选必须打败 AGENTS.md / ADR / `docs/harness/` 里记录的那个理由，引用简化政策本身不算
  证据；点名四处高代价接缝（harness 接缝三个头注释、`monitor/cleanup.ts`、`resolveWorkflow` →
  `startResolvedRun` 的受理与冻结、技能投影的链接 + 版本目录原子换法），碰它们的候选验收必须含
  对应付费冒烟或 dryRun 证据；并行子 agent 分领域清点；产出 = 一批 `proposed/` 文件 + 一个
  只含文档的 PR；与内置 `/simplify`（只看当前 diff）的分工；每轮顺带审计 `rejected/`。

**文档同步**

- AGENTS.md：Commands 块加 `lint` / `fmt` / `fmt:check` / `knip`；Checks 里「There is no git hook,
  no linter, and no formatter」改为新门禁的陈述并引 ADR-0019；`npm run check` 的描述改序；
  docs 目录行加 `DESIGN-V3.md` 与 `simplifications/`；「all four skills」改五个；Decisions 节加一句
  指向 `docs/simplifications/README.md`。REVIEW.md §0 加 lint / fmt 两项，§10 加记录树一行。
  `rules.test.ts` 加记录树骨架断言，skills 双树断言的标题同步改五个。

**验收**

- `npm run check`（含新 lint / fmt）本地与 CI 全绿；`npm run build` 通过；
  `npx vitest run src/rules.test.ts` 含记录树断言且通过；`npm run knip` 能跑（退出码不作要求，
  输出记进 PR 描述作为第 5 批的起点）；`npx playwright test e2e/settings.spec.ts` 通过。
- `diff -r .claude/skills .codex/skills` 为空。

## 第 1 批：删采购演示与归档链条；seed 只种平台级；e2e 自建夹具

**删除清单**（每项先 `rg` 复核消费者）

- 页面与 API：`src/app/documents/`、`src/app/api/documents/`、`src/components/nav.tsx` 的
  「归档文档」项。
- 表：`src/db/schema.ts` 的 `purchasePlans`（`db:push`）；`src/server/writers/test-db.ts` 的
  `DELETE FROM purchase_plans`；`src/server/writers/tool.test.ts` 的夹具改成中性名字。
- 种子：`scripts/seed.ts` 只保留 ① 内置对象类型（text / file / json）与 ③ 模型表；②④⑤⑥⑦⑧⑨⑩
  （案例对象类型、Skill、Tool、Action、工作流、文件夹、v1 修订、示例需求文件）与
  `SAVE_PURCHASE_PLAN_*` 全部删除；`scripts/run-procurement.ts`、`scripts/purchase-plan-path.test.ts`
  删除；`data/samples/采购需求示例.txt` 不再写出。`seed-resume.ts` / `seed-leetcode.ts` 不动
  （它们只依赖模型表与内置类型），跑两遍仍幂等、pin 不变。
- 系统健康页磁盘行里 `data/documents` 一行删除（`src/app/monitor/health/`、`src/server/monitor/disk.ts`
  以实际出现处为准）。
- e2e：`e2e/documents.spec.ts` 删除；`actions` / `library-v2` / `object-types` / `skills` / `tools` /
  `workflow-editor` / `workflow-settings` 七个 spec 改为 `beforeAll` 经 API 自建 `e2e-` 前缀夹具
  （对象类型、Skill、Tool、带端口 / 预载 / 可见 Tool 的 Action、文件夹树、带节点与连线的工作流），
  `afterAll` 经 `cleanupByPrefix` 与 `cleanupRevisions` 删除；公共构造函数进 `e2e/helpers.ts`。
  `monitor.spec.ts` 里 `data/documents 归档` 那条断言随磁盘行删除。断言只对 API 载荷或自建夹具，
  不对计数与首页包含（AGENTS.md「Never assert a count…」）。

**文档同步**

- README：「启动」段 `db:seed` 注释改「平台基线（内置对象类型与模型）」；演示段改为先
  `npx tsx scripts/seed-resume.ts` 再进「简历匹配评分」；删除采购四步与归档段落。
- DESIGN.md：删 `/api/documents` 行与「首个案例种子」节；AGENTS.md：Commands 里 `db:seed` 注释与
  `run-procurement` 行、Repository layout 的 `documents/` 行、「Test fixtures cost money」整节改写为
  「seed 只种平台级；每个 spec 自建夹具；运行历史由 `run-resume` / `run-leetcode` 重建」；REVIEW.md §8
  同步。`docs/simplifications/proposed/` 的两份记录移到 `done/` 并补 `## 落地`。

**验收**

- 与 CI e2e 作业同一起点的全量 e2e 全绿：**不要删 `data/ontoflow.db`**（它装着付费重建的运行历史与
  持久业务结果）。在另一个 worktree（`git worktree add ../ontoflow-e2e <分支>`，其 `data/` 为空）里
  `npm run db:push && npm run db:seed && npx playwright test`，跑之前停掉 3592 上的 dev server
  （playwright 会附着到已监听的进程，那是主工作树的数据库）；或先把 `data/ontoflow.db` 连同
  `-wal` / `-shm` 备份到 `data/backups/<时间戳>/`、跑完恢复。`npm run check`、`npm run build` 通过。
- `npx tsx scripts/seed-resume.ts` 与 `seed-leetcode.ts` 各跑两遍无报错、pin 不变。
- `rg -n "purchase|采购|集采|归档文档" src scripts e2e docs README.md AGENTS.md` 只剩 ADR / 记录树里
  的历史陈述。

## 第 2 批：运行列表

**来源不加列**：受理来源已经是 `runs.imports.invocation.source`（`workflow` / `resume-match-api`，
专用 GET 凭它核对来源证明），再加一列是同一事实的第二份表示，回填历史行又是仓库不做的迁移。
`GET /api/runs` 的 `items[].source`、`source=` 筛选与 `summary` 一律读时推导：
`coalesce(json_extract(runs.imports, '$.invocation.source'), 'workflow')`——没有 `invocation` 的行只能
是调用入口出现之前由画布发起的，coalesce 是语义不是兼容。该文件本就在 raw-sql 允许名单里；
`runs` 表只有几千行量级，不需要索引。schema 不动。

**API `GET /api/runs`**（`src/app/api/runs/route.ts`，仍在 raw-sql 允许名单）

- 参数：`workflowId`、`status`（四值之一，非法 400）、`source`（`^[a-z][a-z0-9-]*$`，非法 400）、
  `from` / `to`（epoch 毫秒整数，`startedAt ∈ [from, to)`，非法 400）、`page` / `pageSize`
  （从 `parseListQuery` 抽出 `parsePageQuery(url)` 共用：默认 30、上限 100）。
- 返回 `{ items, total, page, pageSize, summary }`：`items` 每行现有字段 + `source`，按
  `startedAt` 倒序；`summary = { runs, tokens, cost, byModel: [{ providerId, modelId, tokens, cost }] }`
  按同一组筛选（不分页）聚合：`runs` 是筛选集里 **distinct** 的 `runs.id` 数（零用量的运行——
  免费的输入→输出工作流、首次模型调用前就失败的运行——也算），`tokens` / `cost` 与 `byModel` 来自
  按 `run_id` 预聚合的 `node_usage` 子查询 **left join** 到筛选集，不能用内连接把无用量的运行挤掉。
- 现有数组消费者**全部**改读 `items`，每个 stacked PR 都必须自己能跑：`src/components/nav.tsx`
  （`?status=running&pageSize=100`）、`src/app/workflows/page.tsx`（同上）、`src/app/monitor/page.tsx`
  （最近失败）、`src/app/monitor/trace/page.tsx`（运行下拉）、`src/app/monitor/logs/page.tsx`（运行
  筛选下拉）、`src/app/workflows/[id]/editor.tsx`（`runsInFlight` 轮询）——后四者在第 3、4 批才删除，
  本批只改读法保持绿。合并前 `rg -n '"/api/runs' src` 逐个核对没有漏网的数组读法。

**页面 `/runs`**（`src/app/runs/page.tsx` 重写）

- 顶部筛选：工作流选择器（`GET /api/workflows` 列表，默认全部）、状态、来源（全部 / 画布发起
  `workflow` / 调用入口 = 其余值，按值分组显示）、时间范围（起止日期，转 epoch 毫秒）。
- 全部筛选与页码住 URL（`?workflowId=&status=&source=&from=&to=&page=`），与库页面
  `use-library-query` 同一习惯（可抽公共 hook，不复制）。
- 表格列：id（前 8 位，链接 `/runs/<id>`）、状态、开始时刻、耗时、节点进度、token、费用、来源；
  分页控件；表上方一行 `summary`（运行数、token、费用）与「按模型」小表。
- 工作流卡片「历史」与运行页「该工作流全部运行」都只是带 `workflowId` 的链接。

**监控台成本页随之删除**：`src/app/monitor/cost/`、`src/app/api/monitor/cost/`、`getCost` 与其单测，
监控台 layout 标签去掉「成本分析」，`monitor.spec.ts` 的成本用例删除。

**文档同步**：DESIGN.md `/api/runs` 行改信封与参数；AGENTS.md「All five library list GETs return…」
改为「五个库与 `/api/runs`…」并保持 `rules.test.ts` 的信封 import 断言覆盖；监控台描述里去掉成本
页；REVIEW.md §4。CONTEXT.md 头注里「运行来源」不再是未实现（「回放」保留到第 3 批）。

**验收**

- `npm run check`、`npm run build`；`npx playwright test e2e/runs.spec.ts e2e/parallel-ui.spec.ts e2e/monitor.spec.ts`
  通过——`runs.spec.ts` 新增：自建两条不同 `source` 的 running / success 夹具行，页面按来源、
  状态、时间范围筛选后的行与 `/api/runs` 载荷一致，`summary` 与载荷一致；翻页按载荷断言。
- Chrome 验收：切换工作流、状态、来源、日期后 URL 与表格同步变化；刷新不丢筛选；分页可用；
  汇总行随筛选变化。

## 第 3 批：运行页

**schema（三处）**

1. `runs.graph: text("graph", { mode: "json" }).notNull().default(<空图>)`，空图即
   `{ "version": 1, "nodes": [], "edges": [] }`：`db:push` 给早于本批的运行填空图，它们在运行页就是
   一张没有节点的画布——同一条渲染路径，**没有**「旧运行」分支（AGENTS.md「Stance」）。要看旧运行的
   过程只能靠抽屉的轨迹与节点列表；不想留就用系统健康页的清理删掉。形状定义在
   `src/lib/run-graph.ts`（纯类型 + 校验函数），见下。
2. 新表 `run_node_rounds`：一轮执行一行——`{ id, runId, nodeId, round（0 起）, sessionId, status
   （running / success / failed / cancelled / skipped）, startedAt, finishedAt, exitName（本轮所走出口；
   无具名出口为 null）, error, inputs, outputs, snapshot }`，唯一键 `(run_id, node_id, round)`，随 `runs`
   级联删除。`inputs` / `outputs` / `snapshot` 是这一轮自己的 PortValue 映射与运行快照（`runOne` /
   `action.ts` 今天写进 `run_nodes` 的同一份内容，快照里含本轮真实生效的产物路径与出口归属）——
   重入会覆盖 `run_nodes` 上的这三列，抽屉的「输入输出」「快照」页签必须读光标所在那一轮的行，
   否则光标停在第 1 轮时看到的是最后一轮的东西。引擎在一轮开始时 insert（running + `inputs` +
   `snapshot`）、结束时 update 终态、`finishedAt`、`exitName`、`outputs`、`error`。**必须有它的原因**：
   `run_nodes` 一个节点只有一行，回边重入会覆盖它的 `startedAt` / `finishedAt` / `outputs` /
   `sessionId` / `snapshot`，只看 `run_nodes` 回放不出「第 1 轮走了打回、第 2 轮走了通过」。
   `run_nodes` 继续作为节点的**最新状态**行（运行列表与汇总读它；抽屉的三个页签一律读光标所在轮的
   轮次行，不读它），不再承担轮次历史。
   **每个节点的每一次执行都是一行，不只 Action**：输入节点、输出节点在 `runner.ts` 里直接落成
   success，被跳过的节点落成 skipped，它们从不进 `action.ts`，但 `reenter()` 重置的是回边下游的
   **所有**节点——评审循环里输出节点会在打回的那轮被跳过、在通过的那轮成功，同一节点两次转换。
   所以 `runner.ts` 在给任何节点写 success / skipped 时同样 insert 一行轮次（`sessionId` /
   `inputs` / `outputs` / `snapshot` 为 null，`startedAt` = `finishedAt` = 落态时刻，`round` 随重置递增），
   Action 节点的轮次行由 `action.ts` 写。回放只看轮次行，`run_nodes` 只提供终态覆盖；早于本批的运行
   没有轮次行，节点恒为等待——同一条规则，没有旧数据分支。**每条终态路径都要收口轮次行**：一轮正常结束由 `action.ts` 写终态；`runActionNode` 抛出（超时、
   缺结构化输出、声明的产物不在盘上、会话关闭失败）时 `runner.ts` 的 catch 把 `run_nodes` 写成 failed，
   同一处也要把这一轮的轮次行写成 failed 并补 `finishedAt` 与 error；`cancelRun`、
   `failWholeRun`、`reconcileOrphanRuns` 今天直接改 `run_nodes`，本批同时把该运行里仍为 running 的轮次
   行写成对应终态（cancelled / failed）并补 `finishedAt`，否则回放里会有一段永远在跑的会话；这三条
   路径还会把仍为 pending 的 `run_nodes` 批量改成 skipped（`runner.ts` 与 `reconcile.ts`），它们同样
   要为每个这样的节点 insert 一行零时长的 skipped 轮次（`startedAt` = `finishedAt` = 落态时刻），
   否则回放到末尾这些节点还是等待。`runner.test.ts` 为五条路径各补一条断言（正常结束、Action 抛出、cancel、failWholeRun、
   reconcile：收口 running 的行 + 为 pending 的节点写 skipped 行）。**重入耗尽**（`onExhausted: "fail"`）不是一轮：`reenter()`
   把 `run_nodes` 写成 failed 时必须同时把 `run_nodes.finishedAt` 写成耗尽时刻并留下 error，回放据此
   在最后一轮成功之后的那个时刻把节点翻成失败（见下面的推导规则）。
3. `run_events.session_id: text`：`events.ts` 的通用落库从 `ctx.sessionId` 写入；`action.ts` 里
   `refreshUnsettledUsageRollup()` 自己插的 `usage` 事件（`usageEventPayload()` 已带该会话 id）也
   必须写这一列——两处插入点都改，别只改一处。事件从此能归到轮（会话 id 在第 0 轮是节点 id，之后是
   `<节点id>#<轮次+1>`，见 `engine/action.ts`）。列保持可空只是为了早于本批的历史行；新写入的事件
   没有一条允许为 null，`runner.test.ts` 断言之。

**数据路径**：`GET /api/runs/[id]` 返回 `{ run, nodes, rounds }`；SSE `/api/runs/[id]/events` 的
`snapshot` 帧同样带 `rounds`（轮次行有变化就重发 snapshot，与 `nodes` 同一指纹），`log` 帧就是带
`sessionId` 的 `run_events` 行。运行状态只从这两处取；抽屉的轨迹页签仍按需调用现有的
`GET /api/runs/[id]/nodes/[nodeId]/trajectory`（会话 JSONL 是轨迹的权威源，事件表里没有它），
这条接口保留不动。

事件清理（`cleanup.ts` 的 events 目标）不删 `run_node_rounds`——它每行几十字节，是回放退化后仍要
保留的骨架。运行清理（`cleanRuns()`）与单条删除随 `runs` 级联删掉轮次行，所以 `cleanup.ts` 的
`detailStat` 影响面统计与预览文案要加上 `run_node_rounds` 的行数（今天只报 `run_nodes` /
`run_events` / `node_usage` / `run_results`），`cleanup.test.ts` 补断言：dryRun 报出的行数与真删一致。

```ts
interface RunGraph {
  version: 1;
  nodes: Array<{ id: string; kind: "action" | "input" | "output"; label: string; x: number; y: number;
                 actionId: string | null; objectTypeId: string | null;
                 inputs: ResolvedPort[]; outputs: ResolvedPort[] }>;
  edges: GraphEdge[];
}
```

`startResolvedRun` 从 `resolved.nodeRows`（kind / label / x / y / actionId / objectTypeId）与
`resolved.nodes` 的端口构造它，与 `runs` 行同一事务写入。`GET /api/runs/[id]` 返回它。

**页面 `/runs/[id]`**（重写 `src/app/runs/[id]/page.tsx`，三段式）

- **概要栏**：状态、工作流名、id、开始时刻、耗时、token、费用、来源、工作区路径、取消按钮
  （running 时）、错误摘要；「设置快照」折叠面板（复用 `settings-snapshot-view.tsx`）；链接
  `/runs?workflowId=`。
- **画布**：只读 React Flow（不可拖、不可连线、可点选、初始 fitView），节点与连线来自 `runs.graph`；
  空图就是空画布，不另写提示分支。
  `flow-node.tsx`、`flow-edge.tsx` 与 `types.ts` 里它们依赖的端口 / 配色工具移到
  `src/components/canvas/`，编辑器与运行页共用；节点视觉仍从 Context 读。
- **时间模型**：`src/app/runs/[id]/visuals-at.ts` 纯函数
  `visualsAt({ run, nodes, rounds, events, t })` → 每节点 `{ status, round, activity }`、每连线
  `{ state }`、总计。节点在 `t` 时刻的状态取**该节点在 `t` 之前最后开始的那一轮**：
  `startedAt > t` 等待、`startedAt ≤ t < finishedAt` 运行中、`finishedAt ≤ t` 取该轮终态；没有任何
  轮次行的节点恒为等待。在此之上叠加**节点终态覆盖**：`run_nodes.status` 为 failed / cancelled 且
  `run_nodes.finishedAt ≤ t` 时节点按该终态画（重入耗尽、整运行失败、取消都落在这条规则上）。
  连线在上游节点于 `t` 之前最后开始的那一轮已成功、且该轮 `exitName` 等于连线源端口的出口
  （无具名出口、以及输入节点，全部输出端口生效）时激活；活动取 `session_id` 属于当前轮且 `ts ≤ t` 的最后一条 tool 与累计 text 字数。
  事件被清理后只剩轮次级。单测 `visuals-at.test.ts` 覆盖等待 / 运行中 / 终态 / 出口未走 /
  两轮回边（第 1 轮打回、第 2 轮通过，`t` 落在两轮之间时连线与状态取第 1 轮）/ 重入耗尽（最后一轮
  成功、节点在耗尽时刻翻成失败）/ 取消中途的轮次已收口 / 输入→输出免费运行（两个节点各一行轮次、
  都成功、连线激活）/ 评审循环里输出节点先跳过后成功（两行轮次，`t` 在两轮之间时为已跳过）/
  事件缺失 / 早于轮次表的运行全部等待。`runner.test.ts` 断言回边重入让输出节点得到两行轮次。
- **数据源**：现 `use-run-visuals.ts` 搬到 `src/app/runs/[id]/use-run-stream.ts`，只负责 SSE
  订阅（snapshot / log 去重 / 一次重连）与 1Hz `now`；视觉一律经 `visualsAt(t)`。进行中默认
  `t = now` 跟随，往回拖即暂停跟随，「跟随」按钮回到现在；已结束默认 `t = finishedAt`。
- **时间轴**（画布下方）：每个节点一行（行来自 `run_nodes`，按 `startedAt` 排序；行名可点击，打开
  该节点的抽屉——这也是早于本批、画布为空的运行进入抽屉的入口），一轮一段（段来自
  `run_node_rounds`；左 = 相对 `startedAt` 偏移，宽 = 时长；没有轮次行的节点这一行没有段），事件按
  `session_id` 落在所属段上作刻度；播放 / 暂停 / 倍速（1× / 10× / 60×）；拖动或点击某段设 `t`。
- **抽屉**（点节点打开，右侧）：错误置顶；三页签「轨迹 / 输入输出 / 快照」读**光标所在那一轮**的
  `run_node_rounds` 行（轨迹页签按该轮会话 id 定位到对应会话），复用
  `agent-trajectory.tsx`、`port-value-view.tsx`、`snapshot-view.tsx`；轨迹组件加 `cursorMs`
  （高亮并滚到 `t` 所在记录，不过滤）与 `onSeek`（点记录设 `t`）。`node-card.tsx`、
  `event-log.tsx` 删除。
- **编辑器剥离**：`src/app/workflows/[id]/` 删除 `run-bar.tsx`、`use-run-visuals.ts`；`editor.tsx`
  去掉 `?runId=` 解析、`subscribeRun` / `switchRun`、`runsInFlight` 轮询、`RunVisualsProvider`；
  运行对话框成功后 `router.push('/runs/<runId>')`。导航「运行中」面板与工作流卡片深链改
  `/runs/<id>`；运行页不再有「回画布看动画」。
- **监控台 Trace 删除**：`src/app/monitor/trace/`、`src/app/api/monitor/trace/`、`getTrace` 与其
  单测；layout 标签去掉 Trace。它按节点只画最后一轮，轮次表落地后没有它能画而运行页画不了的东西。

**文档同步**：DESIGN.md「多路运行的界面契约」段整段替换为运行页契约，`/api/runs/[id]` 行加
`graph`；AGENTS.md Repository layout 里 `workflows/[id]/`、`runs/[id]/`、`monitor/` 三行改写，
`src/components/canvas/` 加行；CONTEXT.md 头注删去「回放 / 运行来源已定未实现」段；REVIEW.md §5
（多路界面）改写；`docs/simplifications/proposed/2026-09-03-editor-stops-following-runs.md` 移 `done/`。

**验收**

- `npm run check`、`npm run build`；单测 `visuals-at.test.ts`、`run-graph.test.ts`（构造与校验）、
  `runner.test.ts` 补「回边重入写出两行轮次、事件带会话 id」。
- e2e：`runs.spec.ts` 夹具行带 `graph`，断言画布节点数与 `graph.nodes` 一致、点节点开抽屉且轨迹
  面板可检索（沿用现有轨迹用例）、时间轴行数与 `run_nodes` 数一致、段数与轮次行数一致、旧运行
  （空图、无轮次行）仍能从时间轴行名打开抽屉看轨迹；`parallel-ui.spec.ts` 改为：导航面板两路各深链 `/runs/<id>`，运行页概要栏状态为运行中、
  取消按钮指向正确的 run；`parallel-runs.spec.ts` 免费真跑后运行页画布节点全部成功、光标在末尾。
  `workflow-editor.spec.ts` 补一条：编辑器不再出现 `run-switcher` / 运行条元素。
- 付费：停掉 dev server 后跑一次 `npx tsx scripts/smoke-engine.ts`，确认真实运行的 `runs.graph`
  非空、`run_node_rounds` 每个 Action 一行、运行页可回放；再跑 `npx tsx scripts/smoke-graph.ts`
  验证回边重入产生多行轮次且回放能逐轮切换；结论写进 PR。
- Chrome 验收：打开一条已结束运行，拖光标看节点由等待→运行中→终态、连线随之激活；点节点看三页签，
  拖光标时轨迹高亮跟着走，点轨迹记录光标跳过去；用免费的输入→输出工作流发起一次运行，跳到运行页后
  看直播跟随、往回拖暂停、「跟随」回到现在；导航「运行中」面板深链到运行页。

## 第 4 批：监控台收口

**删除**：`src/app/monitor/page.tsx`（总览）、`sessions/`、`logs/`、`layout.tsx`（暗色外壳）、
`use-monitor-stream.ts`、`ui.tsx` 中健康页不用的原语；`src/app/api/monitor/{overview,sessions,stream,logs}/`；
`src/server/monitor/metrics.ts` 与 `metrics.test.ts` 整体（成本、Trace 已在前两批搬走或删除）；
`types.ts` 只留健康与清理的类型。

**保留并归位**：`src/app/monitor/health/page.tsx` 成为 `src/app/monitor/page.tsx`，用工作台普通外壳
（zinc 浅色，与库页面一致）；引擎 / 数据库 / 磁盘 / 孤儿运行 / 孤儿实体 / 清理面板（dryRun 预览）
原样；`/api/monitor/health` 与 `/api/monitor/cleanup` 是仅剩的两条监控路由。导航底部「监控台」改名
「系统健康」，运行中的绿点与计数保留（来自 `/api/runs`）。

**文档同步**：AGENTS.md Repository layout 的 `monitor/` 两行、raw-sql 允许名单去掉 `metrics`、
「The plugin panel…」等处提到监控台标签的句子、「The eight `/api/monitor/*` routes」改两条；
`rules.test.ts` 允许名单同步；DESIGN.md 相关句；REVIEW.md；
`docs/simplifications/proposed/2026-09-03-dismantle-monitor-console.md` 移 `done/`。

**验收**：`npm run check`、`npm run build`；`monitor.spec.ts` 只剩导航（入口进 `/monitor`，无标签）
与系统健康用例，全绿；`rg -n "monitor/(overview|sessions|stream|logs|trace|cost)" src e2e docs`
无结果。Chrome：系统健康页三块卡片渲染、清理面板三项 dryRun 预览成功。

## 第 5 批：`find-simplifications` 第一轮

在干净的 `main` 上跑 skill（并行子 agent 分领域：harness 接缝、引擎、API 路由、页面、写入器与
库、测试与脚本），产出 `docs/simplifications/proposed/` 一批文件 + 只含文档的 PR；用户逐条拍板后，
每个采纳的候选一个实施 PR；否决的移 `rejected/`。knip 的误报在本轮调零后，把 `npm run knip` 加进
CI `check` 作业并在 AGENTS.md 门禁句里补上。

## 总验收（第 4 批合并后）

- `main` 上 CI 两个作业全绿；本地 `npm run check && npm run build && npx playwright test` 全绿。
- CONTEXT.md 头注只剩 ADR-0010 一段；`docs/simplifications/` 有四份 `done/`。
- 记忆文件 `cleanup-and-run-page-plan` 更新为「已完成，第 5 批待跑」。
