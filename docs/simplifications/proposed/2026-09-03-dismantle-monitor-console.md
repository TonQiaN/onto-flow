# 简化：监控台拆散归位，只留系统健康一页

状态: proposed

## 问题

监控台六个标签自带一套深色外壳与 545 行专用原语（`src/app/monitor/ui.tsx`），是仓库里的第二套
视觉系统；`src/server/monitor/metrics.ts` 1046 行，八条 `/api/monitor/*` 路由没有书面契约。逐标签看
消费者：总览（进行中计数导航面板已有；24 小时图无人据此行动）、实时会话（导航「运行中」面板与
运行页直播说同一件事）、Trace（节点 / 会话层是运行页回放要的时间轴，step 层与轨迹抽屉重叠）、
日志检索（跨运行 LIKE 搜 `run_events`）、成本分析（缺按工作流口径）、系统健康（唯一的破坏性路径，
必须留）。生产消费者只有系统健康页的清理面板；其余页面只有 `e2e/monitor.spec.ts` 在断言。

## 提议

成本 → 运行列表页的筛选汇总（当前筛选范围的运行数 / token / 费用 + 按模型小表；第一次有了按工作流
口径）。Trace → 运行页的时间轴（ADR-0018）。总览、实时会话、日志检索 → 删除。`/monitor` 只剩
系统健康一页（引擎、磁盘、孤儿运行、孤儿实体、清理面板），用工作台普通外壳；`/api/monitor/*` 缩到
health 与 cleanup；`metrics.ts`、`use-monitor-stream.ts`、SSE stream、暗色外壳与专用原语删除；
`rules.test.ts` 的 raw-sql 允许名单去掉 `metrics`。

## 放弃了什么

跨运行关键词搜事件——找一次失败的路径改为「列表筛失败 + 时间段 → 运行页概要栏错误 → 抽屉轨迹」；
将来需要时作为运行列表的 `q=` 筛选再加。24 小时趋势图。

## 验收

`rg -n "monitor/(overview|sessions|stream|logs|trace|cost)" src e2e docs` 无结果；`monitor.spec.ts`
只剩导航与系统健康用例并全绿；Chrome 里清理面板三项 dryRun 预览成功。
执行契约：[DESIGN-V3 第 2、3、4 批](../../DESIGN-V3.md)。

## 风险

碰 `monitor/cleanup.ts`（高代价接缝）只搬页面不改逻辑，验收含 dryRun 证据。`LIKE … escape '\'`
规则的另一处使用者 `writers/list.ts` 仍在，AGENTS.md 那条规则保留。
