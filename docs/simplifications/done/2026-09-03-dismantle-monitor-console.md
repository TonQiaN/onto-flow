# 简化：监控台拆散归位，只留系统健康一页

状态: done

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

## 落地

PR：待补（分支 `cleanup/4-monitor-health-only`，[DESIGN-V3 第 4 批](../../DESIGN-V3.md)）。
成本 → 运行列表汇总在第 2 批落地，Trace → 运行页时间轴在第 3 批落地，本批只做最后一步：
删总览 / 实时会话 / 日志检索，把系统健康页归位成 `/monitor` 自己。

与提议的差异：

- 提议只说「用工作台普通外壳」，实际是整页换色：`layout.tsx` 的深色控制台外壳没了以后，
  健康页与清理面板的每个深色类都要改成浅色 zinc（与库页面一致），`ui.tsx` 从 503 行缩到只剩
  这一页真用的 `Dot` / `Num` / `Panel` / `MetricCard` / `MonitorErrorBar` / `Legend`，
  图表原语（`Sparkbars` / `Sparkline` / `Grid`）、`StatusChip`、`MonitorEmpty`、`ConnectionBadge`
  与 `CHART_COLORS` 一并删除；磁盘条的两个色值直接落在页面里。
- 提议没提 `types.ts` 的反向依赖：总览与实时会话的载荷类型删掉后，
  `import type { NodeStatus, RunStatus } from "@/app/runs/lib"` 没有使用者了，
  连同 AGENTS.md 里「唯一被接受的反向依赖」那半句一起删。
- 提议没提 SSE 计数：`/api/monitor/stream` 一删，全仓只剩 `/api/runs/[id]/events` 一条 SSE 端点，
  AGENTS.md 两处「Both SSE endpoints」、REVIEW.md 一处「两个 SSE 端点」与 DESIGN.md 的
  「两条 SSE 端点」都要改成单数；`handle()` 例外从三个缩成两个（AGENTS.md、REVIEW.md、
  `rules.test.ts` 白名单三处一起改）。
- 提议只说 raw-sql 名单去掉 `metrics`：实际把 `rules.test.ts` 里 `src/server/monitor/` 的整段
  前缀豁免换成点名 `monitor/cleanup.ts` 与 `monitor/health.ts`，这样「名单里每个文件今天仍需要
  原生 SQL」那条断言才覆盖得到它们。
- 连带删除 `compactionEventLine`（`src/app/runs/lib.ts`）：唯一调用者是日志检索页，
  compaction 的成行展示只剩轨迹面板，DESIGN.md 相应那句同改。
- `monitor.spec.ts` 的夹具跟着瘦身：不再合成事件与用量（没有断言再读它们），只留一条已结束的
  运行与它真正落盘的工作区目录；新增一条断言「旧标签子路由已 404」。

验收实际跑了：`npm run check`（typecheck + lint + fmt:check + vitest）、`npm run build`、
`npx playwright test e2e/monitor.spec.ts e2e/parallel-ui.spec.ts`（本目录自己的干净库 + 3594 端口），
以及 `rg -an "monitor/(overview|sessions|stream|logs|trace|cost)|useMonitorStream|getLiveSessions|getOverview|getLogs|getMaxEventId"`
在 `src` / `e2e` / `docs`（除本记录树、DESIGN-V3 与 ADR）/ README / AGENTS.md / `.github` 上清零。
