# 简化：把客户端与写入口手抄两份的纯常量与纯校验搬进 src/lib/

状态: done

## 问题

同一事实抄在两处，共 4 组。记录下来的理由是「客户端不能从 `@/server` 导入运行时值」——这条**前提为真、
结论不成立**：`src/lib/` 就是 `AGENTS.md` 布局里那层「pure, DB-free」的共享层，客户端已经在从它导入运行
时值：

```
src/app/skills/skill-editor.tsx:21        import { estimateTokens } from "@/lib/workflow-settings";
src/app/runs/[id]/use-run-stream.ts:17    import { EMPTY_RUN_GRAPH, parseRunGraph } from "@/lib/run-graph";
src/app/runs/[id]/settings-snapshot-view.tsx:15  import { COMPOSITION_TOGGLE_LABELS } from "@/lib/workflow-settings";
```

`skill-editor.tsx` 这个文件本身既 import `@/lib/workflow-settings` 的运行时值、又 import 手抄的
`./skill-files`——同一个客户端文件里两种做法并存，正好说明手抄不是边界要求。

**① Skill 资源文件规则**（server `src/server/writers/skill.ts:7-62` ↔ client
`src/app/skills/skill-files.ts:7-43`）：两侧 `SKILL_FILE_MAX_COUNT=32` / `SKILL_FILE_MAX_BYTES=1MiB` /
`SKILL_FILE_PATH_MAX_LENGTH=200` 与 `skillFilePathProblem` / `foldSkillPath|foldPath` **逐字符相同**
（含中文错误文案与 `oxlint-disable-next-line no-control-regex` 注释）。client 文件 1-5 行就写着「上限与
路径规则在两处各写一份……改一处必须同步另一处」——这句话本身是这条候选要消掉的成本。
生产消费者：server 侧 `writers/skill.ts:78,88`；client 侧 `skill-editor.tsx:25,166`、`skill-files.ts:53,57`。
测试消费者：`src/app/skills/skill-files.test.ts:6,76,88`。**这一对今天没有任何测试钉住两份一致。**

**② Tool 公名与保留名**（server `src/server/harness/tool-contract.ts:8,17,38` ↔ client
`src/app/tools/tool-form.ts:10,13,31`）：`tool-contract.ts` 的头注释第 4 行自称「这个文件只有类型与常量，
服务端、客户端与运行子进程都能导入」——**这句与仓库强制的边界规则冲突**：`src/rules.test.ts:140` 断言
`"use client"` 文件与 `src/app` / `src/components` 下的共享模块不得从 `@/server` 导入运行时值。于是
client 抄了一份，再由 `src/app/tools/tool-form.test.ts:21-28` 一整个 describe 钉住两份一致——**一个只为
守住一份重复而存在的测试**。生产消费者：server `writers/tool.ts:4-6,40,46,52`、`harness/tool-plugin.ts:31,81`；
client `tool-form.ts:103-108`（`publicNameProblem`）。

**③ `objectSchemaProblem` 的形状半边**（server `src/server/harness/tool-schema.ts:9-41` ↔ client
`src/app/tools/tool-form.ts:35-66`）：`isPlainObject` + `findTypeArray` + 前两条检查逐字符相同；server 版
在 41 行之后多一段上游 `assertObjectJsonSchema`。

**④ 排序键与页长**（server `src/server/writers/list.ts:23-33` ↔ client
`src/components/library/types.ts:34-45`）：`SortKey` 五个值与 `DEFAULT_PAGE_SIZE = 30` 两处各写一遍。
server 侧的 `SORT_KEYS` / `SortKey` / `DEFAULT_PAGE_SIZE` / `MAX_PAGE_SIZE` 只在 `list.ts` 内部用。注意
`.github/REVIEW.md` §4 有一条断言式的话「没有第二处写死 30 / 100」——`src/components/library/types.ts:45`
就是第二处，那条评审项今天是假的。

## 提议

新建三到四个 `src/lib/` 纯模块（无 DB、无 `next/server`、无 `@deepseek-ai`）：

- `src/lib/skill-files.ts`：三个常量 + `skillFilePathProblem` + `foldSkillPath`。`writers/skill.ts` 与
  `app/skills/skill-files.ts` 都从它 import；client 侧只留 `SkillFileDraft` / `skillFilesProblem`（按
  `size` 判）/ `formatBytes` / `defaultFilePath` 这些浏览器专属部分，server 侧只留 base64 / Buffer 那半边。
- `src/lib/tool-names.ts`：`TOOL_PUBLIC_NAME_PATTERN` / `TOOL_RESERVED_PUBLIC_NAMES` /
  `TOOL_RESERVED_PUBLIC_NAME_PREFIX` / `publicNameProblem` / `toolCodeProblem`。`harness/tool-contract.ts`
  改为从它 re-export（`ToolContext` 类型面不动——`TOOL_EXECUTE_TEMPLATE` 里的
  `import type { ToolContext } from "@/server/harness/tool-contract"` 保持）；顺手改掉 `tool-contract.ts:4`
  那句与边界规则冲突的「客户端……都能导入」。
- `src/lib/json-schema-shape.ts`：`objectSchemaProblem` 的形状半边；`harness/tool-schema.ts` 调它再加上游
  断言，`tool-form.ts` 直接用它。
- `list.ts` 的 `SORT_KEYS` / `SortKey` / `DEFAULT_PAGE_SIZE` / `MAX_PAGE_SIZE` 搬进 `src/lib/`（server 不
  该 import `src/components`），两侧共用。

连带要改：删 `src/app/tools/tool-form.test.ts:21-28` 那个 describe（不再有两份可钉）；
`src/app/skills/skill-files.test.ts` 保留（它测的是行为，不是一致性）；`AGENTS.md:168` 的
「`toolCodeProblem` in `src/app/tools/tool-form.ts` is the client mirror」与 `:169` 的
「mirrored client-side in `src/app/tools/tool-form.ts`」改写为「一份在 `src/lib/`，两侧共用」；
`.github/REVIEW.md` §6 最后两条与 §4 的「没有第二处写死 30 / 100」同步；`src/rules.test.ts:140` 的边界
断言不受影响（`@/lib` 从来不在禁止清单里）。与
[删掉 writers/json-schema.ts 垫片](2026-09-03-drop-writers-json-schema-shim.md) 一起落地时，
`AGENTS.md:169` 的点名一次改到位。

## 放弃了什么

「客户端可以更宽松 / 文案可以不同」的自由度——今天两侧文案本来就逐字相同，但共享后想让编辑器提前给更
友好的提示就得改共享模块。还有：`src/lib/` 会因此长出三四个小模块，从「图 / 值 / http / 设置 / 摘要」
五件事变成八九件事。

## 验收

`npm run check`（含 `rules.test.ts` 的客户端边界断言）、`npm run build`；
`npx vitest run src/app/tools/tool-form.test.ts src/app/skills/skill-files.test.ts src/server/writers/skill.test.ts src/server/writers/tool.test.ts src/server/harness/tool-plugin.test.ts`；
`npx playwright test e2e/tools.spec.ts e2e/skills.spec.ts`。不碰四处高代价接缝：`tool-schema.ts` 的上游
`assertObjectJsonSchema` 调用原样保留，`@deepseek-ai` 仍只在 `harness/` 被 import——`npm run check` 与
`composition-boot.test.ts` 会证明。

## 风险

中。最大的坑是「`@deepseek-ai` 只许在 `harness/` import」这条规则——**只搬纯常量与纯形状检查，
`assertObjectJsonSchema` 那段一行不动**，`src/lib/` 里不出现任何 `@deepseek-ai`。其次是
`tool-contract.ts` 若改成 re-export，`tool-plugin.ts:31` 与 `writers/tool.ts:4-6` 的 import 路径要一起看。

预估净删 120-140 行（新增 `src/lib/` 约 +90，删重复约 −220）；风险等级：中。

## 落地

PR [#47](https://github.com/TonQiaN/onto-flow/pull/47)。四组手抄按提议全部收敛到 `src/lib/`：

- `src/lib/skill-files.ts`：两个导出上限 + 内部的 `SKILL_FILE_PATH_MAX_LENGTH` + `skillFilePathProblem` +
  `foldSkillPath`。`writers/skill.ts` 与 `app/skills/skill-files.ts` 各自只留自己那半边（前者 base64 /
  Buffer，后者 `size` / `formatBytes` / `defaultFilePath` / `base64ByteLength`）。
- `src/lib/tool-names.ts`：`TOOL_PUBLIC_NAME_PATTERN` + 保留名清单与 `mcp__` 前缀（两者只有
  `publicNameProblem` 用，不外露）+ `publicNameProblem` + `toolCodeProblem`。`writers/tool.ts` 的三段
  inline 判断与 `FORBIDDEN_IMPORT` 常量删掉，改调这两个函数；`tool-plugin.ts` 与 `tool-editor.tsx` 也改到它。
- `src/lib/json-schema-shape.ts`：`objectSchemaShapeProblem`（形状半边）。`harness/tool-schema.ts` 先调它
  再跑上游 `assertObjectJsonSchema`（那段一行没动），`tool-form.ts` 直接用它。
- `src/lib/list-query.ts`：`SORT_KEYS` / `SortKey` / `isSortKey` / `DEFAULT_SORT` / `DEFAULT_PAGE_SIZE` /
  `MAX_PAGE_SIZE`。`writers/list.ts` 与 `components/library/types.ts` 共用；`SORT_OPTIONS` 改成由
  `SORT_KEYS` 加一张 `Record<SortKey, string>` 标签表生成，五个键因此只列一遍，`parseListQuery` 的
  inline `includes` 也换成共享的 `isSortKey`。

### 与提议的差异（两处，都写在这里）

1. **`tool-contract.ts` 不做 re-export，改为删掉那三个常量、消费方直接从 `@/lib/tool-names` 取。**
   记录原文写的是「`harness/tool-contract.ts` 改为从它 re-export」。纯转出垫片正是同一批
   [删掉 writers/json-schema.ts 这层垫片](2026-09-03-drop-writers-json-schema-shim.md) 要拆的东西，
   AGENTS.md 的立场也是「不加兼容层、删掉旧路径」，所以这里直接改三个消费方
   （`writers/tool.ts`、`harness/tool-plugin.ts`、`app/tools/tool-editor.tsx`），不新造一层。
   `ToolContext` 那套类型面与 `TOOL_RUN_*` 超时常量原地不动——`TOOL_EXECUTE_TEMPLATE` 里那行
   `import type { ToolContext } from "@/server/harness/tool-contract"` 因此仍然有效。
2. **`src/lib/` 里的形状函数改名 `objectSchemaShapeProblem`。** `harness/tool-schema.ts` 仍导出
   `objectSchemaProblem`（形状 + 上游断言），两个同名不同强度的函数会误导调用方。

### 验收

```
npm run check                       ✅ typecheck / oxlint / oxfmt / vitest 46 文件 386 通过 1 跳过
npm run build                       ✅
npx vitest run src/app/tools/tool-form.test.ts src/app/skills/skill-files.test.ts \
  src/server/writers/skill.test.ts src/server/writers/tool.test.ts \
  src/server/harness/tool-plugin.test.ts src/rules.test.ts        ✅ 6 文件 78 通过
npx playwright test e2e/tools.spec.ts e2e/skills.spec.ts          ✅ 7 passed
```

`npm run knip` 的「Unused exports」从 56 降到 49，本 PR 没有新增任何一条：搬进 `src/lib/` 后只剩
本模块自己用的三个常量（`SKILL_FILE_PATH_MAX_LENGTH`、保留名清单、`mcp__` 前缀）都改成不导出。

不碰的四处高代价接缝已核对：`tool-schema.ts` 的 `assertObjectJsonSchema` 调用一行没动，
`rg '@deepseek-ai' src/lib` 为空（`tool-names.ts` 里只有 `toolCodeProblem` 拿它当**字符串**比对），
`src/lib/` 也没有 `@/db` / `@/server` 的 import。未跑付费冒烟。
