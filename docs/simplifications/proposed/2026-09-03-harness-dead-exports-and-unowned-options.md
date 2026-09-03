# 简化：清掉 harness 层的死导出与无主人的可选项，会话根目录名只留一处

状态: proposed

## 问题

`entries.ts` / `runtime.ts` / `workspace.ts` 三个文件的头注释都写着「移植自 …」——这批可选项面是从
agent-workflow-studio 整段搬过来的上游形状，**从来没有本仓库的主人**，也没有被任何 ADR 或
`docs/harness/` 记录理由保护过。

**生产消费者：无（下表逐条 rg 到调用点，生产、测试、e2e 全无）。**

| 对象 | 证据 |
|---|---|
| `removeRunDir`（`workspace.ts:240`） | `rg -n "removeRunDir" .` 全仓只有定义那一行。删运行目录的真实路径是 `monitor/cleanup.ts:405` 的 `fs.rmSync`；连 `scripts/smoke-harness.ts:78` 都直接 `rm(runDirPath(...))` |
| `composition.ts:40` 的 `export { DEFAULT_COMPOSITION_TOGGLES, type CompositionToggles } from "@/lib/workflow-settings"` | 转出面零导入者：`rg -n 'from "@/server/harness/composition"' src` 只有 `catalog.test.ts` / `composition-boot.test.ts` / `launch.ts` / `api/settings/composition/route.ts`，各自只取 `runCompositionEntries` / `writeRunComposition` / `RunCompositionOptions`；全部 15 处 `DEFAULT_COMPOSITION_TOGGLES` 使用者都直接从 `@/lib/workflow-settings` 引——一个真定义 + 一个空转出残留 |
| `CreateRunWorkspaceOptions.rerunOf`（`workspace.ts:75`） | 只有声明；`createRunWorkspace` 函数体（L134-236）从不读它，全仓没有第二处 |
| `McpServerSpec.reconnect` + `McpServerReconnectSpec`（`entries.ts:58-64,80`）、`McpServerSpec.toolCallTimeoutMs`（`:79`） | 唯一的生产者 `parseMcpServer`（`settings.ts:248-307`）两条 return 分支都不写这两个键 |
| `DeepSeekProviderSpec.models` + `DeepSeekModelSpec`（`entries.ts:119-127,134`）、`.maxTokens`（`:132`） | 两个生产者 `runner.ts:605-608` 与 `api/settings/composition/route.ts:87-90` 都只给 `apiKeyEnv` + 可选 `baseURL` |
| `SessionStatusNotification`（`rpc/types.ts:104`） | `rg -n "SessionStatusNotification" src` 只有定义；`rpc/server.ts` 发 `session.status` 通知时没有用它标注 |
| `RunProcess.statusSeq` getter（`runtime.ts:199`）、`RunProcess.exitInfo` getter（`:142`） | `rg -no "proc\.[a-zA-Z]+" src scripts --glob '!*.test.ts'` 的 15 个命中里没有它们；类内部一律用 `this.#statusSeq` / `this.#exit` |

**两处表示同一事实：** `RUN_SESSIONS_SUBDIR = "sessions"`（`composition.ts:34`）导出了却没人引，而
`src/server/harness/trajectory.ts:277` 硬写 `path.join(runReal, "sessions")`、`scripts/smoke-capabilities.ts:284/288/290`
又硬写三次。会话根目录名实为四处表示。

**只是过度导出（内部有真消费者，去掉 `export` 即可，不删代码）：** `RunProcessError`、`buildChildEnv`、
`RUN_SPILL_SUBDIR`、`WORKSPACE_INSTRUCTIONS_FILE`、`HOME_INSTRUCTIONS_FILE`、`RUN_COMPOSITION_FILE`、
`RUN_WORKSPACE_SUBDIR`、`RUN_HOME_SUBDIR`、`RUN_PLUGINS_SUBDIR`、`RUN_TMP_SUBDIR`、`RunWorkspaceError`、
`MCP_ENTRY_ID_PREFIX`、`removeSkillDir`、`parseSessionJsonl`（只被 `trajectory.test.ts` 引，
`readAgentTrajectory` 内部用）。

**测试 / 文档消费者：** `catalog.test.ts` / `composition-boot.test.ts` / `launch.test.ts` 的夹具会碰到
`RunWorkspace` 的形状；`trajectory.test.ts:682` 与 `e2e/runs.spec.ts:201` 自己拼 `"sessions"` 字面量。

**打败了哪条已记录的理由：** 这批没有记录过理由，`AGENTS.md`「Stance: no compatibility layers」直接适用。

## 提议

- 上表的死代码全删。
- 过度导出的一批去掉 `export` 关键字（不改行数，只让 knip 归零，见
  [knip 归零](2026-09-03-knip-to-zero-then-gate.md)）。
- `RUN_SESSIONS_SUBDIR` 搬到 `workspace.ts`（那里本就住着其余六个 `RUN_*_SUBDIR`），`composition.ts` 与
  `trajectory.ts` 两边引它，`scripts/smoke-capabilities.ts` 同引；`trajectory.test.ts` / `e2e/runs.spec.ts`
  保持字面量（测试自建路径是刻意的）。搬到 `workspace.ts` 而不是让 `trajectory.ts` 引 `composition.ts`，
  是为了不把 `@/lib/workflow-settings`（`composition.ts:27-31` 引它）拉进轨迹模块的依赖图。
- `undici` 依赖与 `longHaulFetch` 幽灵另记一份：
  [删掉 opencode 时代的残留](2026-09-03-remove-undici-and-opencode-era-ghosts.md)。
- `docs/DESIGN.md:247`「运行详情、历史 API、**画布运行条**与轨迹」里的「画布运行条」在第 3 批已删，
  归 [清掉第 3、4 批之后的死导出](2026-09-03-remove-dead-ui-exports-after-batches-3-4.md) 一并改。

## 放弃了什么

MCP 的 `reconnect` / `toolCallTimeoutMs` 与 DeepSeek 的 `models` 目录：将来真要在设置页开这两项时得重新
写 spec 字段与 `mcpCompositionEntry` 的展开（各 2 行）。`RunProcess` 少两个诊断 getter。

## 验收

- `npm run check`（typecheck 会抓住任何漏改的引用）+ `npm run build`。
- `npx vitest run src/server/harness/catalog.test.ts src/server/harness/composition-boot.test.ts`——组合
  三方钉死 + 真起子进程。
- `npm run knip` 在 `src/server/harness/**`、`src/server/engine/**` 上零输出。
- **不必付费冒烟**：删的全是没有调用点的声明，`composition-boot.test.ts` 真起子进程即为组合未受影响的
  证据——PR 描述里按 `AGENTS.md`「The harness seam」写明这一点。

## 风险

低。唯一要当心的是 `RUN_SESSIONS_SUBDIR` 搬家后 `trajectory.ts` 仍须是 DB-free 的纯读盘模块——搬到
`workspace.ts` 正是为此。

预估净删约 45 行生产代码，另有 ~14 个 `export` 关键字消失；风险等级：低。
