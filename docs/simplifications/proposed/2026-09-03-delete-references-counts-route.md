# 简化：删掉 /api/references/counts——引用数已随库列表信封下发

状态: proposed

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
