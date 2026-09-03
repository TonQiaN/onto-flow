# 简化：README 的门禁命令与 CI 描述同步到 oxc 工具链，或让它指过去不再复述

状态: proposed

## 问题

`AGENTS.md:211` 立了一条硬规则：

> `README.md` … it duplicates the startup and test commands from the Commands block above and
> restates behavior the engine spec owns, **so change README, that block, and the spec together or change
> none of them.**

`.github/REVIEW.md:108` 复述：「README 与 AGENTS.md 的 Commands 块、引擎 spec 三者要一起改或都不改」。

第 0b 批（[ADR-0019](../../adr/0019-oxc-toolchain-not-eslint.md)）加了 lint / fmt / knip 并改了
`npm run check`，**`AGENTS.md` 与 CI 改了，README 没改**——[DESIGN-V3](../../DESIGN-V3.md) 第 0b 批的
「文档同步」段里根本没列 README。今天的不一致：

| README | 实际 |
|---|---|
| `README.md:119` `npm run check      # typecheck + 单测；提交前跑这个` | `package.json` scripts: `"check": "npm run typecheck && npm run lint && npm run fmt:check && npm test"` |
| `README.md:126` 「跑 `typecheck / test / build` 与 Playwright」 | `.github/workflows/ci.yml:31-36` `npm ci → typecheck → lint → fmt:check → test → build` |
| `README.md:116-123` 测试块 | 完全没有 `npm run lint` / `npm run fmt` / `npm run fmt:check` / `npm run knip`，而 `AGENTS.md:86-90` 全都有 |

**生产消费者：** `package.json` 与 `.github/workflows/ci.yml`（上表右列即证据）。
**测试 / 文档消费者：** `AGENTS.md:86-90,111-117`、`.github/REVIEW.md:9,108`、
`.github/pull_request_template.md:9`（都已经写的是四步）。

**打败了哪条已记录的理由：** 打败的正是 `AGENTS.md:211` 自己——那条规则今天处于被违反状态，
`.github/REVIEW.md:108` 那个复选框现在无论怎么勾都是错的。

## 提议

**两条路二选一，请拍板；推荐 A。**

**A（同步）**：`README.md:119` 改成
`npm run check # typecheck + lint + fmt:check + 单测；提交前跑这个`，测试块补 `npm run lint` /
`npm run fmt:check`；`README.md:125-127` 的 CI 描述补 lint 与 fmt:check，并提一句门禁工具链是 oxc
（ADR-0019）。`AGENTS.md:211` 与 `.github/REVIEW.md:108` 不改。

**B（去重）**：删掉 README「测试」整段与 CI 那段的命令细节，只留一句「门禁命令见 [AGENTS.md](../../../AGENTS.md)
的 Commands / Checks」；同时把 `AGENTS.md:211` 与 `.github/REVIEW.md:108` 改成「README 不复述命令」——
这条「两处表示同一事实」的规则从此不需要人来守。

推荐 A：B 更彻底，但它要改掉 `AGENTS.md` 的一条既有规则，而那条规则当初接受重复正是为了「README 单页
可读、不跳转就知道怎么跑测试」；这个取舍归用户拍板。`src/rules.test.ts` 无对应断言（这条规则不可机械
核对，因此它只有 REVIEW.md 一行，符合三处同步规则）。

## 放弃了什么

选 B 就放弃「README 单页可读、不跳转就知道怎么跑测试」；这正是 `AGENTS.md:211` 当初接受重复的理由。
选 A 就继续背这条人工同步义务——下一次工具链变动仍会漏。

## 验收

A：`rg -n "fmt:check" README.md` 有结果；README 里出现的每个 npm 脚本名都在 `package.json` 的 `scripts`
里（可一行脚本核对）。
B：`rg -n "npm run (check|test|typecheck|build|lint|fmt)" README.md` 只剩「启动」段的 `db:push` /
`db:seed` / `dev`。
两条路都跑 `npm run check`。不碰四处高代价接缝，纯文档。

## 风险

低。纯文档。B 的风险是把 `AGENTS.md` 的一条既有规则改掉，需在同一提交同步 `.github/REVIEW.md` 的对应行。

预估净删：A 约 +4 行 / B 约 −12 行；风险等级：低。
