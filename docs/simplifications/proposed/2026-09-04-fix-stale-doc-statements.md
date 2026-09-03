# 简化：修掉 AGENTS.md / CONTEXT.md / DESIGN-V2 里与代码对不上的陈述

状态: proposed

## 问题

六处点名式陈述今天已经不成立，且都是 `rg` 一次就能判定的。

**① `AGENTS.md:116`：「`src/rules.test.ts` scans source text for … `handle()` and its **four
exemptions** …」** 实际是**两个**：`src/rules.test.ts:64`
`const EXEMPT = ["src/app/api/runs/[id]/events/route.ts", "src/app/api/models/route.ts"];`，而
`AGENTS.md:136` 自己那句已经写的是「**Two** do not」，`.github/REVIEW.md:46` 也是「仅有的两个例外」。这是
`AGENTS.md` **内部自相矛盾**：第 1 批把四→三（[删掉采购演示与归档链](../done/2026-09-03-delete-procurement-demo-and-archive-chain.md)）、
第 4 批把三→二（[拆散监控台](../done/2026-09-03-dismantle-monitor-console.md)）时都改了 Conventions 那句，
**两次都漏了 Checks 这句**。同句还漏列了第 0b 批新增的记录树骨架断言（`src/rules.test.ts:408-456`）。

**② `AGENTS.md:121`：「`runs.spec.ts` synthesizes its own runs, **events** and usage」**

```
$ rg -n "run_events" e2e/            → 无结果（整个 e2e/ 树没有一处写 run_events）
$ rg -n "insert into" e2e/runs.spec.ts
  → workflows / runs / run_nodes / run_node_rounds / node_usage，没有 run_events
```

**③ `AGENTS.md:129`：「The one sanctioned run-starting shape is `parallel-runs.spec.ts`」**
`e2e/workflow-settings.spec.ts:499` 也发起真实运行
（`request.post('/api/workflows/${workflowId}/run', { data: { inputs: … } })`），同样是零 Action 的
input→output 图（`:461-486`），同样在 `:558` `DELETE /api/runs/${runId}` 收走。它是 `2676d5b` 加的，晚于
这句话（`5f51d5d`）。真正的规则 `.github/REVIEW.md:98`「e2e 没有发起含 Action 节点的运行」是 spec 无关
的，写法正确。

**④ `AGENTS.md:59-64` 的 `docs/` 目录行漏了 `docs/artifacts/`**：`git ls-files docs/artifacts/` 有一个
文件（`2026-09-01-resume-workflow-api-acceptance.md`），`rg -rn "artifacts/" .` 全仓零引用，2026-09-01
后再没动过——它是一次性付费验收的历史记录，与 `docs/simplifications/done/` 同类（写完即冻结），**没有
主人**。

**⑤ `CONTEXT.md:198-201`：「会引用别人的只有两种：工作流……与 Action 模板；**它们两个自己都从不被引用**」**
Action **今天被引用**：`src/server/references.ts:5,147-154,251-257`（`workflow_nodes.action_id`）、
`usedByNames()` 的 409 删除保护、`refCount`。`CONTEXT.md:5-7` 的头注只声明了 Action / Action 模板两条是
未实现模型，没覆盖这条。

**⑥ `docs/DESIGN-V2.md:200` 阶段二：「五态视觉 + 边流动动画 + **自动跟随** + 取消运行」**
画布自动跟随随 [ADR-0018](../../adr/0018-run-page-frozen-graph-replay.md) 删净：
`rg -n "runId|subscribeRun|RunVisualsProvider|runsInFlight" "src/app/workflows/[id]/editor.tsx"` 只剩
`:664-679` 的「受理成功即跳走」；跟随光标搬到了 `src/app/runs/[id]/run-timeline.tsx:204`。同节的阶段三第
4 批已改写为现状，阶段二没改。（「五态视觉」**不是**错的——`flow-node.tsx:33` 自己就写「五态（+pending）」。）

**生产消费者：** 无（六句都是散文）。
**测试 / 文档消费者：** `src/rules.test.ts:64`（例外白名单本身）、`e2e/runs.spec.ts`、
`e2e/workflow-settings.spec.ts`、`e2e/parallel-runs.spec.ts`、`src/server/references.ts`、
`src/app/runs/[id]/run-timeline.tsx`。

**打败了哪条已记录的理由：** `AGENTS.md:223`「State only rules the repository already obeys … delete a
rule the moment the code stops obeying it」，以及「never as if the code already did it」（⑤ 正是这一条）。

## 提议

- `AGENTS.md:116`：「four exemptions」→「two exemptions」；枚举补上 `docs/simplifications/` 记录树骨架。
- `AGENTS.md:121`：删掉「events」——改成「`runs.spec.ts` synthesizes its own runs, rounds and usage」
  （它确实插 `run_node_rounds`，见 `e2e/runs.spec.ts:421`）。
- `AGENTS.md:129`：把「the one sanctioned … is `parallel-runs.spec.ts`」改成 spec 无关的规则陈述（零
  Action 节点的 input→output 运行不花钱，起完在 teardown 经 `DELETE /api/runs/[id]` 收走），并举
  `parallel-runs.spec.ts` 与 `workflow-settings.spec.ts` 两个例子。
- `AGENTS.md:59-64`：给 `docs/artifacts/` 一句主人（「一次性付费验收记录，写完即冻结」）。**不删那个文件**
  ——它留着那次真实运行的 SHA-256 与用量证据。
- `CONTEXT.md:198-201`：把这半句纳入头注的豁免范围，或写成「（ADR-0010 之后；今天 Action 仍被工作流节点
  引用）」。
- `docs/DESIGN-V2.md:200`：把「自动跟随」移到运行页语境，或整条阶段二改写为现状（与阶段三同款）。
- `.github/REVIEW.md:46` 与 `:98` 已正确，无需改；`src/rules.test.ts` 无需改（白名单本身就是二）。

## 放弃了什么

`AGENTS.md:129` 放弃「只有一个 spec 能发起运行」这条更严的口子——它今天已经名存实亡，收紧回一个 spec
需要改 `workflow-settings.spec.ts` 的设置快照用例（那条用例只能靠真跑一次运行拿到 `settingsSnapshot`，
没有更便宜的替代）。

## 验收

`rg -n "four exemptions|one sanctioned run-starting" AGENTS.md` 无结果；`npx vitest run src/rules.test.ts`
绿（记录树骨架门禁与 `handle()` 白名单反向断言都在里面）；`rg -n "run_events" e2e/` 仍无结果（用来复核第
② 句改对了）；`npm run check`。纯文档，不碰四处高代价接缝。

## 风险

低。六处全部有 `rg` 证据，改的都是散文。

预估净删 ≈ 0（六处改写，净 ±2 行）；风险等级：低。
