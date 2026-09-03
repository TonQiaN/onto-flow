# 简化：settleRound 的可选列一律「不传即保持」，别让取消把已记下的出口清成 null

状态: proposed

## 问题

> 如实标注：这一条的价值是**少一条要记的规则 + 修掉一处潜在的数据丢失**，不是删代码，净行数 ≈ 0。

`src/server/engine/rounds.ts:118-148` 的 `settleRound`，`onConflictDoUpdate.set` 里四个可选列用了两套规则：

```ts
set: {
  status: settle.status,
  finishedAt: settle.finishedAt,
  exitName,                                                              // ← 恒在 SET 里；不传即写 null
  error,                                                                 // ← 同上
  ...(settle.inputs === undefined ? {} : { inputs: settle.inputs }),      // ← 不传即保持
  ...(settle.outputs === undefined ? {} : { outputs: settle.outputs }),   // ← 不传即保持
}
```

`settleRoundIfRunning`（L180-192）有同样的 `exitName: settle.exitName ?? null` 无条件写。

**生产消费者——「先写了 exitName、随后被不带 exitName 的 settleRound 覆盖成 null」的路径真实存在，只有
一条：** ① `src/server/engine/action.ts:297-306` Action 正常收束
`settleRoundIfRunning({ status:"success", exitName: selectedExit, outputs })`，轮次行此刻
`exit_name = '通过'`；② `src/server/engine/runner.ts:965` `runOne` 的 post-await 取消检查抛「运行已取消」；
③ `runner.ts:1002-1008` catch 的取消分支 `settleRound({ …, status:"cancelled", finishedAt: at })`
**不带 exitName**，注释明写这里必须无条件改写；④ SET 把 `exit_name` 写成 null。

其余三个调用点都落在**新行**上，不构成覆盖：`propagateSkips`（`runner.ts:728`）与 `applyReentry` 之后的
`state.round = state.usedRound + 1`（`runner.ts:815`）保证被跳过的节点用的是自己没用过的轮次号；
`recordSkippedRounds`（`rounds.ts:214`）取 `max(round) + 1`。

回放今天不会画错：`src/app/runs/[id]/visuals-at.ts:224-236` 先短路
（`if (round.status !== "success") { state = "blocked"; }`），被覆盖的那一行 status 已是 `cancelled`，
`exitName` 根本读不到；`rg -n "exitName" "src/app/runs/[id]/"` 只命中 `run-canvas.tsx:45`（图上端口的
出口名，不是轮次行的）。**但** `src/server/run-rounds.ts:23` 的 `SKELETON_COLUMNS` 把 `exitName` 列进
骨架，`/api/runs/[id]` 与每一帧 SSE snapshot 都把它送到页面——它是已对外承诺的字段，今天恰好没人画。

分类是「加了又拆的残留」：第 3c 批给 `inputs` / `outputs` 加了「不传即保持」的展开写法
（[DESIGN-V3](../../DESIGN-V3.md) 的重载荷按轮另取），`exitName` / `error` 留在了更早的「不传即 null」
写法上，同一个函数里两套语义。

**测试 / 文档消费者：** 最强的反证在仓库自己的测试里——`src/server/engine/runner.test.ts:1728`
「Action 已把本轮写成 success、取消随后才到时，轮次行仍被改回 cancelled」，末行断言
`expect(row.outputs).toContain("已收口的成功")` 上方的注释写着「收口只改终态列：这一轮真跑出来的产物留着，
抽屉仍看得到」——「收口只改终态列」正是意图，而实现对 `exitName` 没做到；这条用例的 mock 里
`exitName: null`（`:1750`），所以它抓不到。`AGENTS.md` 没有陈述这条细则。

## 提议

`rounds.ts` 一处：`settleRound` 与 `settleRoundIfRunning` 的 `set` 块把 `exitName` / `error` 也改成展开：

```ts
...(settle.exitName === undefined ? {} : { exitName: settle.exitName }),
...(settle.error === undefined ? {} : { error: settle.error }),
```

`values()`（新行）仍写 `settle.exitName ?? null`。函数头注释加一句「可选列一律不传即保持，只有终态与
finishedAt 无条件改写」。连带：`runner.test.ts:1728` 那条用例的 mock 改成带具名出口
（`exitName: "通过"`），补断言 `row.exitName === "通过"`；`.github/REVIEW.md` §3 附近加半句「轮次行收口
只改终态列」，与 `rounds.ts` 头注释同批。`AGENTS.md` 不改（该文件没有陈述这条细则）。

## 放弃了什么

「取消的那一轮不该声称走了某个出口」这个语义主张。反方：一个 Action 真的跑完并选了出口、随后整条运行被
取消，那一轮**确实**走了那个出口，把它抹掉是丢事实；而且 `outputs` 已经按这个逻辑保留了，`exitName`
不保留才是不自洽。

## 验收

`npx vitest run src/server/engine/runner.test.ts`（改后的取消用例断言 `exitName` 保留）；`npm run check`。
**不必付费冒烟**：改动只在 `rounds.ts` 的 SQL SET 子句，不触及会话、事件、用量、取消的任何时序——但 PR
描述里要按 `AGENTS.md`「The harness seam」写明为什么可以跳过（`runner.ts:999-1008` 的取消分支语义一字未
改，只是不再顺手清一列）。

## 风险

行为变化：被取消的轮次行从此可能带 `exit_name`。`visuals-at.ts` 因 status 短路不受影响；将来若有人写
「按 `exitName` 画走过的出口」，拿到的是真值而不是 null。

预估净删 ≈ 0 行（−2 局部 const，+2 展开，+1 注释）；风险等级：低。
