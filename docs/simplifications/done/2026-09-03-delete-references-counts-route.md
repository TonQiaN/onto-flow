# 简化：删掉 /api/references/counts——引用数已随库列表信封下发

状态: done

## 问题

**生产消费者：无。**

```
$ rg -an 'references/counts|/counts' src/components src/app --glob '!src/app/api/**' e2e scripts
（无结果）
```

唯一出现处是路由自己 `src/app/api/references/counts/route.ts:8` 与 `docs/DESIGN-V2.md:80`。

**测试 / 文档消费者：** `docs/DESIGN-V2.md:80`「`{ [entityId]: number }`，供列表页批量取引用数」。没有
任何 e2e / 单测调它。

**打败了哪条已记录的理由：** 就是 DESIGN-V2 自己写的那句「供列表页批量取引用数」——这条前提已不成立：
`src/server/writers/list.ts:160` 在 `selectLibraryPage` 里调 `refCounts(kind)`，`listEnvelope` / `withMeta`
（`list.ts:225,240`）把 `refCount` 逐条挂进 items，五个库页面全部读那一份：`actions/page.tsx:390`、
`skills/page.tsx:272`、`object-types/page.tsx:288`、`components/canvas/flow-node.tsx:351`、
`workflows/[id]/node-panel.tsx:286`、`action-editor.tsx:455`。同一事实两处表示，其中一处零消费者。

## 提议

- 删 `src/app/api/references/counts/` 整个目录（20 行）。
- 删 `docs/DESIGN-V2.md:80` 那一行。
- `refCounts` / `listEntities` 保留（`list.ts:160`、`folders.ts:69`、`orphans()` 还在用）。
- `src/rules.test.ts` 无需改（该路由不在任何白名单里；`force-dynamic` 断言是遍历现存文件）。
  `AGENTS.md:15` 仓库布局里的聚合计数「36 route handlers」改成 35（Codex 对 #28 的复审指出，否则那句立刻过时）。

## 放弃了什么

「不翻页、一次拿全某库所有实体引用数」的批量口——今天没有页面要它；真要做「按引用数排序但不分页」的
视图时，`refs_desc` 排序已经在服务端做了（`list.ts:166-182`）。

## 验收

`npm run check`、`npm run build`；`rg -n 'references/counts' src e2e scripts docs` 只剩本记录；
`npx playwright test e2e/library-v2.spec.ts`（引用面板与 refCount 断言）。不碰四处高代价接缝。

## 风险

低。删的是一条零消费者的 GET，`npm run build` 会抓到任何遗漏的路由引用。

预估净删 21 行；风险等级：低。

## 落地

PR [#31](https://github.com/TonQiaN/onto-flow/pull/31)。

与提议的差异：无。提议三条全做：删 `src/app/api/references/counts/` 整个目录、删 `docs/DESIGN-V2.md`
第三节表里那一行、`AGENTS.md` 仓库布局的「36 route handlers」改成 35（改前 `find src/app/api -name
route.ts | wc -l` = 36，改后 = 35）。`refCounts` / `listEntities` / `isEntityKind` 都还有别的消费者，
按提议保留：`refCounts` 在 `writers/list.ts:160` 与 `references.ts:276`（`orphans()`），`listEntities`
在 `folders.ts:69` 与 `references.ts:277`，`isEntityKind` 在另外三条 references / revisions 路由里。
`src/rules.test.ts` 确认无需改（`rg -n '\b36\b' src/rules.test.ts` 无结果，`force-dynamic` 断言遍历现存
文件），`.github/REVIEW.md` 无命中。

验收实际跑了什么：

- `npm run check` 全绿（46 个测试文件，387 passed / 1 skipped）。
- `npm run build` 成功；生成的路由表里 `/api/references/counts` 已消失，`/api/*` 恰好 35 条。
- `rg -n 'references/counts' src e2e scripts docs` 只剩本记录自身。
- `npx playwright test e2e/library-v2.spec.ts` 4 passed（引用面板、修订历史、文件夹树三组断言），
  跑在工作树自建的 `data/ontoflow.db`（`db:push` + `db:seed`，只有平台基线）上，独立端口 3593。
- 付费冒烟：不适用，改动不触及会话 / 事件 / 用量 / 取消 / 组合四处接缝。
