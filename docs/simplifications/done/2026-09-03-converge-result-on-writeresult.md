# 简化：两份私有 Result 与第三份 WriteOutcome 一起收敛到 WriteResult

状态: done

## 问题

这是 `AGENTS.md` 与 `.github/REVIEW.md` **已记录但未落地**的收敛，不是要打败某条理由：

- `AGENTS.md:139`：「`folders.ts` and `revisions.ts` still carry private structurally identical
  `Result<T>` copies — converge on `WriteResult`, never add a fourth.」
- `.github/REVIEW.md` §2 第 1 条同句。

三份表示，结构完全相同，另有第四份已经悄悄长出来：

- `src/server/writers/types.ts:9` `WriteResult<T, Issue>`（多一个可选 `issues`）
- `src/server/folders.ts:28` `Result<T>` + `ok` / `fail`（28-35 行）
- `src/server/revisions.ts:16` `Result<T>` + `ok` / `fail`（16-23 行）
- `src/server/revisions.ts:37` **`WriteOutcome`**——注释自己写着「与 src/server/writers/types.ts 的
  WriteResult 结构兼容」，只做 `EntityWriter` 的返回类型（`revisions.ts:41`）；knip 报它未用

**生产消费者（全部是 route 里手抄的 3 行拆包，`respond()` 一行就够）：**

```
src/app/api/folders/route.ts:31-33            createFolder
src/app/api/folders/[id]/route.ts:20-25       updateFolder
src/app/api/folders/[id]/route.ts:33-35       deleteFolder
src/app/api/folders/assign/route.ts:25-27     assignEntityFolder
src/app/api/revisions/[revId]/route.ts:27-32  patchRevision
src/app/api/revisions/[revId]/restore/route.ts:20-22  restoreRevision
```

对照：另外 12 个 route 已经用 `respond()`（`rg -ln '\brespond\b' src/app/api` → actions、object-types、
skills、tools、workflows、settings、internal/resume-matches）；`settings.ts:18` 与 `resume-match.ts:44`
也已经用 `WriteResult`。顺带 `revisions.ts:50` 的 `hasEntityWriter` 零消费者
（`rg -n '\bhasEntityWriter\b' src scripts e2e` 只有定义行）。

**测试 / 文档消费者：** `src/server/folders.test.ts:10,37`（`import type { FolderDto, Result }` + `unwrap`）。

## 提议

- `folders.ts` / `revisions.ts` 删本地 `Result` / `ok` / `fail`，改
  `import { type WriteResult, writeOk, writeFail } from "@/server/writers/types"`（`settings.ts:18` 的现成
  写法）；函数签名 `Result<X>` → `WriteResult<X>`。
- 删 `revisions.ts:37-39` 的 `WriteOutcome`，`EntityWriter` 改
  `(id, payload) => WriteResult<unknown> | void`（`restoreRevision:156` 的 `outcome.ok === false` 判断不变）。
- 删 `revisions.ts:50-52` 的 `hasEntityWriter`。
- 上面 6 个 route 的拆包改 `return respond(result)`。
- `folders.test.ts:10,37` 改 import `WriteResult`。
- `AGENTS.md:139` 那半句改为「所有写路径统一 `WriteResult`」；`.github/REVIEW.md` §2 第 1 条同步（括号里
  「两份要向 `WriteResult` 收敛」删掉）。`src/rules.test.ts` 无对应断言，不用改。

## 放弃了什么

`folders.ts` / `revisions.ts` 目前对 `@/server/writers/` 零依赖（引用方向是 writers → folders/references）。
收敛后这两个服务模块要 import `writers/types.ts`，方向反过来一点；`types.ts` 只 import `next/server` 与
`@/lib/http`，不构成环。若日后想把 `types.ts` 挪出 `writers/`（例如挪到 `src/server/write-result.ts`），
那是这条候选的自然后续。

## 验收

`npm run check`；`npx vitest run src/server/folders.test.ts`；
`npx playwright test e2e/library-v2.spec.ts`（文件夹树的建 / 改 / 删 / 指派与修订面板的固定 / 备注 / 回滚
都在里面）。不碰四处高代价接缝。

## 风险

低。`respond()` 对 `deleteFolder` / `assignEntityFolder` 的 `Result<{ok:true}>` 会输出 `{"ok":true}`，与
今天的 `NextResponse.json(result.data)` 逐字相同；`restoreRevision` 的 `{revision, restoredFrom}` 同理，
已逐条对比。

预估净删 35 行；风险等级：低。

## 落地

PR [#36](https://github.com/TonQiaN/onto-flow/pull/36)。与提议无差异：`folders.ts` / `revisions.ts` 的私有 `Result` / `ok` / `fail`、`revisions.ts` 的
`WriteOutcome` 与 `hasEntityWriter` 都删了，`EntityWriter` 改成 `(id, payload) => WriteResult<unknown> | void`，
点名的 6 个 route 拆包改 `return respond(...)`，`folders.test.ts` 的 `unwrap` 改吃 `WriteResult`。
`AGENTS.md:139` 与 `.github/REVIEW.md` §2 第 1 条同改；`src/rules.test.ts` 确认无对应断言。

验收（都在自己的工作树、自己的 `data/ontoflow.db` 上跑）：

```
npm run check                                   ✅ typecheck / oxlint / oxfmt / vitest 46 文件 387 通过
npm run build                                   ✅
npx playwright test e2e/library-v2.spec.ts      ✅ 4 passed（文件夹建 / 改 / 删 / 指派、修订面板）
npx playwright test e2e/workflow-editor.spec.ts ✅ 4 passed（含 /api/revisions/[revId]/restore 回滚）
```

另对 3593 上的临时 dev server 逐条核对改动过的 6 个 route 的响应体与状态码：建文件夹 200 / 同名 409 /
改名 200 / 不存在 404、指派 200 `{"ok":true}` / 实体不存在 404、删文件夹 200 `{"ok":true}`、
修订 PATCH 200（pinned+note 落库）/ 非布尔 400 / 不存在 404、回滚 200（对象类型确实回到 v1 内容）/
不存在 404——与改前逐字相同。未跑付费冒烟（不碰引擎接缝）。

顺带发现、本 PR 没做：`src/server/monitor/cleanup.ts:305` 的 `deleteRun` 返回的是行内写死的
`{ ok: true } | { ok: false; status: 404 | 409; error: string }`，形状与 `WriteResult` 相同但没复用；
它的调用方 `api/runs/[id]` DELETE 还包了一层 `try/catch CleanupError`，成功体也不是 `result.data`，
所以不在这条记录点名的范围内，另作候选。
