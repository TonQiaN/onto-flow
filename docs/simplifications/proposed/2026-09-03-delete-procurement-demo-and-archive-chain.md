# 简化：删除采购演示工作流与归档链条

状态: proposed

## 问题

「归档文档」页（`src/app/documents/page.tsx`）只读 `GET /api/documents`，接口只读 `purchase_plans`
表——平台 schema 里唯一的一张业务表。写它的只有种子 `scripts/seed.ts` 里的 `save_purchase_plan`
Tool（采购工作流第四个 Action「集采计划归档」调用）与 `scripts/run-procurement.ts` 的前后行数断言。
生产消费者：无（页面是只读展示，没有下游读这张表）。测试 / 文档消费者：`e2e/documents.spec.ts`、
`src/server/writers/test-db.ts` 一行清表、`scripts/purchase-plan-path.test.ts`、README 演示段、
DESIGN.md 的 API 行与「首个案例种子」节、系统健康页磁盘行 `data/documents`。「采购集采计划生成」
本身是仓库最初的验证工作流，使命已完成；平台已有通用的业务结果落点（调用入口写 `run_results`，
其余是工作区产物），业务表进平台 schema 是病根，页面无用只是症状。

## 提议

整条链一起删：页面、API、`purchase_plans` 表、`save_purchase_plan` Tool、第四个 Action，以及整条
演示工作流（Skill、案例对象类型、文件夹树、v1 修订、示例需求文件）；`run-procurement.ts`、
`purchase-plan-path.test.ts`、`documents.spec.ts` 删除；README 演示改简历案例；DESIGN.md、AGENTS.md
Commands / Repository layout、REVIEW.md 同步。连带决定见
[seed 只种平台级、e2e 自建夹具](2026-09-03-seed-platform-only-e2e-self-fixtures.md)。

## 放弃了什么

一个零配置、`db:seed` 后即可点「运行」的付费演示；将来要演示「作者自己写的 Tool」时需要另行设计
工作流（已定：届时单独讨论）。

## 验收

`rm -f data/ontoflow.db && npm run db:push && npm run db:seed && npx playwright test` 全绿；
`rg -n "purchase|采购|集采|归档文档" src scripts e2e docs README.md AGENTS.md` 只剩 ADR 与本记录的
历史陈述。执行契约：[DESIGN-V3 第 1 批](../../DESIGN-V3.md)。

## 风险

`seed-resume.ts` / `seed-leetcode.ts` 只依赖模型表与内置对象类型，不受影响，验收时各跑两遍确认
幂等且 pin 不变。删表走 `db:push` 原地应用，本地历史库里的 `purchase_plans` 行随之消失——它们是
演示数据，无人读。
