# 简化：删掉引擎自插的 usage 运行事件与它带出来的四个字段、两条特例测试

状态: done

## 问题

对象：`run_events` 里 `type = "usage"` 的行（`src/server/engine/action.ts:732` 是唯一写入点），以及
为「幂等刷新」它而存在的 `UnsettledUsageRollup.eventId` / `.eventDirty` / `.detailPersistenceFailures` /
`.unsettledProcess` 四个字段、`usageEventPayload()`（`action.ts:677-694`）、`readSessionUsage()` 的
`fallbackChunks` 返回项。

**生产消费者：无。**

```
$ rg -n 'type === "usage"' src/app src/server --glob '!*.test.ts'
src/server/harness/trajectory.ts:851   ← 上游 session JSONL 的 chunk，不是 run_events 行
```

逐个排查读侧：

- `src/app/runs/[id]/visuals-at.ts:117-137` 的活动推导只认 `text` / `reasoning` / `tool` /
  `session.idle` / `session.error` 五种，`usage` 进不了任何分支。
- `src/app/runs/[id]/run-timeline.tsx:60-67` 把全部事件行一律当刻度，只区分 `session.error`。
- `src/server/resume-match.ts:704` 是 `eq(runEvents.type, "tool")`，只读 tool。
- `node-drawer.tsx` / `snapshot-view.tsx` / `agent-trajectory.tsx` 没有任何事件类型分支；轨迹面板读
  会话 JSONL，不读 `run_events`。
- 最强的一条：`action.ts:740` 的 `db.update(runEvents).set({ payload })` **原地改写已插入的行**，而唯一
  的下发通道 `src/app/runs/[id]/use-run-stream.ts:8` 按 `run_events.id` 去重增量追加——改写后的 payload
  永远送不到页面。这条「幂等刷新」在读侧不可观测。

**测试 / 文档消费者：** `src/server/engine/action.test.ts:549-553`（断言 `{ type: "usage", sessionId:
"node-1" }`）、`:556`「正常会话的 usage 事件瞬时写入失败时进入最终结算重试链」（63 行，用 SQLite
`CREATE TRIGGER fail_normal_usage_event_insert` 造插入失败）、`:713`「子进程退出后的 usage 事件瞬时写入
失败时保留结算状态供重试」（77 行，同款 trigger）、`:619`（兼顾 `run_nodes` 刷新，会缩小不会消失）；
`AGENTS.md:195`、`AGENTS.md:200`、`docs/DESIGN.md:207-210` / `:220` / `:245-246`、`.github/REVIEW.md:69`。

**打败了哪条已记录的理由：** `AGENTS.md:195`「an engine-generated `usage` run-event surfaces each
Action's spend **in the event log**」的前提是「事件日志页」。日志检索页与 `event-log.tsx` 在第 3、4 批
已删（[拆散监控台](../done/2026-09-03-dismantle-monitor-console.md)、[编辑器不再跟随运行](../done/2026-09-03-editor-stops-following-runs.md)），
唯一展示面消失，理由随之失效。同时这是同一事实的第三份表示：逐 chunk 明细在 `node_usage`（`/api/runs`
的 `byModel` 读它），节点累计在 `run_nodes`（概要栏、运行列表、`summary` 的权威源，`AGENTS.md:150`
明说），`usage` 事件只是「按会话对前两者求和」的派生。

## 提议

- `src/server/engine/action.ts`：删 `usageEventPayload()`（L677-694）、`refreshUnsettledUsageRollup()`
  里 L719-745 的事件插入 / 更新 try-catch 与 L718 的 `state.eventDirty = true`；`UnsettledUsageRollup`
  去掉 `eventId` / `eventDirty` / `detailPersistenceFailures` / `unsettledProcess` 四个字段（后两个只喂
  payload，删事件后一起死）；`readSessionUsage()` 的返回收成 `UsageAmounts & { chunks }`，去掉
  `fallbackChunks` 包装（L624-627、L656-659）；`usageRollupState()` 去掉 `unsettledProcess` 参数；
  `finishUsageRollup()` 去掉 `if (state.eventDirty || state.eventId === undefined) throw` 那 5 行——
  `refreshUnsettledUsageRollup` 里的 `db.update(runNodes)` 本就不吞异常，重试链
  （`scheduleUsageSettlementRetry`）由它天然驱动，**不删**；`runEvents` import 随之去掉。
- 测试：`action.test.ts:549-553` 的断言删除；`:556` 与 `:713` 两条 trigger 用例把 trigger 改挂到
  `run_nodes` 的 UPDATE 上（保留「结算失败 → 保留状态 → 重试」这条不变量），三条并成一条。
- 文档：`AGENTS.md:195` 去掉「and an engine-generated `usage` run-event surfaces each Action's spend in
  the event log」；`AGENTS.md:200`「refresh `run_nodes` and its existing `usage` event」改成只
  `run_nodes`；`docs/DESIGN.md:207-210` / `:220` / `:245-246` 同改；`.github/REVIEW.md:69` 去掉「与
  `action.ts` 自插的 `usage` 事件两处都要写」半句（`session_id` 那条规则本身保留，`events.ts` 仍是写入者）。
- `src/rules.test.ts` 的 raw-SQL 名单**不动**（`action.ts` 的 per-session `SUM` 仍在）。

## 放弃了什么

`detailPersistenceFailures` 与 `unsettledProcess` 这两个「本次结算是否走过内存兜底 / 子进程是否未确认
静止」的逐会话时间戳记录没了——将来要审计「哪一次运行的账走过兜底」，只能从 `run_nodes` 与
`node_usage` 的差额倒推，倒推不出发生在哪一刻。时间轴上每个会话少一个刻度。

## 验收

- `npm run check` + `npm run build`；`npx vitest run src/server/engine/action.test.ts src/server/engine/runner.test.ts`。
- **付费冒烟（本条踩 harness 接缝：`src/server/engine/action.ts` 头注释覆盖用量与结算）**：停掉 dev
  server 后 `npx tsx scripts/smoke-engine.ts`，验 `run_nodes` 的 token / cost 与 `node_usage` 按会话求和
  一致、`select count(*) from run_events where type='usage'` 为 0、运行页概要栏与运行列表的费用与改动前
  同值；再跑一次 `npx tsx scripts/smoke-harness.ts` 确认会话收束路径不变。两次的退出码与结论写进 PR 描述。
- 观察终态：`rg -n '"usage"' src` 只剩 `events.ts:195` 与 `trajectory.ts:851` 两处上游 chunk 判定。

## 风险

行为变化：`finishUsageRollup` 不再因「事件没写成」而抛，隔离运行的释放条件放宽一格——须确认
`refreshUnsettledUsageRollup` 里 `db.update(runNodes)` 的异常仍能到达 `finalizeUnsettledActionUsage` 的
`failures[]`（今天不在 try 内，会传播，成立）。与已记录理由的冲突：`AGENTS.md`「A subprocess disposal
failure quarantines the run」那条明写要刷新 `usage` event——同一提交改掉那半句，规则本身（节点累计必须
持续刷新到进程退出确认）不变。

预估净删约 220 行（生产 ~80 + 测试 ~140）；风险等级：中。

## 落地

PR [#48](https://github.com/TonQiaN/onto-flow/pull/48)。

与提议的差异：多删了一个字段，多改了两处文档。

- `UnsettledUsageRollup.modelId` 一起删：它唯一的读者就是 `usageEventPayload()` 的 `model` 字段，
  与提议点名的四个字段同批死。它一走，`usageRollupState()` / `beginUnsettledUsageRollup()` /
  `recordUsage()` 的 `model` 形参也没有读者了，三处签名一并收窄（纯管线，无行为）。
- `src/server/engine/events.ts` 的头注释里「另有一种引擎自产的 usage 结算事件」那两行同批改成
  「本模块是 `run_events` 唯一的写入者」——记录漏列了这处注释，但它陈述的正是被删掉的行为。
- `docs/DESIGN-V3.md:311` 第 3 批的 `session_id` 条目里「`action.ts` 里 `refreshUnsettledUsageRollup()`
  自己插的 `usage` 事件……两处插入点都改」同批删掉，理由同上。
- `AGENTS.md`「Session events must be written to SQLite as they arrive」那句里的
  「`action.ts` on the `usage` event it inserts itself」与 `.github/REVIEW.md` §5 的对应半句一起改成
  「`events.ts` 是 `run_events` 唯一的写入者」——`session_id` 规则本身保留。

测试按提议合并：`action.test.ts` 的三条 usage 事件用例并成一条
「节点用量累计写入失败时保留结算状态，故障消失后由最终结算补齐」，trigger 从 `run_events` 的
INSERT/UPDATE 改挂到 `run_nodes` 的 `UPDATE OF input_tokens` 上，保留「结算失败 → 保留状态 → 重试」
这条不变量；隔离会话那条去掉事件断言并改名。`src/rules.test.ts` 的 raw-SQL 名单未动。

验收实际跑了：

- `npm run check` 全绿（46 个测试文件、387 通过 1 跳过）；`npm run build` 通过；
  `npx vitest run src/server/engine`（5 个文件、54 条）绿。
- **付费冒烟**（在本工作树自己的 `data/` 上，先 `db:push` + `db:seed`）：
  - `npx tsx scripts/smoke-engine.ts` 跑了两次，退出码 **0**，终态均 `success`；
    事件类型分别是 `tool×12 reasoning×1 session.idle×2 text×2` 与 `reasoning×4 tool×16 session.idle×2`，
    **没有 `usage` 一类**。
  - `npx tsx scripts/smoke-harness.ts` 退出码 **0**：一轮对话、结构化输出
    `{"captured":true,"value":{"artifact":"hello.md","line_count":3}}`、产物正确、
    `子进程收束：code=0 expected=true`、运行目录已清理——会话收束路径不变。
  - sqlite3 核对（两次运行合计）：`select count(*) from run_events where type='usage'` = **0**；
    每个节点的 `run_nodes` token 与 cost 与 `node_usage` 按 `(run_id, session_id)` 求和**逐行相等**
    （偏差行数 0）；两次运行都是 success，合计 59107 token、0.015128 元。
- 观察终态：`rg -n '"usage"' src --glob '!*.test.ts'` 只剩 `events.ts:195` 与 `trajectory.ts:804`
  两处上游 chunk 判定。
