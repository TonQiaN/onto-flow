# 简化：编辑器不再跟随运行

状态: done

## 问题

看一次运行今天有两处半：画布编辑器（`?runId=` 深链、`use-run-visuals.ts` 701 行、`run-bar.tsx`
275 行含多路切换器）、运行详情页（节点卡片竖排 + 事件日志 + 轨迹面板），监控台 Trace 再画一张甘特。
编辑器画的是**现图**，只对进行中的运行凑合成立；「回画布看动画」只在运行中显示，正是分两处的
结果。生产消费者：导航「运行中」面板与工作流卡片深链画布；`e2e/parallel-ui.spec.ts` 断言画布切换器。

## 提议

按 [ADR-0018](../../adr/0018-run-page-frozen-graph-replay.md)：运行页成为唯一看运行的地方（冻结进
`runs.graph` 的图、单一时间光标、抽屉），编辑器只编排与发起——`?runId=` 解析、`subscribeRun` /
`switchRun`、`runsInFlight` 轮询、`RunVisualsProvider`、`run-bar.tsx`、`use-run-visuals.ts` 从
`src/app/workflows/[id]/` 移除；`flow-node.tsx` / `flow-edge.tsx` 移到 `src/components/canvas/` 共用；
运行对话框成功后跳运行页；导航面板与卡片深链改 `/runs/<id>`。

## 放弃了什么

边编排边看运行；多路并行的切换从画布运行条退到运行列表与导航面板。

## 验收

`workflow-editor.spec.ts` 断言编辑器不再出现运行条 / 切换器元素；`parallel-ui.spec.ts` 改到运行页断言；
`editor.tsx` 净减三百行上下。执行契约：[DESIGN-V3 第 3 批](../../DESIGN-V3.md)。

## 风险

与运行页同一 PR 落地，中间态不存在「两处都没有」的窗口；DESIGN.md「多路运行的界面契约」段同 PR 改写。

## 落地

PR：https://github.com/TonQiaN/onto-flow/pull/23（分支 `cleanup/3-run-page`，[DESIGN-V3 第 3 批](../../DESIGN-V3.md)）。

与提议的差异：

- 提议只说把 `flow-node.tsx` / `flow-edge.tsx` 移到 `src/components/canvas/`，实际连 `canvas-state.tsx`
  与节点模型（端口、配色、状态词）一起移，并新增 `node-visuals.tsx` 作为运行视觉的 Context：
  编辑器不提供 Provider，同一套组件在画布上就是静态图，运行页才把 `visualsAt(t)` 的结果喂进去。
- `use-run-visuals.ts` 不是整体搬走：SSE 订阅那部分成了运行页的 `use-run-stream.ts`，
  「按事件推算节点状态」那部分被纯函数 `visuals-at.ts` 取代——它按轮次行推算，而不是把 SSE 事件
  当增量状态机累积，这是回放能往回拖的前提。
- 提议没提监控台 Trace：轮次表落地后它按节点只画最后一轮，没有它能画而运行页画不了的东西，
  同一批把 `src/app/monitor/trace/`、`/api/monitor/trace/`、`getTrace` 与其单测、layout 标签
  （五标签变四标签）一起删；总览页「最近失败」与日志页的「在 Trace 中查看」两处链接改成运行详情。
- 工作流卡片没有可深链到某一路运行的地方（一个工作流可能有好几路在跑），「运行中」徽标改成链到
  按该工作流筛选的运行列表；逐路深链只在导航侧栏的「运行中」面板上。
- `parallel-ui.spec.ts` 的两条深链用例（归属校验、临时失败重试）随 `?runId=` 解析一起删除——
  它们验的是编辑器跟随运行时的边界，现在没有这条路径了。
