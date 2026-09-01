# 简历匹配评分 API 验收记录

日期：2026-09-01

## 已完成验收

- 工作流最终产物固定为 `match-result.json`，对象类型为 JSON，并保存完整 JSON Schema。
- 汇总 Action 只在 `validate_resume_match_result` 返回 `valid=true` 后提交结构化输出。
- 工作流调用入口为：
  - `POST /api/internal/resume-matches`
  - `GET /api/internal/resume-matches/<runId>`
- POST 受理时把 `resume-match-api` 来源证明与结果/校验节点 id 同 run 同步持久化；GET 拒绝同名工作流经通用入口发起的运行。
- 当前来源、完成证据与持久业务结果契约下的新成功运行：`bcf1bd6c-391d-438b-97df-8cec98d6af51`
  - 11 / 11 节点成功；
  - 11 份工作区文件全部存在且非空（2 份物化输入、9 份 Action 产物）；
  - 8 个 Action 各有 1 份可读会话轨迹，共 123 条投影记录；
  - 汇总轨迹有且仅有 1 次 `validate_resume_match_result`，结果为 `valid=true`；
- 校验 Tool 回执携带它实际读取的结果 SHA-256；引擎在写 `success` 前确认该摘要与最终产物字节
  完全一致，再在同一事务里把精确 UTF-8 JSON 写入 `run_results`、把 64 位摘要固化进 run
  完成证据。磁盘、完成证据与持久结果独立复算结果同为
  `920f868b8d285f21b5ad9e8f9d07973baf24f00cb21a12d74dc13a152f782dd8`；
- API 返回结果经服务器与验收脚本两次同源校验，契约错误数为 0；
  - 结果摘要为 `recommend`、总分 89、`strong`、证据充分度 `medium`；
  - 权威总 token 213,792，费用 ¥0.135977，8 条节点结算事件的明细落库失败数均为 0。
- 耐久性实测把该运行的整个工作区临时移出 `data/runs/` 后，专用 GET 仍返回 HTTP 200、
  `success` 与同一份严格 JSON，随后工作区已原样恢复；单元测试进一步同时删除全部
  `run_events` 与工作区，结果仍可读取。只有显式删除整次运行时，`run_results` 才随运行级联删除。
- 若回执缺失、回执摘要与最终文件不一致、持久结果摘要不一致，或完成证据与结果无法在同一事务
  落库，引擎会把运行收束为 `failed`。
- 专用入口还会在付费受理前拒绝汇总 Action 位于回边重入范围内的图，避免第二轮产物路径进入
  `rounds/N/` 后与只接受根目录 `match-result.json` 的校验 Tool 形成必然失败。
- 专用入口把八个固定 Action 的完整输入输出端口集合、产物路径及 11 个指定节点间的 23 条业务边
  作为完整编排契约：六位评审各自必须同时收到岗位与简历，并各有且仅有一份结论进入汇总；多余端口、
  缺边、重复评审冒充或额外接线都会在产生模型费用前拒绝。
- 运行详情、历史接口与专用状态接口均可见该成功运行；合成同名工作流的通用入口运行后，专用 GET 实测返回 404，测试记录已删除。

首轮运行 `265e2a01-06c4-433e-b3db-aee227493f2f` 暴露校验 Tool 缺少转译辅助函数，已主动取消并保留轨迹；修正只发生在工作流 Tool 定义，没有修改 Harness。

## 已解决：全局“总 token”不再重复计入 reasoning

这不是简历工作流或调用入口造成的问题；栈底运行时 PR 已采用下述方案 A 修正两处展示聚合，
保留 reasoning 明细但不再把它重复加进总 token，底层 Harness 用量语义没有改动。

成功运行的节点用量合计：

| 项目 | token |
|---|---:|
| input | 22,270 |
| output（已包含 reasoning） | 20,898 |
| reasoning（output 的子集） | 11,839 |
| cache read | 170,624 |
| cache write | 0 |
| 权威总计，不重复加 reasoning | 213,792 |
| 修正前公式会显示 | 225,631 |

差值 `11,839` 恰好等于 reasoning。仓库运行时契约已经明确：适配器把
`completion_tokens` 整体记进 `outputTokens`，`reasoningTokens` 只是其中的可见细分，计费与总量都不能再加一次。

修正前重复发生在两个全局展示聚合处：

- `src/app/runs/lib.ts` 的 `sumTokens()`；
- `src/app/api/runs/route.ts` 的运行列表 SQL 聚合。

### 方案 A：修正展示聚合（已采用）

两处总量都改为 `input + output + cacheRead + cacheWrite`，继续单独展示 reasoning 明细。历史行无需迁移，刷新后会按现有明细列重新得到正确总量。

代价：所有历史运行的页面总 token 会降低，属于全局监控口径修正，不应夹带在本次工作流改动里。

### 方案 B：改写底层 token 数据模型

把 `outputTokens` 改成不含 reasoning，再继续使用当前五项相加公式。

代价：要修改 Harness 适配器落库语义、现有历史数据解释与计费校验，范围显著更大，也违背当前已经写明的运行时契约，不建议。
