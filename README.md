# OntoFlow 工作台

低代码 workflow 编排工作台：以 **Action** 为原子单位，通过拖拽连线把 Action 的输入输出编排为
允许扇出、汇总、具名出口与回边的有向图。每次运行独占一个 DeepSeek Harness 子进程与共同工作区，
每个 Action 的每一轮以全新会话真实执行（模型推理 + 工具调用）。

- 领域术语见 [CONTEXT.md](CONTEXT.md)，架构决策见 [docs/adr/](docs/adr/)，
  实现契约见 [docs/DESIGN.md](docs/DESIGN.md) 与 [docs/DESIGN-V2.md](docs/DESIGN-V2.md)。
- 技术栈：Next.js (App Router) · TypeScript strict · SQLite (Drizzle + better-sqlite3) ·
  @xyflow/react · Tailwind CSS · `@deepseek-ai/dsh-*` + cordis。

## 五个可管理实体

| 实体 | 说明 |
|---|---|
| Action | prompt + rule + 引用 skills/tools + 模型 + 思考强度 + 类型化输入输出端口 |
| Skill | 带名字与描述的指令包，运行时投影到工作区，由模型按描述决定是否加载 |
| Tool | cordis 插件（TS）；运行时按整图并集物化，再把每个 Action 会话收窄到它声明的 Tool |
| Object Type | 产物契约类型；同类型端口才能连线 |
| Workflow | Action + 输入/输出节点组成的有向图，保存图定义，运行全程留痕 |

五个库共用同一套治理能力（面向长期积累设计）：

- **流程树文件夹**：单归属的层级文件夹，左栏渲染成可折叠树（ADR-0005 推翻了 ADR-0003 的
  多归属标签方案）；配防抖搜索、排序、分页，筛选状态写进 URL 可分享。**Workflow 不进
  文件夹**，只有 Action / Skill / Tool / Object Type 四库分类。
- **修订历史**：每次保存自动留一版，可与当前定义 diff、可 pin、可回滚。
- **引用与影响分析**：被引用面板、列表引用计数、改端口前预览会失效的连线、孤儿检测。

## 画布与运行

双击 Action 节点即可就地编辑它引用的**共享 Action**（改动对所有引用它的工作流生效，
面板常驻引用数警告；只想改一处时一键「复制为新 Action 并替换本节点」）。这是当前实现；
[ADR-0010](docs/adr/0010-nodes-own-their-definition.md) 已推翻
[ADR-0004](docs/adr/0004-canvas-edits-the-shared-action.md)，但节点自带定义的迁移尚未落地。

运行时画布会显示"工作的流动"：六态节点视觉（未执行/执行中/已完成/失败/跳过/已取消）、
数据已流过的连线变绿、正在供数的连线走流动虚线、节点内联显示秒表与流式输出字数、
完成后固定显示耗时与 token 费用；顶部运行条可**中途取消**（已取消是区别于失败的独立终态）。
运行详情里每个 Action 还能按需展开独立的 Agent 轨迹：按回合与步骤查看系统提示、用户输入、
上下文、模型回复与工具调用，输入 / 模型 / 工具三泳道时间条展示先后与耗时；点击记录查看经过
长度限制和物理路径脱敏的参数、结果与附件元数据。循环产生的多轮会话分别切换，折叠时不会下载
会话正文。

## 监控台（`/monitor`）

开发者/管理员视角的可观测面板，六个标签：

| 标签 | 内容 |
|---|---|
| 总览 | 实时指标卡 + 近 24h 运行量与 token 消耗图 + 最近失败 |
| 实时会话 | 进行中的 dsh Action 会话表 + tail -f 事件流 + 中止运行 |
| Trace | run → node → session → step 甘特图，逐段耗时/token/费用 |
| 日志检索 | 跨运行检索 run_events，多维筛选 + 游标分页 + JSON 导出 |
| 成本分析 | 按模型 / Action / 工作流的 token 与费用排行、每日趋势 |
| 系统健康 | harness runner、凭据引用、在跑子进程、库表行数、磁盘占用、孤儿检测、**手动清理** |

本版**不做自动清理**：三项清理（运行工作区 / 事件明细 / 旧运行记录）都需人工触发，
且必须先「预览影响」看到条目数与释放空间，执行时二次确认。运行保留输入、会话 JSONL、
日志与全部工作区产物，长期使用仍会持续占用磁盘，应定期查看系统健康页。

## 运行前提

- 无需另行启动执行引擎服务或安装额外 CLI；依赖里的 `@deepseek-ai` 闭包会在每次运行时启动自己的
  harness 子进程。
- 把 `DEEPSEEK_API_KEY` 写入 gitignored 的 `.env.local`。`npm run dev` 会在启动时读取它；直接运行
  `scripts/run-*.ts` / `scripts/smoke-*.ts` 这类付费脚本前，还要把同名变量导出到当前 shell。
- Action 会话自带 `bash` 工具；要处理 PDF 输入的工作流依赖本机已安装 Poppler（`pdfinfo`、
  `pdftotext`、`pdftoppm` 在 `PATH` 上可直接运行），由会话里的模型自行调用。

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
（经 `save_purchase_plan` 工具写入 `purchase_plans` 表 + 备份 Markdown 到 `data/documents/`；
同一计划编号再次归档会替换数据库行并清理上一份备份）。

第二个案例先执行 `npx tsx scripts/seed-resume.ts`，再进入「工作流 → 简历匹配评分」。岗位与
简历都可上传 PDF、Markdown 或纯文本；文件以原件进入工作区，「简历评分·解析」使用
DeepSeek V4 Flash Vision，自己用 bash 调 Poppler 抽取文本层、逐页栅格化并对每页执行视觉核对，
六个评委与汇总继续使用文本模型。最终汇总会回看岗位与简历原文，自动裁决评委分歧、证据缺口和分数不自洽，并把明确的
推荐判断、依据、证据充分度及所有改分记录写进严格的 `match-result.json`。汇总必须调用
`validate_resume_match_result` 校验字段和总分/档位/否决等跨字段关系，得到 `valid=true` 才能提交。

内部调用方先把岗位和简历分别传给 `/api/uploads`，再把返回的两个 file PortValue 作为
`{ job, resume }` POST 到 `/api/internal/resume-matches`；接口返回 `runId`，随后 GET
`/api/internal/resume-matches/<runId>` 查询状态与最终 JSON，不需要知道工作流或节点 id。POST 会在
付费运行前核对完整图与 JSON 契约、汇总 Action 对校验 Tool 的引用和内置源码摘要，以及该 Tool 未被全局停用；
任一条件被网页编辑破坏都会直接拒绝，不启动模型。通过后执行的就是这份图与设置快照，并发保存
不会把已预检的定义替换成另一版。
命令行付费验收会真实走这组 HTTP 接口，并继续核对运行历史、工作区产物与 Agent 轨迹：

```bash
npx tsx scripts/run-resume.ts [data/ 内岗位路径] [data/ 内简历路径]
```

运行前需保持 `npm run dev` 在仓库根启动。脚本只打印 run id、最终分/档位、节点/产物/轨迹计数、
token 与费用等脱敏指标，不回显岗位、简历或结果正文。

## 测试

```bash
npm run check      # typecheck + 单测；提交前跑这个（仓库没有 CI、没有 hook）
npm test           # vitest 单测
npm run test:e2e   # Playwright E2E（复用 3592 端口的 dev server）
```

## 执行语义速览

一次运行创建 `data/runs/<workflowId>/<runId>/`、其中的共同 `workspace/` 与一个 dsh 子进程；
每个 Action 的每一轮独占一个会话。全部输入在 Action 启动前物化到共同工作区：文件保留原件，
文字写成 Markdown，JSON 写成 JSON 文件；Action 产物也留在该工作区。连线只告诉下游「去读
哪个路径」，不搬运全文。Skill 以目录链接进入工作区，由模型看描述按需加载；Tool 以 cordis
插件进入本运行，再按 Action 的引用关系收窄每个会话可见面。

每个会话注册带真实 schema 的 `structured_output` 工具，模型用它报告产物路径与具名出口；实质
内容仍写入产物文件，声明的文件没有落盘就判节点失败。dsh 会话事件到达即写 `run_events` /
`node_usage`，运行详情和监控台通过轮询 SQLite 的 SSE 实时呈现；单个 Action 的完整轨迹则按需
从本次运行的会话 JSONL 投影。完整契约见
[docs/DESIGN.md](docs/DESIGN.md) 的引擎实现规范。

## 许可证

[MIT](LICENSE) © 2026 Ryan Fu
