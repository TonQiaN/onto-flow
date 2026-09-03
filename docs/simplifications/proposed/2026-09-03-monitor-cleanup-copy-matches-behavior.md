# 简化：清理面板的静态文案与 ADR-0018 之后的真实删除范围对齐

状态: proposed

## 问题

`src/app/monitor/cleanup-panel.tsx:34-58` 的 `SPECS` 是清理面板每一项常驻显示（`:167`）与二次确认框里
再强调一遍（`:321`）的文案。两项与代码矛盾：

- **`:38`（工作区项 `what`）**：
  > 「删除 data/runs/<runId>/ 下最后活动早于 N 天的工作区目录（物化的输入文件、.opencode/tools、中间产物）。」

  `.opencode/tools` 是 opencode 引擎时代的目录，随 `a329219` 一起消失（`rg -an "opencode" src` 今天只剩
  这一行）；路径形状也不对，真实布局是 `data/runs/<workflowId>/<runId>`
  （`src/server/monitor/cleanup.ts:53`、`src/server/monitor/health.ts:112`）。

- **`:46-48`（事件项）**：
  > `what: "删除 run_events 中早于 N 天的事件行（文本增量、工具调用、会话错误/空闲）。"`
  > `impact: "运行与节点状态、**快照**、用量全部保留，但这些运行的事件日志会变成空——运行页的回放退化到轮次级。"`

  **`impact` 是错的。** `src/server/monitor/cleanup.ts:192,197` 在同一个 events 目标里执行：

  ```sql
  update run_node_rounds set inputs = null, outputs = null, snapshot = null …
  update run_nodes        set inputs = null, outputs = null, snapshot = null …
  ```

  即 `AGENTS.md:163`「`cleanup.ts`'s `events` target deletes `run_events` and nulls `inputs` / `outputs`
  / `snapshot` on `run_node_rounds` **and** `run_nodes` rows」与 `docs/DESIGN.md:63` 陈述的行为。服务端
  返回的 `detail`（`cleanup.ts:208-211`）说得完全正确（「另清空 N 行轮次、M 个节点的输入输出与快照」），
  **只有客户端这份静态文案停在 ADR-0018 之前**。

**生产消费者：** `src/app/monitor/cleanup-panel.tsx:167`（面板常驻说明）与 `:321`（确认框）——用户在按下
仓库唯一破坏性路径之前读到的就是它。
**测试 / 文档消费者：** 无。`rg -n "opencode|快照、用量全部保留|事件明细" e2e/monitor.spec.ts` 无结果，
没有 e2e 断言这几个字符串。`AGENTS.md:163`、`.github/REVIEW.md` §3、`docs/DESIGN.md:63` 三处已经是对的。

**打败了哪条已记录的理由：** `AGENTS.md`「Comments state behavior, failure, timing, and ownership」——
这份文案说的是与 `cleanup.ts` **相反**的 behavior，而且它在 `find-simplifications` 明确点名的高代价
接缝（仓库唯一破坏性路径）的按钮上方。

## 提议

- `:38` → 路径改 `data/runs/<工作流>/<运行>/`，`.opencode/tools` 换成今天真实的内容（`workspace/`、
  `sessions/`、`logs/`、`tmp/`、`plugins/`，见 `src/server/harness/workspace.ts` 的目录布局）；同一句里的
  「最后活动早于 N 天」也是错的——`cleanWorkspaces()` 对库里有 `runs` 行的目录按**运行开始时间**判
  （`run.startedAt < cutoff`，`cleanup.ts:80`），只有库里查不到的孤儿目录才看目录 mtime（`:54,88`），
  所以一次开始得早、刚结束或刚改过工作区的长运行照样会被选中；文案改成「开始时间早于 N 天的运行工作区，
  以及目录修改时间早于 N 天、库里已无记录的孤儿目录」（Codex 对 #28 的复审指出）。本记录只改文案不改判据；
  「按结束时间而非开始时间选」若要做，是清理接缝的行为变更，另立记录。
- `:46` `what` 补一句「并把够龄运行的轮次行与节点行上的输入输出与快照置空」。
- `:47-48` `impact` 去掉「快照」，改成「运行、节点与轮次的**骨架**（轮次、会话、起止、终态、出口、错误）
  与用量全部保留；输入输出与快照会被置空，抽屉的这两个页签显示已清理，轨迹面板退回显示技能 slug」。
- `AGENTS.md` / `.github/REVIEW.md` / `docs/DESIGN.md` 三处**不需要改**——这正说明问题只在 UI 文案。
- 若 [删掉 run_nodes 三列](2026-09-03-drop-run-nodes-payload-columns.md) 先落地，这里的措辞改成只提轮次行
  （两份记录任一先落地都成立，后落地那份顺手对齐即可）。

## 放弃了什么

无。三处都是事实性更正，不改任何行为，也不改任何决定。反方最强的说法是「反正 `detail` 是对的，用户点了
预览就看到真数」——但常驻说明与确认框是**点预览之前**读到的，破坏性操作的说明不该靠事后纠正。

## 验收

`rg -n "opencode" src` 无结果；`npm run check`、`npm run build`。

**唯一破坏性路径的证据：** 本候选**只改客户端字符串常量，`cleanup.ts` 一行不动**，dryRun 与真删同源的
既有断言（`src/server/monitor/cleanup.test.ts:248` `expect(deleted.detail).toBe(preview.detail)`）保持不
变并重跑。`npx playwright test e2e/monitor.spec.ts`（该 spec 只走 dryRun）。**现场 dryRun 证据**：在
Chrome 里打开 `/monitor`，对事件项点一次「预览影响」，确认面板上方的常驻说明与服务端返回的 `detail`
说的是同一件事（今天说的是相反的两件事），截图或抄录两段文字进 PR 描述。**不需要真删。**

## 风险

低。不碰 `cleanup.ts`，只改客户端字符串常量；没有 e2e 断言这几个字符串。

预估净删 ≈ +2 行（三条文案改写）；风险等级：低。
