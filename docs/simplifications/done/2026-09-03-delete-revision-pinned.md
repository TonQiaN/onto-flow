# 简化：删掉 revisions.pinned——它承诺的「清理时跳过」没有实现路径

状态: done

## 问题

`src/db/schema.ts:85-86` 的注释写着「手动标记保留的版本，**清理时跳过**」，`docs/DESIGN-V2.md:15` 写着
「`pinned` 标记不被清理」。但仓库里**没有任何清理修订的路径**：

```
$ rg -an 'revision' src/server/monitor/
（无结果，exit 1）
$ rg -n 'CLEANUP_TARGETS' src/app/monitor/lib.ts
110:export const CLEANUP_TARGETS = ["workspaces", "events", "runs"] as const;
```

清理面板只有工作区 / 事件 / 运行三档（`cleanup.ts:108,214,294`），三档都不碰 `revisions` 表。所以
「固定」与「不固定」在系统的任何行为上都不可区分——一个为没有主人的场景预留的开关，同时正是
`AGENTS.md`「delete a rule the moment the code stops obeying it」点到的情况：schema 注释与 DESIGN-V2
陈述的规则，代码从未遵守。

**生产消费者（只有「写它 / 显示它」，没有「据它做决定」的）：** `src/db/schema.ts:86` 列；
`src/server/revisions.ts:98`（列表投影）、`:111-127`（`patchRevision` 的 `pinned` 分支与 400 文案）；
`src/app/api/revisions/[revId]/route.ts:19,28`（PATCH 载荷字段）、`src/app/api/revisions/route.ts:10`
（响应形状注释）；`src/components/library/types.ts:100`（`RevisionSummary.pinned`）；
`src/components/library/RevisionPanel.tsx:429`（`patch` 签名）、`:522-526`（「已固定」徽标）、
`:533-539`（「固定 / 取消固定」按钮）。

**测试 / 文档消费者：** e2e 与单测**没有任何一条断言它**（`rg -n '固定|pinned' e2e` 只命中
`parallel-runs.spec.ts:203` 的「固定大小前缀」与 `settings.spec.ts:154` 的「固定分十组」，都是别的意思）；
文档只有 `docs/DESIGN-V2.md:15,116,119`。

## 提议

**两条路，请拍板其一。**

**路 1（推荐，净删）**：删列；删 `patchRevision` 的 `pinned` 分支（`patchRevision` 塌成只改 `note`）；
删列表投影字段；删 `RevisionSummary.pinned`；删 `RevisionPanel` 的徽标与按钮。`docs/DESIGN-V2.md:15` 的
「`pinned` 标记不被清理」整句删，`:116` 的「含 versionNo/note/pinned/createdAt」与 `:119` 的
`{pinned?, note?}` 同改。schema 改动走 `npm run db:push`。

**路 2（给它一个主人）**：在清理面板加第四档「修订」并跳过 pinned 行。但这会新增一条破坏性路径，与
`.github/REVIEW.md` §3「破坏性路径仍只在 `src/server/monitor/cleanup.ts`」和「没有新增第五种删除保护」
相抵，属于新功能而非简化。

推荐路 1：删掉一条从未被遵守的规则，比为它补一条破坏性路径便宜得多；真要「书签」，`note` 就在同一行
（`RevisionPanel.tsx:541+`）。

## 放弃了什么

一个纯视觉的「书签」：用户今天可以给某一版打「已固定」徽标当记号（虽然按钮文案承诺的是「不被清理」）。
删掉后要标记某一版只能写 `note`。

## 验收

`npm run check`、`npm run build`；`npx playwright test e2e/library-v2.spec.ts`（修订面板用例，今天不断言
pinned，改完仍应绿）；`rg -n 'pinned' src docs --glob '!docs/simplifications/**'` 只剩不相关命中。
schema 改动走 `npm run db:push`。不碰四处高代价接缝（`cleanup.ts` 一行不动）。

## 风险

低。`db:push` 掉列会丢掉本地库里已有的固定标记——它们不影响任何行为。

预估净删 26 行 + 1 列；风险等级：低。

## 落地

PR 待开。

**与提议的差异**：用户拍板选路 1（净删）。此外记录里的 `rg -n 'pinned'` 漏了两处不带 `-ed` 的同一事实，
一并改掉：`README.md:27` 的「可 pin」（README 是唯一的产品说辞，行为变了必须同改）改成「可加备注」，
`docs/DESIGN-V2.md:161` 的 `RevisionPanel` 注释「回滚 + pin/备注」去掉 `pin`。`patchRevision` 塌成只改
`note` 后，`RevisionPanel` 里唯一的调用点只剩备注一处，函数一并塌成 `patchNote(revId, note)`。

**验收实际跑了什么**：

- `npm run check`：typecheck / oxlint / oxfmt 全绿，vitest 46 文件 390 通过 1 跳过。
- `npm run build`：通过（35 条路由）。
- `npm run db:push`：先在工作树自己的 `data/ontoflow.db` 上手动 `alter table revisions add column pinned`
  造出旧库，再 push，`pragma_table_info('revisions')` 从八列回到七列——掉列这条路走得通，不需要迁移文件。
- `npx playwright test -c playwright.clean.config.ts e2e/library-v2.spec.ts`（工作树自建库 + 3597 独立端口）：
  4 passed，含「编辑面板「修订历史」显示自建实体的 v1」。
- 手工 API 核对：`GET /api/revisions?kind=skill&id=…` 的 items 只剩
  `{id, entityKind, entityId, versionNo, note, createdAt}`；`PATCH {note}` 去空白后落库；`PATCH {}` 答 200
  原样返回；`PATCH {note: 1}` 答 400「note 必须是字符串」；`PATCH {pinned: true}` 被忽略（200，响应无该字段）。
- 浏览器肉眼验收 `/skills` → 编辑 → 修订历史：行上只剩「备注 / 回滚」，无「固定」按钮与「已固定」徽标，
  备注仍能写入并回显。
- `rg -n 'pinned' src docs --glob '!docs/simplifications/**'`：只剩 `agent-trajectory.tsx` 的
  `pinnedSessionRef`、`AGENTS.md` 的 `TMPDIR is pinned` / 版本 pin / 骨架 pinned 与 `rules.test.ts` 的同句引用。
- 未跑付费冒烟（记录未要求，改动不在 harness 接缝上）；`src/server/monitor/cleanup.ts` 一行未动。
