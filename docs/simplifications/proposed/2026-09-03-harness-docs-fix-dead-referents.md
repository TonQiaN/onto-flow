# 简化：修掉 docs/harness/ 里指向已删代码与已变测试的四处陈述

状态: proposed

## 问题

`catalog.test.ts` 钉死的是三方里的两方半：目录 ↔ 组合（`catalog.test.ts:45-135`）、目录 ↔ 文档的**包名
整词出现 + README 版本串 + 定制行版本**（`:137-193`）。散文里关于**本仓库自己代码**的陈述完全不在钉死
范围内——这正是四处漂移发生的地方。

**① `docs/harness/10-本项目自有.md:69,70`**

> `:69` 这是「Tool 是能力，评委不该看见**归档工具**」（ADR-0016）在运行期的实现
> `:70` 但**归档类 Tool** 走 `ctx.dbPath` / `ctx.dataDir`（生成时写死的绝对路径），不再读进程环境。

归档 Tool = `save_purchase_plan`，第 1 批整条删除
（[删掉采购演示与归档链](../done/2026-09-03-delete-procurement-demo-and-archive-chain.md)）。今天全仓只有
两个种子 Tool：`validate_resume_match_result`（`scripts/seed-resume.ts:379`）与 `run_python`
（`scripts/seed-leetcode.ts:124`），**都不使用 `ctx.dbPath` / `ctx.dataDir`**：

```
$ rg -n "ctx\.dbPath|ctx\.dataDir" src scripts --glob '!*.test.ts'
src/app/tools/tool-form.ts:146-147     ← 只剩给 Tool 作者的模板注释
```

[DESIGN-V3](../../DESIGN-V3.md) 第 1 批点名要清「`docs/harness/10-本项目自有.md` 的『三个种子 Tool』与
`save_purchase_plan` 句」——那两个**字面串**清掉了，同一指称换成「归档工具 / 归档类 Tool」的两句留了下来。

**② `docs/harness/AGENTS.md:31`**

> 测试对每一行做的是**子串原样匹配**：目录里 `package` 字段的字符串必须一字不差地出现在它那组的文档里。

实际是**整词匹配**：`catalog.test.ts:155` `new RegExp(\`${escapeRegExp(row.package)}(?![\\w.-])\`)`，行内
注释写着「整词匹配：dsh-web 不能靠 dsh-web-search-deepseek 的出现蒙混过关」。这条是 `6d0015a`（#15/#16
评审修正）改的，根 `AGENTS.md:183` 当时同步成了「as a **whole word**」，`docs/harness/AGENTS.md:31` 没跟。
按这句话去写文档（只写 `@deepseek-ai/dsh-web-search-deepseek` 指望覆盖 `@deepseek-ai/dsh-web`）会直接把
`catalog.test.ts` 弄红。

**③ `docs/harness/07-宿主与界面.md:17`**

> 本项目的界面是 Next 的 App Router 页面（工作流画布、**监控台**、五个库页）

监控台第 4 批已拆散为「系统健康一页」（`AGENTS.md:24-25`、`docs/DESIGN-V2.md:202-206`）。

**④ `docs/harness/08-遥测与身份.md:57`**

> 运行页从 `run_events` 投影**轨迹**与事件

轨迹的权威源是运行目录里的会话 JSONL（`AGENTS.md:196`、`docs/DESIGN.md:61`、
`api/runs/[id]/nodes/[nodeId]/trajectory`），`run_events` 只喂时间轴与事件。

**生产消费者：** `src/app/tools/tool-form.ts:146-147` 仍在向 Tool 作者宣传 `ctx.dataDir` / `ctx.dbPath`
——这两个 `ToolContext` 字段（`src/server/harness/tool-contract.ts:82,84`、`tool-plugin.ts:248-249`）今天
零生产消费者，但 [ADR-0017](../../adr/0017-tool-is-a-contract.md) 把它们定为契约面，**本记录不提议删**，
只把散文改成中性陈述（该字段的处置见
[knip 归零](2026-09-03-knip-to-zero-then-gate.md) 的「已考察」段）。
**测试 / 文档消费者：** `catalog.test.ts` 只钉包名与版本，不钉这四句。

**打败了哪条已记录的理由：** `docs/harness/AGENTS.md:26`「组文档不是目录的复述……改决定时两边一起改，别
只改一边让它们说两套话」，以及 `:9`「事实只从上游源码与 README……或本项目代码里取；拿不准的写进『待核对』，
不要编」。

## 提议

- `10-本项目自有.md:69` 的举例换成今天真有的分工（如「解题 Action 不该看见验收用的 `run_python`」，见
  `scripts/seed-leetcode.ts`）；`:70` 把「归档类 Tool 走 `ctx.dbPath` / `ctx.dataDir`」改成对
  `ToolContext` 字段的中性陈述（契约提供绝对路径，今天没有种子 Tool 用它）。
- `docs/harness/AGENTS.md:31`「子串原样匹配」→「整词匹配（后面不能紧跟 `[\w.-]`）」，并补上「不能靠更长
  的包名蒙混」这句说明，与 `catalog.test.ts:155` 的行内注释同款措辞。
- `07-宿主与界面.md:17`「监控台」→「系统健康页」。
- `08-遥测与身份.md:57` 改成「运行页从 `run_events` 投影时间轴与事件；轨迹的权威源是运行目录里的会话
  JSONL」。
- `catalog.ts` / `composition.ts` 一行不动；根 `AGENTS.md` 与 `.github/REVIEW.md` 无需改（它们今天都是
  对的）。

## 放弃了什么

无。四处都是事实性更正，不改任何决定，也不动 `docs/harness/` 的三方钉死机制。

## 验收

`npx vitest run src/server/harness/catalog.test.ts` 绿（目录 ↔ 组合 ↔ 文档三方钉死）；
`rg -n "归档工具|归档类 Tool|子串原样匹配|监控台" docs/harness/` 无结果；`npm run check`。纯文档，不碰
`catalog.ts` / `composition.ts`，不需要付费冒烟。

## 风险

低。改的都是散文；`catalog.test.ts` 的包名整词断言在同一次运行里证明文档仍满足机械核对。

预估净删 ≈ 0（四处改写）；风险等级：低。
