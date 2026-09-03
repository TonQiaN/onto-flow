# 简化：seed 只种平台级内容，e2e 自建夹具

状态: proposed

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
