# 简化：编辑器不再跟随运行

状态: proposed

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
