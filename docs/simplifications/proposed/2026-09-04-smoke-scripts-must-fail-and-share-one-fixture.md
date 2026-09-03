# 简化：付费冒烟共用一份夹具与终态断言，不再「打印后总是退出 0」

状态: proposed

## 问题

**（一）三个冒烟脚本根本不会失败。** 它们等到运行进入任何终态就 `break`，然后打印，然后进程退出 0：

```ts
// scripts/smoke-engine.ts:196-200
if (row && row.status !== "running") {
  console.log(`\n终态：${row.status}${row.error ? `（${row.error}）` : ""}`);
  console.log(`运行目录：${row.runDir}`);
  break;                       // ← failed / cancelled 走的是同一条 break
}
```

`scripts/smoke-graph.ts:317-321` 与 `scripts/smoke-capabilities.ts:253` 完全同型。
`smoke-capabilities.ts` 更进一步，把每一项检查的结果打成字符串就完事
（`:262/265/271/272/307/308`，如 `技能链接：${fs.existsSync(link) ? … : "不存在 ✗"}`、
`口令来自技能：${text.includes("青山不改") ? "✓" : "✗"}`）。全仓只有 `smoke-parallel.ts:371`
`if (failed > 0) throw new Error(...)` 是真断言，`smoke-harness.ts` 靠 `readFile(artifact)` 抛异常做部分
断言（不校验内容）。

**生产消费者：** `.github/workflows/smoke.yml:41`（`smoke-harness`）与 `:43`（`smoke-engine`）——**每天
UTC 20:00 定时跑的付费步骤，跑出一个 failed 的运行同样会绿。** `.github/REVIEW.md` §0 第 5 条要求「触及
harness 接缝 → 写明是否跑了付费冒烟与**结论**」——「结论」今天只能靠人眼读 stdout。

**（二）四份夹具脚手架各写一遍。** `upsertObjectType` 在 `smoke-engine.ts:27-33` 与
`smoke-graph.ts:34-40` **逐字相同**（`diff` 无输出）；`smoke-capabilities.ts:79-89` 是第三份；
`smoke-parallel.ts:53-73` 是第四份（它改走写入器）。`upsertAction` 在 engine（`:35-90`）与 graph
（`:49-105`）是近亲副本，graph 版是严格超集（多 `maxReentries` / `onExhausted` / `exitName`）。「轮询到
终态 + 打印节点表 + 统计事件」这段在四个脚本里也各写一遍。engine / graph / capabilities 直接
`db.insert(actions)` 绕开写入器（因此不留修订），parallel 走 `createAction` / `writeAction`——同一件事
两种做法。

**测试 / 文档消费者：** `smoke-graph` 只被 `AGENTS.md:100` 与 [DESIGN-V3](../../DESIGN-V3.md) 点名；
`smoke-capabilities` 只被 `AGENTS.md:101` 点名；`smoke-parallel` 只被 `AGENTS.md:102` 点名。

**打败了哪条已记录的理由：** `AGENTS.md`「The harness seam」写「A change on this seam also runs at least
`smoke-harness`, or the PR says why it can skip it: CI has no credential, so only a paid smoke exercises a
real model call」——这条理由成立的前提是**冒烟会在真实调用出问题时红**。今天它不会。`smoke-graph` 声称
验的四件事（扇出、汇总、具名出口、回边重入）已经被免费机械覆盖：`src/server/engine/runner.test.ts` 有
`describe("回边重入")` / `describe("冻结图与轮次行")` / `describe("回边重入等待环体收束")` /
`describe("每节点总轮次上限")` 共 20 条用例，`src/lib/graph.test.ts` 覆盖 `classifyEdges` /
`validateGraph`——所以 `smoke-graph` 的唯一增量价值就是「真模型真的报出了 `打回` 这个出口名」，而这一点
它恰恰没断言。

## 提议

不删任何一个冒烟脚本（它们是付费门，删一个要更强的理由）。做三件事：

1. **抽出 `scripts/smoke-fixture.ts`**（新文件，约 90 行）：`upsertObjectType` / `upsertAction`（取
   graph 的超集版）/ `upsertWorkflow` / `awaitTerminal(runId, { timeoutMs })`（返回终态行，
   `status !== "success"` 直接抛）/ `printNodes(runId)`。`smoke-engine` / `smoke-graph` /
   `smoke-capabilities` / `smoke-parallel` 四个脚本共用；四份 `upsertObjectType`、两份 `upsertAction`、
   四份轮询与打印随之删除。
2. **把 `✓/✗` 打印改成失败即抛**：`smoke-capabilities.ts:262/265/271/272/307/308` 六项、
   `smoke-engine` / `smoke-graph` 的终态判定、`smoke-harness.ts:69` 的产物内容（三行、首行 `# 你好`）与
   结构化输出形状。`smoke-parallel.ts:340-371` 已经是这个写法，照抄它。
3. **连带要改的**：`AGENTS.md` Commands 块 `:98-102` 五行注释各补「失败即非零退出」；
   `.github/REVIEW.md` §0 第 5 条的「与结论」改成「与退出码」；`.github/workflows/smoke.yml` 无需改
   （步骤本来就按退出码判定，只是过去永远为 0）；[DESIGN-V3](../../DESIGN-V3.md) 第 3 批付费验收口径
   同步。不碰 `src/`。

## 放弃了什么

「冒烟只报告、由人判断」的宽松姿态：模型偶发的一次不理想输出（比如没恰好写三行）会把定时任务打红，需要
把断言写得足够宽。抽公共模块后，单个脚本不再「一个文件读完」，读 `smoke-graph` 得同时看 `smoke-fixture`。

## 验收

免费部分：`npm run check`、`npm run build`。

**付费部分（本条改的就是 harness 接缝的付费门，必须有）**：`npx tsx scripts/smoke-harness.ts` 与
`npx tsx scripts/smoke-engine.ts` 各跑一次，PR 描述贴退出码；再**各造一次人为失败**（例如把 Action 的
产物路径改错）确认脚本这次**非零退出**——这是本候选唯一的验收关键点。`smoke-graph` /
`smoke-capabilities` / `smoke-parallel` 至少各跑一次确认改造后仍能跑通，退出码一并写进 PR 描述。

## 风险

改的是付费门本身，改错会让定时任务从「永远绿」变成「永远红」。断言宽度是唯一的调参点：建议只断言「运行
终态为 success」「声明的产物存在」「关键子串出现」，不断言字数、行数、模型措辞。

预估净删约 150 行（新增 `smoke-fixture.ts` 约 90 行，删除四份重复约 240 行）；风险等级：中。
