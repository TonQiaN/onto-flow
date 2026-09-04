# 简化：Action / 对象类型 / Skill / Tool 的前端 DTO 只声明一份

状态: done

## 问题

同一组接口在客户端被声明 2-3 次：

```
$ rg -n "^export (interface|type) (ObjectTypeRow|SkillRow|ToolRow|ActionDto|ActionPortDto|ModelRow)\b" src/app src/components
src/app/actions/shared.tsx:6,20,38,45,54,63          ActionPortDto ActionDto ModelRow ObjectTypeRow SkillRow ToolRow
src/app/workflows/[id]/types.ts:22,30,53,62,69,77    同一组六个
src/app/object-types/object-type-editor.tsx:19       ObjectTypeRow
src/app/skills/skill-editor.tsx:31                   SkillRow
src/app/tools/tool-editor.tsx:33                     ToolRow
```

两份 `ActionDto` 字段完全对应（`shared.tsx` 多一个 `updatedAt?`）；`shared.ActionPortDto`
（`{id,direction,name,objectTypeId,objectTypeName,kind,position,artifactPath,exitName}`）与
`workflows/types.ActionPortDto extends PortSnapshot` 字段集完全相同；`SkillRow` 两份逐字相同；
`ObjectTypeRow` / `ToolRow` 是超集关系。

**这不是「巧合的同名」——它已经在跨模块传值：** `src/app/workflows/[id]/action-inspector.tsx:19`
import 了 `@/app/actions/action-editor` 的 `ActionEditor`，而 `:23-28` 把 `./types`（工作流那份）的
`ActionDto` / `ModelRow` / `ObjectTypeRow` / `SkillRow` / `ToolRow` 直接传进去；`ActionEditor`
（`src/app/actions/action-editor.tsx:119-149`）的形参类型全部来自 `./shared`。今天能编译**只因为两组形状
恰好结构兼容**——往 `shared.SkillRow` 加一个必填字段，红的会是 `action-inspector.tsx`，而不是加字段的
那一行。

**生产消费者：** `shared.tsx` 那组——`src/app/actions/page.tsx:26,30-33`、
`src/app/actions/action-editor.tsx:34,37,38,40,41`；`workflows/types.ts` 那组——
`src/app/workflows/[id]/editor.tsx:64-69`、`action-inspector.tsx:23-28`、`node-panel.tsx:13`、
`settings/page.tsx:38,40,42`；编辑器那三份——`object-types/page.tsx:23`、`skills/page.tsx:23`、
`tools/page.tsx:23`。

**测试 / 文档消费者：** `src/app/workflows/[id]/types.test.ts:13`（`ActionDto`）；`docs/DESIGN-V2.md`
第四节列的是**服务端修订 payload 字段清单**，不点名这些 TS 接口；`src/app/workflows/[id]/types.ts:1-3`
的抬头写「与 docs/DESIGN.md 的 API 契约（ActionDto / NodeDto / EdgeDto）严格一致」。

**打败了哪条已记录的理由：** `workflows/[id]/types.ts` 的抬头说自己是「Workflow 编辑器模块内共享类型」
——理由是模块自洽。但 `action-inspector.tsx` 已经把这个模块的类型喂给另一个模块的组件，模块边界事实上
已经不成立；「模块内自洽」这个前提被自己的调用点推翻。

## 提议

把 Action 相关的 DTO 家族收到一处（建议 `src/components/library/entity-dto.ts`，因为
`src/components/library/` 已经是「五个库页面共享」的家，且它不属于任何一个页面目录）：`ActionPortDto`
（继承 `node-model.PortSnapshot`）、`ActionDto`、`ModelRow`，以及 `ObjectTypeRow` / `SkillRow` /
`ToolRow` 的**全量**形状（取三处的并集：含 `jsonSchema` / `parameters` / `createdAt` / `updatedAt`，
按各 API 实际返回逐字段核对，**可选字段用 `?` 而不是必填**）。`src/app/actions/shared.tsx`、
`src/app/workflows/[id]/types.ts`、三个编辑器改 import；工作流专有的 `ActionItem` / `NodeDto` /
`EdgeDto` / `WorkflowDetail` / `WorkflowSets` 留在原地。

连带要改：`src/app/workflows/[id]/types.ts:1-3` 抬头改写（它不再是这些类型的家）；
`src/app/actions/shared.tsx:1` 的「仅本目录使用」改写，或整个文件收缩到只剩 `KindBadge` 相关（若与
[Kind / EFFORT_LABEL 各只留一份](2026-09-03-one-kind-badge-one-effort-label.md) 一起做则整文件可删）；
`docs/DESIGN-V2.md` 第五节共享模块清单加一行。e2e、`src/rules.test.ts`、`.github/REVIEW.md` 无需改。

## 放弃了什么

「工作流编辑器只声明它自己要的字段」这条精简：合并后 `editor.tsx` 拿到的 `ToolRow` 会带上 `code`（今天
它不需要），`ObjectTypeRow` 会带上 `createdAt`。以及库页与画布各自演进 DTO 的自由——将来若某一页的 API
真的返回不同形状，就得拆回去。

## 验收

`npm run check`（`typecheck` 是这条候选的主要门：结构兼容一旦被破坏，`action-inspector.tsx` 会红）、
`npm run build`；`npx vitest run "src/app/workflows/[id]/types.test.ts"`；
`npx playwright test e2e/workflow-editor.spec.ts`（画布双击开检查器、保存共享 Action 的那条用例是这条改动
唯一的跨模块运行时路径）与 `e2e/actions.spec.ts`。不碰四处高代价接缝：不动 `resolveWorkflow` /
`startResolvedRun`，纯前端类型。

## 风险

中。范围最广（触到 6 个文件的类型），但全部是编译期变化，`typecheck` 覆盖度接近 100%。真正的风险是
**把并集做大**导致某个页面被迫解析它并不请求的字段——落地时逐个核对每条 API 实际返回哪些字段。

预估净删 50-70 行（保守只合并 `actions/shared.tsx` ↔ `workflows/types.ts` 为 −50，连三个编辑器一起为
−70）；风险等级：中。

## 落地

PR 待开。

与提议的差异：

- `src/app/actions/shared.tsx` **整份删除**（提议给的两条路里的第二条）：上一个 PR 已经把
  `Kind` / `KIND_STYLE` / `KindBadge` / `EFFORT_LABEL` / `formatUsedBy` 搬走，这次六个 DTO 一走它就空了。
- 新文件不 re-export、不留过渡口：`workflows/[id]/types.ts` 只 `import type` 自己要用的那几个，
  `editor.tsx` / `action-inspector.tsx` / `node-panel.tsx` / `settings/page.tsx` 与三个编辑器
  都直接从 `@/components/library` 桶取；`types.test.ts` 的 `ActionDto` 也改从桶取。
- `ActionItem`（`ActionDto` + `folder` + `refCount`）按提议留在 `workflows/[id]/types.ts`；
  `actions/page.tsx` 里那个同形的**局部**别名（`ActionDto & WithLibraryMeta`）也原样留着，它不导出。
- 并集逐字段核对的结论：`ObjectTypeRow`（8 字段）/ `SkillRow`（6）/ `ToolRow`（10）三处都是各库
  **整行**，列表 GET、详情 GET 与 POST / PUT 回包同形（`db.select().from(表)` 与 `.returning().get()`），
  所以 `createdAt` / `updatedAt` / `jsonSchema` / `parameters` / `output` / `timeoutMs` / `code`
  全部必填，没有一个需要 `?`。唯一带 `?` 的是 `ActionDto.updatedAt`——`loadActionDtos` 今天确实不带
  时间戳（`actions/page.tsx` 那行「补上后此处自动显示」的注释仍然成立）。
- 顺带：`ToolRow.parameters` 从 `unknown` 收成 `Record<string, unknown>` 后，`toolTokenEstimate`
  里的 `tool.parameters ?? {}` 成了类型上不可能为空的防御，一并去掉。
- `src/server/writers/action.ts` 的同名 `ActionDto` **不动**：客户端不从 `@/server` 导入运行时值，
  那道边界比这里的去重优先；两份的关系写进了 `entity-dto.ts` 的抬头。

验收实际跑了：`npm run check`（typecheck 是这条的主门，全绿）、`npm run build`、
`npx vitest run "src/app/workflows/[id]/types.test.ts"`（8 通过）、
`npx playwright test -c playwright.clean.config.ts e2e/workflow-editor.spec.ts e2e/actions.spec.ts`
（5 通过），另跑了受影响的
`e2e/workflow-settings.spec.ts e2e/skills.spec.ts e2e/tools.spec.ts e2e/object-types.spec.ts
e2e/library-v2.spec.ts`（19 通过）。不涉及付费冒烟。
