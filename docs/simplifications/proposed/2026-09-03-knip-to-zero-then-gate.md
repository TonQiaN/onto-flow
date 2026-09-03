# 简化：把 knip 归零并加进 CI 门禁——一个配置开关、两个桶、十二个真死导出

状态: proposed

## 问题

[DESIGN-V3](../../DESIGN-V3.md) 给第 5 批定的交付物：「knip 的误报在本轮调零后，把 `npm run knip` 加进
CI `check` 作业并在 `AGENTS.md` 门禁句里补上」。`AGENTS.md:111` 也写着「`npm run knip` is a hint
generator for `find-simplifications`, not a gate, until its false positives are down to zero」。今天的
输出是 **1 unused dependency + 63 unused exports + 66 unused exported types = 130 条**。

用一份放在 scratchpad 的探针配置实测（**没有改仓库里的 `knip.json`**）：

```
$ npx knip --config <scratchpad>/knip-probe.json     # 只比现配置多一行 "ignoreExportsUsedInFile": true
Unused dependencies (1)   Unused exports (22)   Unused exported types (10)
```

**130 → 33。** 也就是 **97 条（75%）是同一类误报：「导出了，但只在本文件里用」**——`e2e/helpers.ts` 被
点名的七个（`DB_PATH`、`firstModelId`、`buildLinearGraph`、`GraphNodeInput`、`GraphEdgeInput`、
`RunFixtureNode`、`RunFixtureRound`）全部属于这一类，逐个 `rg` 复核过：

```
$ rg -n "\bbuildLinearGraph\b" e2e src scripts
e2e/helpers.ts:311   export function buildLinearGraph(input: {
e2e/helpers.ts:396     const graph = buildLinearGraph(input);   ← createWorkflowGraph 在用，spec 经它间接用
```

它们不是残留：`createWorkflowGraph` 被 `workflow-editor.spec.ts:11/76/390/447` 用，`linearRunGraph` 被
`workflow-editor.spec.ts:457` 与 `parallel-ui.spec.ts:93` 用；`RunFixtureNode` / `RunFixtureRound` 是
`SyntheticRunInput` 的字段类型，`insertSyntheticRun` 被 `runs.spec.ts` / `monitor.spec.ts` /
`parallel-ui.spec.ts` 各用 5 处。

**剩下 33 条里，12 条是真死代码，20 条是两个桶的死再导出：**

- **真死（全仓零引用）**：`src/lib/values.ts:20 portValueToDisplay`（端口值展示已由
  `src/app/runs/[id]/port-value-view.tsx` 承担）· `src/server/harness/workspace.ts:240 removeRunDir` ·
  `src/server/references.ts:86 entityLabel` 与 `:101 entityName` · `src/server/revisions.ts:50
  hasEntityWriter` · `src/app/runs/lib.ts:162 RunDetailResponse` ·
  `src/server/harness/tool-contract.ts:95 ToolExecute` · `src/components/library/types.ts:8
  ENTITY_KIND_LABEL` 与 `:17 ENTITY_KIND_PATH` · `src/app/runs/status-badge.tsx:53 STATUS_DOT` ·
  `src/app/workflows/[id]/types.ts:222 portSignature` · `src/server/harness/composition.ts:40` 再导出
  `DEFAULT_COMPOSITION_TOGGLES` / `CompositionToggles`
- **死再导出（桶）**：`src/components/library/index.ts` 14 条（页面直接 import `./types`）·
  `src/server/writers/index.ts:23-28` 6 条（`rg -n 'from "@/server/writers"' src scripts e2e` **零结果**，
  路由一律 `import { writeTool } from "@/server/writers/tool"`；该文件的注册副作用
  `registerEntityWriter × 5` 与 `rules.test.ts:276` 的「每种 `EntityKind` 一个注册写入器」断言不受影响）
- **唯一的 unused dependency**：`undici`（见
  [删掉 opencode 时代的残留](2026-09-03-remove-undici-and-opencode-era-ghosts.md)）

**生产消费者：** 上列 12 条全部为零；两个桶的再导出无人经桶引用。
**测试 / 文档消费者：** [DESIGN-V3](../../DESIGN-V3.md) 第 5 批一句、`AGENTS.md:111` 一句、
`.github/REVIEW.md` §0（今天不含 knip）。

## 提议

四步，配置与门禁一个 PR，删除分散在各领域记录里：

1. **`knip.json` 加一行** `"ignoreExportsUsedInFile": true`（保守派可写
   `{ "interface": true, "type": true }` 只放过类型——类型出现在导出函数签名里时必须导出，那才是纯误报）。
   **推荐 `true`**：本仓没有对外发布面，「本文件自用还挂 export」是噪声而非信号；真要收紧，收紧的方式是
   删 `export` 关键字，那是 100 处一次性提交，不该由 knip 天天报。
2. **删除动作分派到各领域记录**，本记录只做统计与门禁：harness 侧的 `removeRunDir` / `composition.ts:40`
   / `ToolExecute` 归 [harness 死导出与无主人的可选项](2026-09-03-harness-dead-exports-and-unowned-options.md)；
   客户端侧的 `RunDetailResponse` / `STATUS_DOT` / `portSignature` / `ENTITY_KIND_*` 与库桶 14 条归
   [清掉第 3、4 批之后的死导出](2026-09-03-remove-dead-ui-exports-after-batches-3-4.md)；
   `hasEntityWriter` 归 [两份私有 Result 收敛](2026-09-03-converge-result-on-writeresult.md)。
3. **本记录自己做的**：`src/server/writers/index.ts:23-28` 的 6 条再导出、`src/lib/values.ts:20
   portValueToDisplay`、`src/server/references.ts:86 entityLabel` / `:101 entityName`。
4. **然后**把 `npm run knip` 加进 `.github/workflows/ci.yml` 的 `check` 作业（**只加步骤，不改作业名**
   `typecheck · vitest · build`，分支保护按名字认），`package.json` 的 `check` 脚本同加，`AGENTS.md:90`
   / `:111` 与 `.github/REVIEW.md` §0 各补一行。

**已考察但不作为删除项：** `src/server/harness/tool-contract.ts` 的 `ToolContext.dataDir` / `.dbPath`
今天零生产消费者（两个种子 Tool 都不用；`rg -n "ctx\.dbPath|ctx\.dataDir" src scripts --glob '!*.test.ts'`
只剩 `src/app/tools/tool-form.ts:146-147` 的模板注释），但 [ADR-0017](../../adr/0017-tool-is-a-contract.md)
把 `ToolContext` 定为 **Tool 作者看到的稳定公开面**——**有主人的公开面不是死代码**，归零要靠
`knip.json` 的 ignore 而不是删字段。同理 `ToolRunOptions` / `ToolRunSandbox` / `ToolRunResult`。
`src/server/harness/boot.ts` / `identity.ts` / `runner.ts` / `rpc/**` 是**动态装载路径**（组合按绝对路径
include，`identity.ts:16` 的 `rpcPluginModulePath()`），knip 视角的「未用文件」，生产必需。

## 放弃了什么

`ignoreExportsUsedInFile: true` 之后，knip 不再提醒「这个 export 多余」。真想清掉那 100 处多余的 `export`
关键字，得靠人工或 oxlint 规则。把 knip 变成门禁后，任何新的「导出了没人用」都会挡住 PR——好处是零残留，
代价是写实验性代码时要先删 `export` 才能推上去。

## 验收

`npm run knip` 退出 0、输出为空；`npm run check`（含新加的 knip 步）本地与 CI 全绿；`npm run build`；
`npx playwright test e2e/library-v2.spec.ts e2e/skills.spec.ts`（碰桶文件）。不碰四处高代价接缝。

## 风险

桶收窄前必须由对应领域复核 knip 的判断（`EntityKind` 有 45 处引用，只是都不经桶）；`typecheck` 会立刻
抓到任何误删。门禁上线要等其余各领域的删除记录都落地，否则 CI 会因为它们尚未清掉而红——**本记录的第 4 步
必须是本轮最后一个合并的 PR**。

预估净删约 45 行（20 行桶 + 25 行本记录自做的死导出），配置 +1 行、CI +1 步；风险等级：低。
