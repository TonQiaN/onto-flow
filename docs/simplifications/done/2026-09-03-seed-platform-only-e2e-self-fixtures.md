# 简化：seed 只种平台级内容，e2e 自建夹具

状态: done

## 问题

`scripts/seed.ts` 种十样东西，只有内置对象类型（text / file / json）与模型表是平台级的，其余八样
都是采购演示的业务内容。八个 e2e spec（actions、library-v2、object-types、skills、tools、
workflow-editor、workflow-settings、documents）直接断言这些种子字面量，AGENTS.md 因此背着一条
「e2e asserts on its literal strings」的耦合。生产消费者：CI 的 e2e 作业（`db:push` + `db:seed`）
与 smoke.yml 的 `db:seed`（付费冒烟只依赖模型表）。

## 提议

`db:seed` 只保留内置对象类型与模型表；每个 spec 在 `beforeAll` 经 API 自建 `e2e-` 前缀夹具
（对象类型、Skill、Tool、带端口 / 预载 / 可见 Tool 的 Action、文件夹树、带节点与连线的工作流），
`afterAll` 经 `cleanupByPrefix` 与 `cleanupRevisions` 收走——runs / monitor / parallel-runs 三个 spec
已经这么做，公共构造函数进 `e2e/helpers.ts`。AGENTS.md「Test fixtures cost money」整节改写为
「seed 只种平台级；spec 自建夹具；运行历史由 `run-resume` / `run-leetcode` 重建」，REVIEW.md §8 同步。

## 放弃了什么

「打开就有内容」的本地体验：新库要看到工作流得先跑 `seed-resume`。

## 验收

与 CI 同一起点全量 e2e 全绿；`seed-resume.ts`、`seed-leetcode.ts` 各跑两遍无报错。
执行契约：[DESIGN-V3 第 1 批](../../DESIGN-V3.md)。

## 风险

八个 spec 的 setup 重写是这次清理里最大的 e2e 改动；断言仍只对 API 载荷或自建夹具，不对计数与
首页包含（AGENTS.md「Never assert a count…」）。

## 落地

PR：https://github.com/TonQiaN/onto-flow/pull/21（分支 `cleanup/1-remove-procurement`，[DESIGN-V3 第 1 批](../../DESIGN-V3.md)）。

与提议的差异：

- 提议说「只保留内置对象类型与模型表」，落地时连它们的第 1 版修订也不写：修订属于实体的编辑
  历史，平台基线没有可编辑的实体，留着就是为不存在的 API 面写字。`upsertObjectType` 随之收窄成
  `upsertBuiltinObjectType`（`builtin` 恒真、不带 JSON Schema），不留没有主人的参数。
- `scripts/seed.ts` 不再写 `data/samples/`：虚构岗位与简历样例由 `seed-resume.ts` 自己写出
  （它本来就调 `writeResumeSamples()`），采购需求示例随案例一起删。
- AGENTS.md 除「Test fixtures cost money」整节外，Checks 里 `test:e2e` 那条也改了：它原来点名
  `documents.spec.ts` 与「seeded database」。

验收实际跑了：`npx tsx scripts/seed.ts` 两遍（第二遍计数不变）、`seed-resume.ts` 与
`seed-leetcode.ts` 各两遍（幂等、pin 不变、只依赖模型表与内置类型）、`npm run check`、
`npm run build`。全量 e2e 与同批次的 e2e 夹具改写一起验收。
