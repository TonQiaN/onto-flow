# 简化：把 REVIEW.md 里已被 rules.test.ts 全覆盖的 6 条从人工评审位上撤掉，raw-SQL 那条收窄到机械核对不了的语义

状态: proposed

## 问题

`.github/REVIEW.md:5` 自己划了范围：

> 评审的产出只有一种：带文件与行号的具体问题。…… **能被 `src/rules.test.ts` 机械核对的条目 CI 已经跑过，
> 评审盯 CI 看不见的那些。**

但清单里有 6 条被 `src/rules.test.ts` **完全**覆盖、没有任何肉眼残留，另 1 条（raw SQL）只剩一句机械核对
不了的语义：

| REVIEW.md | 条目 | 覆盖它的断言 |
|---|---|---|
| `:26` | 没有 `await db.…` | `rules.test.ts:93`（且 `.oxlintrc.json` 的 `typescript/await-thenable` 再兜一道，ADR-0019） |
| `:30` | raw SQL 只经 `sql` 标签、白名单七个文件、`LIKE` 配 `escape '\'` | `rules.test.ts:340,348,354` 三条盖住「只经 `sql` 标签」「只在白名单文件」「`LIKE` 配转义」；**盖不住**「白名单文件里新加的一条原生 SQL 是不是查询构造器真表达不了的聚合」——这一句保留（Codex 对 #28 的复审指出） |
| `:46` | 每个 route 体跑在 `handle()` 里、两个例外没被复制 | `rules.test.ts:67,83` |
| `:47` | 每个 route `export const dynamic = "force-dynamic"` | `rules.test.ts:49` |
| `:48` | 客户端不从 `@/server` / `@/db` 导运行时值、没有 `"use server"` | `rules.test.ts:140,163` |
| `:49` | 能到达 restore 的 route 带 `import "@/server/writers";` | `rules.test.ts:267` |
| `:109` | `.claude/skills/` 与 `.codex/skills/` 字节一致 | `rules.test.ts:390` |

`npx vitest run src/rules.test.ts` 与 `catalog.test.ts` 今天 29 passed / 1 skipped（跳过的是
`_reference` 缺席时的上游文件核对，环境相关，不是过期豁免）。

**生产消费者：** 无（REVIEW.md 是给人与 review agent 读的）。
**测试 / 文档消费者：** `AGENTS.md:216`（「the same invariants regrouped by what to look at in a diff」）、
`.github/workflows/claude.yml:47`（要求 agent 先读 REVIEW.md 再读 AGENTS.md）。

**打败了哪条已记录的理由：** 打败的是 REVIEW.md 自己第 5 行的范围声明——这 7 条占着有限的人工注意力，
而 CI 已经在同一个 PR 上跑过它们。

## 提议

**⚠️ 需要用户拍板的措辞冲突：`AGENTS.md:115`（Checks 段）与 `:216`（Decisions 段）两处把 REVIEW.md 定义成
「this file's invariants **regrouped**」，
暗示完整覆盖；`.github/REVIEW.md:5` 定义成「只盯 CI 看不见的」。两句话不能同时为真。**

**路 1（撤掉，推荐）**：按 REVIEW.md:5 优先。删 `.github/REVIEW.md` 第 26、46、47、48、49、109 共
6 行；第 30 行收窄成「白名单文件里新加的原生 SQL 必须是查询构造器表达不了的聚合，且 `src/rules.test.ts`
的允许名单没有变长」；在 §0「门槛先看」加一行「CI 的 `check` 作业跑 `src/rules.test.ts`，它机械核对的约定
（`force-dynamic`、`handle()` 例外、`await db.`、客户端边界、`globalThis` 前缀、raw-SQL 白名单、
`LIKE` 转义、`@deepseek-ai` 钉版、skills 双树、记录树骨架）评审不必重复勾，**但白名单变长了要问为什么**」
——最后半句是唯一真正需要人看的部分。连带把 `AGENTS.md:115` 与 `:216` **两处**都改成「the invariants **CI cannot check**,
regrouped by what to look at in a diff」——同一契约声明了两次，只改一处就把本记录要消的矛盾原样留下。

**路 2（保留，改软措辞）**：按 `AGENTS.md:115` / `:216` 优先。给这 7 条各加一句「（`rules.test.ts` 已机械核对，
评审只需确认没有新增例外）」，并把 `.github/REVIEW.md:5` 那句改软。净行数为正。

推荐路 1：人工评审的稀缺资源是注意力，一份 117 行的清单里有 6 行永远勾对，训练的是「一路勾下去」。
REVIEW.md 与 AGENTS.md 的两处声明必须同一个 commit 改。

**不删**的三条（看着像被覆盖，其实不是）：`:50`（信封：测试只钉 import，运行时形状仍需肉眼）、`:58`
（`globalThis` 前缀已覆盖，但「模块级 `const map = new Map()`」不可机械核对）、`:15`（`@deepseek-ai`
钉版：测试只核对**直接**依赖进 `overrides`，传递依赖漏了不会红，见 `catalog.test.ts:174-183`）。

## 放弃了什么

「一份清单读完就覆盖全部不变量」的完整性；不跑 CI 的人工评审（例如只读 diff 的外部评审者）会漏掉这 6 条。
反方最强的说法是「REVIEW.md 也是新人理解不变量的入口」——但那个用途归 `AGENTS.md`，REVIEW.md:5 明说自己
不是。

## 验收

`.github/REVIEW.md` 里不再出现被 `rules.test.ts` 全覆盖的条目（PR 描述里附一份逐条对照表：REVIEW 行号 ↔
`rules.test.ts` 断言行号）；`npx vitest run src/rules.test.ts` 绿；`npm run check`。纯文档，不碰四处高
代价接缝。

## 风险

中。这是评审流程本身的改动，且与 `AGENTS.md:115` / `:216` 的措辞冲突，必须三处同一提交改；`claude.yml` 的
`@claude` 评审读的就是这份清单，撤掉的 6 条从此完全依赖 CI——若哪天有人把 `rules.test.ts` 的某条断言连同
被它保护的规则一起删掉，就没有第二道人工闸门了。

预估净删约 5 行（删 6 行、收窄 1 行、加 1 行）；风险等级：中。
