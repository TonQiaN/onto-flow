# 简化：Action / 对象类型 / Skill / Tool 的前端 DTO 只声明一份

状态: proposed

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
[Kind / EFFORT_LABEL 各只留一份](2026-09-04-one-kind-badge-one-effort-label.md) 一起做则整文件可删）；
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
