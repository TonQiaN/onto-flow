# 简化：付费冒烟共用一份夹具与终态断言，不再「打印后总是退出 0」

状态: done

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

1. **抽出 `scripts/smoke-fixture.ts`**（新文件，约 100 行）：`upsertObjectType` / `upsertAction` /
   `upsertWorkflow` 一律**走写入器**（`createAction` / `writeAction` 与同族，也就是 `smoke-parallel.ts:53-73`
   今天的做法），载荷形状取 graph 版的超集（`maxReentries` / `onExhausted` / `exitName`）——不能反过来把
   engine / graph / capabilities 直插 `db.insert(actions)`、不留修订的捷径推广到唯一合规的那份
   （`AGENTS.md`「Every entity write records a revision」；Codex 对 #28 的复审指出）。等待与打印分两档：
   `awaitTerminal(runId, { timeoutMs })` 给单运行脚本，返回终态行、`status !== "success"` 直接抛；
   `awaitTerminals(runIds, { timeoutMs, onTimeout })` 给 `smoke-parallel`，超时时先调 `onTimeout`
   （即今天的 `abortRunBatch()`：取消每一次已受理的运行并等执行器退出，`smoke-parallel.ts:340-371`）再抛，
   一次等待失败也不能把其余付费子进程晾着；`printNodes(runId)` 共用。`smoke-engine` / `smoke-graph` /
   `smoke-capabilities` / `smoke-parallel` 四个脚本共用；四份 `upsertObjectType`、两份 `upsertAction`、
   四份轮询与打印随之删除，`smoke-parallel` 的批量取消语义原样保留在 `onTimeout` 里。
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

预估净删约 140 行（新增 `smoke-fixture.ts` 约 100 行，删除四份重复约 240 行）；风险等级：中。

## 落地

PR：https://github.com/TonQiaN/onto-flow/pull/51

**与提议的差异（五处）**

1. `smoke-fixture.ts` 比预估的「约 100 行」大（417 行），净行数因此不是 −140 而是 **+12**
   （五个脚本 1343 → 1355 行，其中四份重复共删 800 行）。多出来的是提议自己要求的东西：走写入器
   的 upsert 必须带「定义没变就不写」的幂等比对（这段原本只在 `smoke-parallel` 有，占约 150 行），
   外加共用的产物断言与三条纪律的注释。重复是真的没了：四份 `upsertObjectType` → 一份、两份
   `upsertAction` → 一份、四份轮询打印 → 两份，`smoke-parallel` 自己从 375 行缩到 178 行。
2. **多抽了三个共用件**：`requireCredential()` / `requireModel()`（四个脚本各写一遍的凭据与模型行
   检查）与 `assertDeclaredArtifacts(runId)`。后者是「声明的产物存在」这条断言的落点：路径从
   `run_nodes.outputs` 读而不是自己拼——回边重入的第 N 轮产物在 `rounds/N/` 下，拼路径必然拼错
   （图冒烟的裁决书实测就在 `workspace/rounds/2/verdict.md`）。它按**节点 id** 建键：`run_nodes.label`
   对 Action 节点存的是 Action 名而不是画布标签，第一版拿标签当键，付费跑第一次就红了。
3. **`printNodes` 拆成 `printNodes` + `printEvents`**：提议把「轮询 + 打印节点 + 统计事件」当一段，
   但让一个叫 printNodes 的函数顺手打事件是名不副实，拆成两个各自一行调用。
4. **`smoke-harness` 不引 `smoke-fixture`**，断言就地写（四行）。夹具模块 import `../src/db`，
   而 harness 冒烟刻意不碰数据库——它验的就是「子进程这一层自己能不能立起来」，为省四行给它接上
   数据库是倒退。它的收束断言放在 `finally` **之外**：在 finally 里抛会顶掉 try 里真正的首个错误。
5. **`smoke-graph` 补了提议点名却没人做的那条断言**：「真模型真的报出了『打回』这个出口名」。
   现在断言裁决走过 `打回` 与 `通过` 两个出口、起草被推到第 2 轮。断言宽度按「风险」段收着写：
   只钉终态 success、声明的产物存在、关键子串（`# 你好`、`青山不改`、`【冒烟印章】`）与出口名，
   不钉字数、行数、模型措辞；`smoke-harness` 原提议里的「三行」没有断言。
   顺带把 `smoke-capabilities` 的 Skill / Tool 也改走写入器（`createSkill` / `writeTool` 同族，
   写入器自己会物化技能投影），与 Codex 复审要求的「不推广直插捷径」同一条理由。

**验收实际跑了什么**

免费：`npm run check`（vitest 46 文件 389 通过 1 跳过）、`npm run build`，均绿。

付费（本条改的就是付费门，必须真跑；工作树自建 `data/`，八次运行合计 **CNY 0.3638**，
另有三次 harness 子进程冒烟不入库、量级 0.01 以下）：

| 命令 | 退出码 | 终态与关键核对 |
|---|---|---|
| `npx tsx scripts/smoke-harness.ts` | **0** | 结构化输出 `{captured:true,{artifact,line_count}}`、产物含 `# 你好`、`code=0 expected=true` |
| `npx tsx scripts/smoke-engine.ts` | **0** | 终态 success；4 份产物逐一核在盘上；事件 18 条 |
| 人为失败①：`smoke-harness` 的提示词改成写 `# 再见`（断言不动） | **1** | `Error: 产物 hello.md 里没有要求的首行「# 你好」` |
| 人为失败②：`smoke-engine` 起草的产物路径改成工作区里必然已存在的目录 `inputs` | **1** | 终态 **failed**（`声明的产物没有写出来：inputs`）→ `Error: 运行终态是 failed…，冒烟要求 success`。**这就是本记录的验收关键点**：改前同一情形打印 `终态：failed` 后照样退出 0 |
| `npx tsx scripts/smoke-graph.ts` | **0** | 终态 success；`裁决走过的出口：打回 → 通过；起草共 2 轮`；裁决书落在 `rounds/2/verdict.md` |
| `npx tsx scripts/smoke-capabilities.ts` | **0** | 六项全过：技能 symlink、Tool 包装插件、口令 `青山不改`、印章 `【冒烟印章】`、可见工具里**没有** bash、有 `smoke_stamp` |
| `npx tsx scripts/smoke-parallel.ts 2` | **0** | 2 个运行全 success，用量与标记互不串号，启动/收束区间完整重叠 |

两次人为失败验完即还原（`rg` 复核脚本里没有残留）。中途还有一次真实的红：`smoke-graph` 第一版
把产物键写成标签，退出码 1、报「裁决书没有落盘」——正是这套断言该有的行为，改成按节点 id 建键后
重跑退出 0。

e2e：不适用（只改 `scripts/` 与三份文档，不碰 `src/`）。

**Codex 首轮复审的两条（都成立，已改并重跑付费验证）**

1. **印章那项检查证明不了「工具被调用」**：`【冒烟印章】` 这串字模型自己也抄得出来。现在同时要求
   事件日志里有一条 `smoke_stamp` 的**成功结果**（`tool/result` 落库为 `status: "ok"`）；
   `smoke-capabilities` 因此从六项变七项。
2. **Skill / Tool 的写是无条件的**，与夹具自己立的「定义没变就不写」纪律相悖，每跑一次就多两版
   相同修订并重新物化技能。改成 `upsertSkill` / `upsertTool` 进夹具，与其余三个 upsert 同一套
   比对。重跑一次能力冒烟核对：`revisions` 里 skill / tool 各仍为 1 行，退出码 0。

**Codex 二轮复审的一条（成立，已改并重跑）**

3. **`exit.expected` 证明不了「干净收束」**：`RunProcess.#performDispose()` 一进门就把
   `#disposeRequested` 置真，所以 shutdown 挂死之后被 SIGTERM / SIGKILL 打掉的子进程同样是
   `expected: true`。`smoke-harness` 的收束断言改成 `expected && code === 0 && signal === null`，
   打印也带上 signal。重跑：`code=0 signal=null expected=true`，退出码 0。

**Codex 三轮复审的一条（成立，已改并重跑四个脚本）**

4. **「至少有产物」不是断言**：某个 Action 的输出根本没落进 `run_nodes.outputs` 时，扫描会静静
   跳过它，而输入节点物化出来的那份文件已经让 `found.size > 0` 成立——`smoke-engine` 因此可能在
   缺草稿或缺摘要的情况下退出 0。`assertDeclaredArtifacts(runId, required)` 加了必须命中的键：
   engine 点名 `起草·草稿` + `摘要·摘要`，graph 点名两份评语 + 最后一轮草稿 + 「通过」出口的
   裁决书（「打回」出口的意见刻意不点名——最后一轮走的是「通过」，那份产物本来就不该存在），
   capabilities 点名 `报口令·回执`。改完四个付费脚本各重跑一次，退出码全 0。
