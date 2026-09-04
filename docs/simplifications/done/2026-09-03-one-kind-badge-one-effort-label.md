# 简化：Kind / KIND_STYLE / KindBadge 与 ReasoningEffort / EFFORT_LABEL 各只留一份

状态: done

## 问题

两组常量在两处逐字重复：

```
$ rg -n "^export (interface|type|const) (KIND_STYLE|Kind|ReasoningEffort|EFFORT_LABEL)\b" src
src/app/actions/shared.tsx:3    export type Kind = "text" | "file" | "json";
src/app/actions/shared.tsx:4    export type ReasoningEffort = "off" | "low" | "high" | "max";
src/app/actions/shared.tsx:70   export const EFFORT_LABEL
src/app/actions/shared.tsx:77   export const KIND_STYLE
src/app/object-types/object-type-editor.tsx:17  export type Kind（同一 union）
src/app/object-types/object-type-editor.tsx:30  export const KIND_STYLE
src/components/canvas/node-model.ts:9   export type ReasoningEffort（同一 union）
src/components/canvas/node-model.ts:18  export const EFFORT_LABEL
```

`KIND_STYLE` 两份的三条 Tailwind 类串（`border-sky-200 bg-sky-50 text-sky-700` 等）逐字相同；
`EFFORT_LABEL` 两份的四条中文（关闭 / 低 / 高 / 最大）逐字相同；`KindBadge` 也是两份
（`shared.tsx:83`、`object-type-editor.tsx:36`），**唯一差别是 `shared.tsx` 那份多一个 `shrink-0`**。

**生产消费者：**

- `shared.tsx` 那组：`src/app/actions/page.tsx:29,359,373`（`KIND_STYLE`）、
  `src/app/actions/action-editor.tsx:36,948`（`KindBadge`）、`action-editor.tsx:39,166,571`
  （`ReasoningEffort`）、`src/app/actions/page.tsx:27,383`（`EFFORT_LABEL`）。
- `object-type-editor.tsx` 那组：`src/app/object-types/page.tsx:23,254`（`KindBadge`）、
  `object-type-editor.tsx:39`（自用 `KIND_STYLE`）。
- `node-model.ts` 那组：`src/components/canvas/flow-node.tsx:24,330`（`EFFORT_LABEL`）、
  `src/app/workflows/[id]/types.ts:11,37`（`ReasoningEffort`）。

**测试 / 文档消费者：** `rg -l "KIND_STYLE|KindBadge|EFFORT_LABEL" e2e docs README.md AGENTS.md .github`
→ **无命中**。

**打败了哪条已记录的理由：** `src/components/canvas/node-model.ts:1-5` 的抬头写明它是「画布节点的共享
模型……编辑器与运行页画的是同一套节点，这里只放两边都要的东西」，并且**已经**持有 `PortKind`（与 `Kind`
同一 union）、`KIND_LABEL`、`ReasoningEffort`、`EFFORT_LABEL`。共享的家已经存在且已被承认，
`shared.tsx` 与 `object-type-editor.tsx` 的两份是它成立**之前**留下的。而 `src/app/actions/shared.tsx:1`
的注释「仅本目录使用」今天仍为真——它不知道 `node-model.ts` 已经有同名同值的一份。

## 提议

- `src/app/actions/shared.tsx` 删掉 `ReasoningEffort`（`:4`）与 `EFFORT_LABEL`（`:70-75`），让
  `action-editor.tsx` / `actions/page.tsx` 直接从 `@/components/canvas/node-model` 取（**推荐**，而不是
  在 `shared.tsx` 里 re-export——后者会让「仅本目录使用」那句话变成半真）。
- `Kind` 与 `PortKind` 收成一个名字（保留 `node-model.ts` 的 `PortKind`）；`KIND_STYLE` + `KindBadge`
  移到 `src/components/library/entity-card.tsx`（与
  [四段库页原语归位](2026-09-03-library-page-primitives-to-shared.md) 同一个新文件，两条合并实施更省事），
  两处调用点改 import；`shrink-0` 保留（多一个 flex 约束对 `object-types/page.tsx:254` 的卡片无害）。
- 连带：`src/app/object-types/page.tsx:23` 的 import 来源变化；`src/app/workflows/[id]/types.ts:9,53` 的
  `PortKind` 引用不变；`AGENTS.md:29` 描述 `src/components/canvas/` 的那行可加半句说明它也是配色 / 文案
  的家（可选）。e2e、`src/rules.test.ts` 无需改。

## 放弃了什么

对象类型库与 Action 库各自调整徽章样式的自由：今天两处的类串恰好一致，合并后要分歧就得再拆。以及
`shared.tsx` 的「仅本目录使用」这句自洽性（按推荐做法直接改调用点，这句仍然为真）。

## 验收

`npm run check`、`npm run build`；`npx playwright test e2e/object-types.spec.ts`（`KindBadge` 的唯一 e2e
落点）与 `e2e/actions.spec.ts`（思考强度文案与端口徽章）。不碰四处高代价接缝。

## 风险

低。纯客户端常量搬家，`typecheck` 是完整的门。

预估净删约 27 行；风险等级：低。

## 落地

[PR #38](https://github.com/TonQiaN/onto-flow/pull/38)。与 [四段库页原语归位](2026-09-03-library-page-primitives-to-shared.md) 合成同一个 PR 落地——
两条共用新文件 `src/components/library/entity-card.tsx`，提议里就写了「两条合并实施更省事」。

与提议的差异：

- `shared.tsx` 的 `Kind`、`object-type-editor.tsx` 的 `Kind` 都换成了 `node-model.ts` 的 `PortKind`
  （提议的「收成一个名字」）；`shared.tsx` 因此只剩类型、不再含 JSX，但文件名暂留 `.tsx`——下一张卡
  [ActionDto 家族声明了两遍](../proposed/2026-09-03-action-dto-family-declared-twice.md) 会把它整份删掉。
- `AGENTS.md` 描述 `src/components/canvas/` 的那行加了半句（提议标为可选）：说明 `node-model.ts` 也是
  `PortKind` / `ReasoningEffort` 与它们文案的家，库页也从这里取。
- `KindBadge` 只留带 `shrink-0` 的那份，`object-types/page.tsx:254` 的卡片按提议接受这个多余的 flex 约束。

验收实际跑了：与另一条同一份——`npm run check`、`npm run build`、
`npx playwright test -c playwright.clean.config.ts e2e/object-types.spec.ts e2e/actions.spec.ts`
（连同 `library-v2` / `tools` / `skills` 一起 16 通过）。不涉及付费冒烟。
