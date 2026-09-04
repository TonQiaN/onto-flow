# 简化：删掉 run_nodes 的 inputs / outputs / snapshot 三列，重载荷只留轮次行

状态: done

## 问题

[DESIGN-V3](../../DESIGN-V3.md) 第 3 批「保留策略」段自己写着：「`run_nodes` 上的这三列与轮次行是同一
事实的两份表示，**留给第 5 批作为简化候选**（trajectory 接口的技能名映射改读轮次行后即可删）」。本条
兑现它。

**写侧——同一份内容写两处，作者已承认：**

| 列 | `run_nodes` 写入点 | 时机 | 轮次行的对应写入 |
|---|---|---|---|
| `inputs` | `src/server/engine/runner.ts:927-932` `updateRunNode({ status:"running", startedAt, inputs: nodeInputs, error:null })` | 每次 `runOne` 调度输出节点与 Action 节点 | `action.ts:149-157` `beginRound({ inputs })`；`runner.ts:869-878` `settleRound({ inputs: ownRound.inputs })` |
| `outputs` | `runner.ts:861-866` `onNodeSuccess` → `updateRunNode({ status:"success", outputs, finishedAt })` | 每个节点每次成功 | `action.ts:297-305` `settleRoundIfRunning({ outputs })`；`runner.ts:869-878` `settleRound({ outputs })` |
| `snapshot` | `action.ts:391-400` `writeSnapshot()` | 只有 Action，每轮一次，**与 `attachRoundSnapshot` 在同一个 `db.transaction`** | `rounds.ts:96-102` `attachRoundSnapshot` |

`writeSnapshot` 的注释就写着「快照落到两处：run_nodes 的那一列（节点的最新状态）与本轮的
run_node_rounds 行」。

**生产消费者（`rg -an 'runNodes' src scripts --glob '!*.test.ts'` 逐条核过）：**

- `run_nodes.inputs`：**零个**。`src/server/run-rounds.ts:38-54` 的 `NODE_SKELETON_COLUMNS` 刻意不选它；
  `rg -n "\.inputs\b" src --glob '!*.test.ts'` 剩下的全是端口 / 图的 `inputs`，不是这一列。
- `run_nodes.outputs`：**两个**——`src/server/resume-match.ts:719-724`（完成门禁
  `outputFile(outputNode?.outputs?.value)`）、`scripts/smoke-engine.ts:212`（`if (n.outputs) console.log(...)`）。
- `run_nodes.snapshot`：**一个**——`src/app/api/runs/[id]/nodes/[nodeId]/trajectory/route.ts:49`
  `skillNames: snapshotSkillNames(node.snapshot)`，只取 `snapshot.skills[].{slug,name}` 这张映射表。
- 为这份副本付的税：`src/server/run-rounds.ts:38-54` 的 `NODE_SKELETON_COLUMNS` 存在的唯一理由是
  「`select` 时把这三列摘掉」（同文件 33-37 行注释）；`src/server/monitor/cleanup.ts:163-176` 的
  `nodeStat` 统计与 `:196-200` 的 `update run_nodes set inputs = null, outputs = null, snapshot = null`
  是仓库唯一破坏性路径上多出来的一条统计加一条 UPDATE。

**测试 / 文档消费者：** `src/server/monitor/cleanup.test.ts:34,277,296,313,334`（DDL + 两条用例，其中
`:296` 是 `run_nodes.inputs` 今天仅有的读者）、`e2e/helpers.ts:546`、`e2e/runs.spec.ts:382-384`、
`src/server/resume-match.test.ts:1043,1048,1214,1219,1239,1255`、`src/server/engine/action.test.ts:41`、
`runner.test.ts:118`；`AGENTS.md:163` 三处从句、`.github/REVIEW.md` §3 第 4、5 条、`docs/DESIGN.md:43`、
`docs/DESIGN-V2.md:16`。

## 提议

- `src/db/schema.ts:421-425,434-436` 删三列（`db:push` 原地生效，无迁移文件）。
- `runner.ts:927-932` 与 `:861-866` 两处 `updateRunNode` 去掉 `inputs` / `outputs` 字段（`status` /
  `startedAt` / `finishedAt` / `error` 保留）；`action.ts:391-400` 的 `writeSnapshot()` 整个消失，调用点
  `:204` 改成直接 `attachRoundSnapshot({ runId, nodeId, round }, json)`，`db.transaction` 包装不再需要
  （只剩一次写），并删掉「快照落到两处」那句注释。
- `trajectory/route.ts:49`：技能名映射改读该节点轮次行的 `snapshot`（取轮次最大且非 null 的一行）——
  技能集在受理时冻结、各轮同源；被清理置空时退回 slug，与 `AGENTS.md:163` 已承认的「a blanked snapshot
  costs the trajectory panel its skill-name mapping and it falls back to slugs, which is the accepted
  price」是同一句，无新行为。
- `resume-match.ts:719-724`：改读该输出节点**最后一轮成功**的 `run_node_rounds.outputs`（`onNodeSuccess`
  用同一个 `state.outputs` 写两处，等价）。
- `scripts/smoke-engine.ts:212`：改读轮次行，或删掉这行打印。
- `run-rounds.ts`：删 `NODE_SKELETON_COLUMNS`（38-54）与它上方的注释（33-37），`listNodeSkeletons` 回到
  `db.select().from(runNodes)`——列都没了，「骨架 vs 重载荷」的分界在 `run_nodes` 上不再需要解释。
- `cleanup.ts`：删 `nodeStat` 查询（163-176）、`update run_nodes`（196-200）、`nodes` 变量与 `:181` 的
  `count + rounds + nodes > 0` 判据，`:212-215` 的预览文案收成只报轮次行；`cleanup.test.ts` 删对应 DDL 列
  与 `run_nodes` 断言。
- 逐句点名的文档改动：`AGENTS.md:163` 删三处从句（「`run_nodes`' three payload columns are a copy of the
  latest round anyway…」「and the trajectory route still reads `node.snapshot` server-side」「**and**
  `run_nodes` rows — the three columns on `run_nodes` are a copy of the latest round…」）；
  `.github/REVIEW.md` §3 第 4、5 条同改；[DESIGN-V3](../../DESIGN-V3.md) 第 3 批「保留策略」段的两处
  「与 `run_nodes`」与末句「留给第 5 批作为简化候选」；`docs/DESIGN.md:43`；`docs/DESIGN-V2.md:16`；
  `src/db/schema.ts:422-425` / `:434` 的列注释与 `:446-448` 轮次表头注释里的「回边重入会覆盖它的…快照」表述。

## 放弃了什么

「一条 SQL 取到某节点最新一轮的输入输出与快照」的便利：完成门禁与 trajectory 路由各要多一次按轮排序
的查询；排查一次运行不能只 `select * from run_nodes`，得 join 轮次行（`scripts/smoke-engine.ts` 的打印
就是这一类）。

## 验收

- `npm run check`、`npm run build`。
- `npx vitest run src/server/monitor/cleanup.test.ts`——**唯一破坏性路径的证据**：现有断言「dryRun 报出的
  行数与真删一致」（`cleanup.test.ts:248` `expect(deleted.detail).toBe(preview.detail)`）必须在删掉
  `nodeStat` 后仍成立；把 `:332-335` 那条 `run_nodes` 断言换成「轮次行置空即全部置空，没有第二处副本残留」。
- `npx vitest run src/server/engine/runner.test.ts src/server/engine/action.test.ts src/server/resume-match.test.ts`；
  `resume-match.test.ts` 补一条「输出节点两轮、第 1 轮 skipped 第 2 轮 success」的用例。
- `npx playwright test e2e/runs.spec.ts e2e/monitor.spec.ts`。
- **付费冒烟（踩 harness 接缝 `action.ts` 的快照写入，与受理 / 冻结的完成门禁）**：停掉 dev server 后
  `npx tsx scripts/smoke-engine.ts`（轮次行 outputs 完整、抽屉三页签正常）与 `npx tsx scripts/smoke-graph.ts`
  （回边多轮下抽屉按轮取到各自的输入输出）；简历入口改了读法，`npx tsx scripts/run-resume.ts` 也跑一次并
  核对 `run_results` 内容与 SHA 不变。三次的退出码与结论写进 PR 描述。
- **dryRun 证据**：系统健康页清理面板三项 dryRun 预览各跑一次，计数与真删对齐（`AGENTS.md:163`
  「Both the preview and the real pass read the blanked-row counts from the same queries」）。

## 风险

碰三处高代价接缝（`action.ts` 的快照写入、`cleanup.ts`、间接碰完成门禁）。主要风险是
`captureResumeMatchCompletion` 读轮次行时选错轮——必须取该输出节点**最后一轮成功**的行，否则评审循环里
被打回那轮的空产物会顶替最终结果。次要风险：早于 ADR-0018 的历史运行没有轮次行（`e2e/runs.spec.ts:325`
的 legacy 夹具），trajectory 面板对它们退回 slug——已在 `AGENTS.md` 承认，但 `runs.spec.ts:382` 的夹具
insert 要同步改。

预估净删 90-135 行（生产 ~90 + `cleanup.ts` ~25 + 测试夹具）；风险等级：中。

## 落地

PR [#52](https://github.com/TonQiaN/onto-flow/pull/52)。

与提议的差异：多了三处记录没点名的读者，其中一处是**记录之外揭出来的既有 bug**。

- `scripts/run-leetcode.ts:108` 也读 `run_nodes.outputs`（记录只点了 `resume-match.ts` 与
  `smoke-engine.ts`），改读 `readLatestSuccessfulOutputs`。
- **`scripts/run-resume.ts` 早在第 3c 批就已经坏了**：它自己声明的 `RunNode` 里带 `snapshot` /
  `outputs`，但 `/api/runs/[id]` 从第 3c 批起就不再下发这两个字段（`NODE_SKELETON_COLUMNS` 摘掉了），
  于是 `node.snapshot !== null` 对**每个**节点都为真（`undefined !== null`），
  `Action 节点数应为 8，实际 11` 必然抛出，`inspectPdfConversions` / `inspectArtifacts` 则静默什么都不查。
  typecheck 抓不到它，因为那是脚本自己手抄的 DTO。本 PR 把三处都改成读轮次行：产物按
  `/api/runs/[id]/nodes/[nodeId]/rounds/[round]` 取该节点最后一轮成功的那份，Action 节点改由
  「有会话的轮次行」判定。修好之后 `run-resume` 报出 `actionNodes: 8 / sessions: 8 / records: 134 /
  validatorPassed: true`。
- 新增两个按轮读的读者放在 `src/server/run-rounds.ts`（轮次行读取契约的那一个模块）：
  `readLatestSuccessfulOutputs`（完成门禁与两个脚本共用）与 `readLatestRoundSnapshot`（trajectory 路由）。

`docs/DESIGN-V3.md` 第 3 批的批次计划正文保持原样（那是当时的计划记录），只改了两处仍被当作现行契约读的
句子：「保留策略」段与「数据路径」段。

验收实际跑了：

- `npm run check` 全绿（46 个文件、389 通过 1 跳过）、`npm run build` 通过。
- `npx vitest run src/server/monitor/cleanup.test.ts src/server/engine/runner.test.ts
  src/server/engine/action.test.ts src/server/resume-match.test.ts` 全绿；`resume-match.test.ts`
  按记录补了「输出节点第 0 轮 skipped、第 1 轮 success」的夹具（用 `.get()` 不排序会取到第 0 轮的空产物，
  这条用例就是那道防线）。
- e2e（工作树自己的 `data/`，3593 端口的独立 dev server）：
  `npx playwright test -c playwright.clean.config.ts e2e/runs.spec.ts e2e/monitor.spec.ts` **13 passed**。
- **付费冒烟**（工作树自己的 `data/`，先 `db:push` + `db:seed`）：

  | 冒烟 | 退出码 | 终态与核对 |
  | --- | --- | --- |
  | `smoke-engine.ts` | 0 | `终态：success`；四个节点的轮次行 `inputs` / `outputs` 都非空、两个 Action 轮次还带 `snapshot`；`pragma_table_info('run_nodes')` 已无那三列 |
  | `smoke-graph.ts` | 0 | `终态：success`；回边两轮：起草 / 评委甲 / 评委乙 / 裁决各两轮，**每轮的 inputs / outputs / snapshot 长度互不相同**（抽屉按轮取到的是各自那一份）；输出节点第 0 轮 skipped、第 1 轮 success——正是完成门禁必须挑「最后一轮成功」的那个形状 |
  | `run-resume.ts` | 0 | `status: success`、`nodes 11/11`、`artifacts 11`、`actionNodes 8`、`validatorCalls 1`、`validatorPassed true`、335024 token / 0.18518 元；`run_results.sha256` 与按内容重算的 sha256 一致，也与 `runs.imports.completion.resultSha256` 一致，内部 API 读回的 `result` 与脚本打印一致 |

- **dryRun 证据**（同一台 3593 dev server，`POST /api/monitor/cleanup`，先把两条冒烟运行的时间回拨 3 天）：

  | 目标 | dryRun | 真删 |
  | --- | --- | --- |
  | events | `count 183 / bytes 205017`，「事件明细 183 条，另清空 **14 行轮次**的输入输出与快照」 | 逐字相同，只在末尾多一句「已 VACUUM 回收文件空间」 |
  | workspaces | `count 2 / bytes 1236043` | 逐字相同 |
  | runs | `count 2`，「级联 10 个节点、15 行轮次、0 条事件、52 条用量明细、0 份持久结果」 | 逐字相同 |

  events 文案已经**只报轮次行**，不再有「N 个节点」；14 = 两条够龄运行的 4 + 10 行，未够龄的简历运行
  那 11 行没被算进去也没被清。真删后库里只剩简历那一条运行（1 run / 11 nodes / 11 rounds / 1 run_result），
  级联正确。
