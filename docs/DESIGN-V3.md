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
| 2 运行列表：信封、`source` 列、筛选与用量汇总 | `cleanup/2-runs-list` | — | 未开始 |
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
- **付费脚本**只在本文点名处跑（第 3 批收尾 `smoke-engine`）；跑之前先停 `next dev`——
  `reconcileOrphanRuns` 会把外部进程的 running 运行失败化。
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
- PR 只含格式改动：抽查 diff 无语义变化；`package.json` 与 `.oxfmtrc.json` 是仅有的非格式文件。
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

- `rm -f data/ontoflow.db && npm run db:push && npm run db:seed && npx playwright test` 全绿
  （与 CI e2e 作业同一起点）；`npm run check`、`npm run build` 通过。
- `npx tsx scripts/seed-resume.ts` 与 `seed-leetcode.ts` 各跑两遍无报错、pin 不变。
- `rg -n "purchase|采购|集采|归档文档" src scripts e2e docs README.md AGENTS.md` 只剩 ADR / 记录树里
  的历史陈述。

## 第 2 批：运行列表

**schema**：`runs.source: text("source").notNull().default("workflow")`；`startResolvedRun` 在
`runs` insert 里从 `invocation.source` 写入（`workflow` / `resume-match-api`），`imports.invocation`
原样保留（专用 GET 仍凭它核对来源证明）。

**API `GET /api/runs`**（`src/app/api/runs/route.ts`，仍在 raw-sql 允许名单）

- 参数：`workflowId`、`status`（四值之一，非法 400）、`source`（`^[a-z][a-z0-9-]*$`，非法 400）、
  `from` / `to`（epoch 毫秒整数，`startedAt ∈ [from, to)`，非法 400）、`page` / `pageSize`
  （从 `parseListQuery` 抽出 `parsePageQuery(url)` 共用：默认 30、上限 100）。
- 返回 `{ items, total, page, pageSize, summary }`：`items` 每行现有字段 + `source`，按
  `startedAt` 倒序；`summary = { runs, tokens, cost, byModel: [{ providerId, modelId, tokens, cost }] }`
  按同一组筛选（不分页）从 `runs` ⨝ `node_usage` 聚合。
- 现有数组消费者改读 `items`：`src/components/nav.tsx`（`?status=running&pageSize=100`）、
  `src/app/workflows/page.tsx`（同上）、`src/app/monitor/page.tsx`（最近失败；第 4 批整页删除，
  本批只改读法保持绿）。

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

**schema**：`runs.graph: text("graph", { mode: "json" })`（可空；早于本批的运行为 null）。形状定义在
`src/lib/run-graph.ts`（纯类型 + 校验函数）：

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
  `graph` 为 null 的旧运行显示「此运行早于图冻结，无画布」，时间轴与抽屉照常。
  `flow-node.tsx`、`flow-edge.tsx` 与 `types.ts` 里它们依赖的端口 / 配色工具移到
  `src/components/canvas/`，编辑器与运行页共用；节点视觉仍从 Context 读。
- **时间模型**：`src/app/runs/[id]/visuals-at.ts` 纯函数
  `visualsAt({ run, nodes, events, t })` → 每节点 `{ status, round, activity }`、每连线
  `{ state }`、总计；规则：`startedAt > t` 等待、`startedAt ≤ t < finishedAt` 运行中、
  `finishedAt ≤ t` 取终态；连线在上游 `finishedAt ≤ t` 且走的是该出口（`run_nodes.outputs` 含该
  端口）时激活；活动取 `ts ≤ t` 的最后一条 tool 与累计 text 字数；轮次边界沿用被删 `getTrace`
  的会话推导（搬为纯函数，保留其单测用例）。事件被清理后只剩节点级。单测 `visuals-at.test.ts`
  覆盖等待 / 运行中 / 终态 / 出口未走 / 事件缺失。
- **数据源**：现 `use-run-visuals.ts` 搬到 `src/app/runs/[id]/use-run-stream.ts`，只负责 SSE
  订阅（snapshot / log 去重 / 一次重连）与 1Hz `now`；视觉一律经 `visualsAt(t)`。进行中默认
  `t = now` 跟随，往回拖即暂停跟随，「跟随」按钮回到现在；已结束默认 `t = finishedAt`。
- **时间轴**（画布下方）：每个节点一行，按轮次分段的时间条（左 = 相对 `startedAt` 偏移，宽 =
  时长），事件作刻度；播放 / 暂停 / 倍速（1× / 10× / 60×）；拖动或点击某段设 `t`。
- **抽屉**（点节点打开，右侧）：错误置顶；三页签「轨迹 / 输入输出 / 快照」复用
  `agent-trajectory.tsx`、`port-value-view.tsx`、`snapshot-view.tsx`；轨迹组件加 `cursorMs`
  （高亮并滚到 `t` 所在记录，不过滤）与 `onSeek`（点记录设 `t`）。`node-card.tsx`、
  `event-log.tsx` 删除。
- **编辑器剥离**：`src/app/workflows/[id]/` 删除 `run-bar.tsx`、`use-run-visuals.ts`；`editor.tsx`
  去掉 `?runId=` 解析、`subscribeRun` / `switchRun`、`runsInFlight` 轮询、`RunVisualsProvider`；
  运行对话框成功后 `router.push('/runs/<runId>')`。导航「运行中」面板与工作流卡片深链改
  `/runs/<id>`；运行页不再有「回画布看动画」。
- **监控台 Trace 删除**：`src/app/monitor/trace/`、`src/app/api/monitor/trace/`、`getTrace` 与其
  单测（轮次推导部分先搬到 `visuals-at.ts` 再删）；layout 标签去掉 Trace。

**文档同步**：DESIGN.md「多路运行的界面契约」段整段替换为运行页契约，`/api/runs/[id]` 行加
`graph`；AGENTS.md Repository layout 里 `workflows/[id]/`、`runs/[id]/`、`monitor/` 三行改写，
`src/components/canvas/` 加行；CONTEXT.md 头注删去「回放 / 运行来源已定未实现」段；REVIEW.md §5
（多路界面）改写；`docs/simplifications/proposed/2026-09-03-editor-stops-following-runs.md` 移 `done/`。

**验收**

- `npm run check`、`npm run build`；单测 `visuals-at.test.ts`、`run-graph.test.ts`（构造与校验）。
- e2e：`runs.spec.ts` 夹具行带 `graph`，断言画布节点数与 `graph.nodes` 一致、点节点开抽屉且轨迹
  面板可检索（沿用现有轨迹用例）、时间轴行数与节点数一致、旧运行（`graph` 为 null）显示无画布
  提示；`parallel-ui.spec.ts` 改为：导航面板两路各深链 `/runs/<id>`，运行页概要栏状态为运行中、
  取消按钮指向正确的 run；`parallel-runs.spec.ts` 免费真跑后运行页画布节点全部成功、光标在末尾。
  `workflow-editor.spec.ts` 补一条：编辑器不再出现 `run-switcher` / 运行条元素。
- 付费：停掉 dev server 后跑一次 `npx tsx scripts/smoke-engine.ts`，确认真实运行的 `runs.graph`
  非空且运行页可回放；结论写进 PR。
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
