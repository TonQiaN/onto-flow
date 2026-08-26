# OntoFlow 工作台

低代码 workflow 编排工作台：以 **Action** 为原子单位，通过拖拽连线把 Action 的输入输出编排为
DAG，每次运行经 [opencode](https://opencode.ai) 以全新会话真实执行（模型推理 + 工具调用）。

- 领域术语见 [CONTEXT.md](CONTEXT.md)，架构决策见 [docs/adr/](docs/adr/)，
  实现契约见 [docs/DESIGN.md](docs/DESIGN.md) 与 [docs/DESIGN-V2.md](docs/DESIGN-V2.md)。
- 技术栈：Next.js (App Router) · TypeScript strict · SQLite (Drizzle + better-sqlite3) ·
  @xyflow/react · Tailwind CSS · @opencode-ai/sdk (v2 API)。

## 五个可管理实体

| 实体 | 说明 |
|---|---|
| Action | prompt + rule + 引用 skills/tools + 模型 + 思考强度 + 类型化输入输出端口 |
| Skill | 命名 prompt 片段，被引用即强制注入会话（不靠模型自主触发） |
| Tool | 完整 opencode custom tool（TS），运行时物化进会话工作区，未引用不可见 |
| Object Type | 端口类型注册表（text/file/json 形态），连线严格同类型（ComfyUI 式） |
| Workflow | 画布 DAG：Action 节点 + 输入/输出节点，保存图定义，运行全程留痕 |

五个库共用同一套治理能力（面向长期积累设计）：

- **流程树文件夹**：单归属的层级文件夹，左栏渲染成可折叠树（ADR-0005 推翻了 ADR-0003 的
  多归属标签方案）；配防抖搜索、排序、分页，筛选状态写进 URL 可分享。**Workflow 不进
  文件夹**，只有 Action / Skill / Tool / Object Type 四库分类。
- **修订历史**：每次保存自动留一版，可与当前定义 diff、可 pin、可回滚。
- **引用与影响分析**：被引用面板、列表引用计数、改端口前预览会失效的连线、孤儿检测。

## 画布与运行

双击 Action 节点即可就地编辑它引用的**共享 Action**（改动对所有引用它的工作流生效，
面板常驻引用数警告；只想改一处时一键「复制为新 Action 并替换本节点」，见 ADR-0004）。

运行时画布会显示"工作的流动"：六态节点视觉（未执行/执行中/已完成/失败/跳过/已取消）、
数据已流过的连线变绿、正在供数的连线走流动虚线、节点内联显示秒表与流式输出字数、
完成后固定显示耗时与 token 费用；顶部运行条可**中途取消**（已取消是区别于失败的独立终态）。

## 监控台（`/monitor`）

开发者/管理员视角的可观测面板，六个标签：

| 标签 | 内容 |
|---|---|
| 总览 | 实时指标卡 + 近 24h 运行量与 token 消耗图 + 最近失败 |
| 实时会话 | 进行中的 opencode 会话表 + tail -f 事件流 + 中止运行 |
| Trace | run → node → session → step 甘特图，逐段耗时/token/费用 |
| 日志检索 | 跨运行检索 run_events，多维筛选 + 游标分页 + JSON 导出 |
| 成本分析 | 按模型 / Action / 工作流的 token 与费用排行、每日趋势 |
| 系统健康 | opencode 探活、事件泵、库表行数、磁盘占用、孤儿检测、**手动清理** |

本版**不做自动清理**：三项清理（运行工作区 / 事件明细 / 旧运行记录）都需人工触发，
且必须先「预览影响」看到条目数与释放空间，执行时二次确认。注意每次运行的工作区里
opencode 会安装依赖，磁盘增长很快——这是需要定期查看系统健康页的主要原因。

## 运行前提

- 本机安装 opencode CLI（≥1.18），且 `~/.config/opencode/opencode.jsonc` 已配好模型
  `deepseek/deepseek-v4-flash` 与 `newapi` 下的 `openai/gpt-5.6-luna`（工作台可选的模型即这两个）。
- 使用 PDF 输入预处理时本机需安装 Poppler，并能直接运行 `pdfinfo`、`pdftotext`、`pdftoppm`。

## 启动

```bash
npm install
npm run db:push     # 建表（./data/ontoflow.db）
npm run db:seed     # 灌入采购集采计划案例（幂等）
npm run dev
```

打开 http://localhost:3592 ，进入「工作流 → 采购集采计划生成」，点「运行」并上传
`data/samples/采购需求示例.txt`，即可看到四个 Action 依次真实执行：
需求整理 → 集采计划生成 → 集采计划审核（结构化 JSON 评价）→ 集采计划归档
（经 `save_purchase_plan` 工具写入 `purchase_plans` 表 + 备份 Markdown 到 `data/documents/`）。

## 测试

```bash
npm run check      # typecheck + 单测；提交前跑这个（仓库没有 CI、没有 hook）
npm test           # vitest 单测（图校验/拓扑、文件夹树）
npm run test:e2e   # Playwright E2E（26 个用例，复用 3592 端口的 dev server）
```

## 执行语义速览

共享 opencode server（127.0.0.1:4977）+ 每节点全新 session；独立工作区
`data/runs/<runId>/<nodeId>/`；rule+skills 经 noReply 注入；工具不设白名单——内置工具全开
（与 opencode CLI 一致），Action 引用的 custom tools 额外物化进工作区；思考强度经
per-prompt variant；多输出或含 json 输出**一律走 prompt 约定纯 JSON**（把 JSON Schema
写进 prompt 末尾的输出契约，解析失败同会话追问重试，共 3 轮），**不使用 opencode 的
`format: json_schema`**——它靠合成工具 + `tool_choice: required` 实现，在用的推理模型直接
400（详见 [docs/DESIGN.md](docs/DESIGN.md) 引擎实现规范）；事件流按工作区目录订阅落库
`run_events`，前端经 SSE 实时呈现。

## 许可证

[MIT](LICENSE) © 2026 Ryan Fu
