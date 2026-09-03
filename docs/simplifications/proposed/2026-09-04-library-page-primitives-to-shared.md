# 简化：四个库页各自抄的四段原语归位到 src/components/library/

状态: proposed

## 问题

`folderRefFrom` / `FolderBadge` / `RefCount` / `formatUsedBy` 在四个库页里**逐字重复四份**：

```
$ rg -n "^function formatUsedBy|^export function formatUsedBy|^function folderRefFrom|^function FolderBadge|^function RefCount" src/app/*/page.tsx src/app/actions/shared.tsx
src/app/actions/shared.tsx:93       export function formatUsedBy
src/app/object-types/page.tsx:27,41,319,350   formatUsedBy / folderRefFrom / FolderBadge / RefCount
src/app/skills/page.tsx:27,41,303,334          同上
src/app/tools/page.tsx:27,41,310,341           同上
src/app/actions/page.tsx:54,430,461            folderRefFrom / FolderBadge / RefCount
```

四份 `folderRefFrom`（15 行）与四份 `FolderBadge`（29 行，含同一段 SVG `path d="M1.75 4.25c0-.83…"`）
逐字比对**无一字之差**；`RefCount` 四份完全一致；`formatUsedBy` 是三份私有副本 + `shared.tsx:93` 一份
导出版（`actions/page.tsx:28` 从它 import），四份同样一字不差。归一实体名后 `skills/page.tsx` 与
`tools/page.tsx` 差 19 行 / 约 345 行，即约 95% 相同。

**生产消费者：** `folderRefFrom` 是四页「新建时的默认归属」；`FolderBadge` / `RefCount` 是四页的实体
卡片；`formatUsedBy` 是四页删除失败（409）的行内错误文案，如 `src/app/skills/page.tsx:165-168`。

**测试 / 文档消费者：** `e2e/library-v2.spec.ts:78`（「进入文件夹「…」」= `FolderBadge` 的 `title`）、
`e2e/library-v2.spec.ts:201` 与 `e2e/tools.spec.ts:232`（「N 处引用」= `RefCount`）、
`e2e/object-types.spec.ts:139`（409 文案，经 `formatUsedBy` 拼出）；
`rg -l "folderRefFrom|FolderBadge|RefCount|formatUsedBy" docs README.md AGENTS.md .github` → **无命中**。

**打败了哪条已记录的理由：** `AGENTS.md:151` 与 `.github/REVIEW.md:53` 把规则写成一份**枚举**——「no
page grows its own **tree, toolbar, folder picker, or revision panel**」。四份重复正好卡在枚举的缝里：
它们不是树、不是工具栏、不是选择器、不是修订面板，所以四次复制都合规通过了评审。但
`docs/DESIGN-V2.md:130` 的标题写的是理由本身——「五个库页面**必须复用，不得各写一套**」。枚举是漏洞，
理由覆盖了这四段：改一次文件夹徽章的图标要改四个文件，改 409 文案要改四处。

## 提议

新增 `src/components/library/entity-card.tsx`（`FolderBadge` + `RefCount`），在
`src/components/library/types.ts` 里加 `folderRefFrom`、`formatUsedBy`（两者都是纯函数，与 `formatTime` /
`readError` 同层），从 `index.ts` 桶导出；四个库页删掉自己的四份，改 import。
`src/app/actions/shared.tsx:93` 的 `formatUsedBy` 一并删除，`actions/page.tsx:28` 改从桶取。

连带要改：

- `docs/DESIGN-V2.md` 第五节：`<FolderBadge>` / `<RefCount>` 加进共享组件清单，`folderRefFrom` /
  `formatUsedBy` 记在同节末尾。
- `AGENTS.md:151` 与 `.github/REVIEW.md:53`：把枚举改成「no page grows its own list/folder/reference/
  revision UI」这类不再逐项列举的写法，否则下一段重复照样合规。
- `src/rules.test.ts` 不需要新断言（`rg -n "components/library" src/rules.test.ts` 无命中）；若想机械化，
  可加一条「四个库页面里不出现 `function FolderBadge|RefCount|folderRefFrom|formatUsedBy`」的文本扫描
  ——那要与 REVIEW.md 一起加，属本候选的可选项。
- e2e 一行不改（断言全在 DOM 文本与 API 载荷上）。
- 与 [Kind / EFFORT_LABEL 各只留一份](2026-09-04-one-kind-badge-one-effort-label.md) 共用同一个
  `entity-card.tsx`，两条一起实施更省事。

## 放弃了什么

四页各自微调卡片副信息的自由：今天 `actions/page.tsx` 的卡片比其余三页多两行端口徽章，如果将来某一页
想让「N 处引用」显示成别的样子，就得给共享组件加参数（那正是「无主人的可配置性」的开头）。归位后第一次
分歧要靠**再拆出来**解决，而不是加开关。

## 验收

`npm run check`、`npm run build`；`npx playwright test e2e/library-v2.spec.ts`（同时覆盖 `FolderBadge`
的 title 与 `RefCount` 的文案），再各跑一遍
`e2e/actions.spec.ts e2e/skills.spec.ts e2e/tools.spec.ts e2e/object-types.spec.ts`
（`object-types.spec.ts:139` 是 `formatUsedBy` 的唯一 e2e 断言）。不碰四处高代价接缝，无需付费冒烟。

## 风险

低。纯客户端搬家，无 API、无 schema、无引擎。唯一的行为差异风险是 Tailwind 类名抄错——四份源文本逐字
相同，整段搬即可；`npm run build` 会抓到类名拼错导致的编译问题，视觉由上面四个 spec 的可见性断言兜底。

预估净删约 180 行（移出约 65 行到共享模块，四页各减约 60 行）；风险等级：低。
