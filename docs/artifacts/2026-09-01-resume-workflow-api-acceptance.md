# 简历匹配评分 API 验收与待抉择项

日期：2026-09-01

## 已完成验收

- 工作流最终产物固定为 `match-result.json`，对象类型为 JSON，并保存完整 JSON Schema。
- 汇总 Action 只在 `validate_resume_match_result` 返回 `valid=true` 后提交结构化输出。
- 工作流调用入口为：
  - `POST /api/internal/resume-matches`
  - `GET /api/internal/resume-matches/<runId>`
- POST 受理时把 `resume-match-api` 来源证明与 run 同步持久化；GET 拒绝同名工作流经通用入口发起的运行。
- 成功运行：`c8c98cc0-de41-48ba-a4e4-03e6edbfe1ad`
  - 11 / 11 节点成功；
  - 11 份工作区文件全部存在且非空（2 份物化输入、9 份 Action 产物）；
  - 8 个 Action 各有 1 份可读会话轨迹，共 121 条投影记录；
  - 汇总轨迹有且仅有 1 次 `validate_resume_match_result`，结果为 `valid=true`；
- API 返回结果经服务器与验收脚本两次同源校验，且服务器复核汇总 Action 的持久 Tool 回执为
  `valid=true`、错误为空；契约错误数为 0；
  - 结果摘要为 `recommend`、总分 89、`strong`、证据充分度 `medium`。
- 浏览器运行详情显示成功、工作区路径、11 个成功节点、JSON 产物正文和完整汇总轨迹；运行历史首页可见该成功运行。

首轮运行 `265e2a01-06c4-433e-b3db-aee227493f2f` 暴露校验 Tool 缺少转译辅助函数，已主动取消并保留轨迹；修正只发生在工作流 Tool 定义，没有修改 Harness。

## 已解决：全局“总 token”不再重复计入 reasoning

这不是简历工作流或调用入口造成的问题；栈底运行时 PR 已采用下述方案 A 修正两处展示聚合，
保留 reasoning 明细但不再把它重复加进总 token，底层 Harness 用量语义没有改动。

成功运行的节点用量合计：

| 项目 | token |
|---|---:|
| input | 19,863 |
| output（已包含 reasoning） | 15,181 |
| reasoning（output 的子集） | 6,822 |
| cache read | 165,120 |
| cache write | 0 |
| 权威总计，不重复加 reasoning | 200,164 |
| 修正前页面与运行列表显示 | 206,986 |

差值 `6,822` 恰好等于 reasoning。仓库运行时契约已经明确：适配器把
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
