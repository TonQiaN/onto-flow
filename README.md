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
| Action | prompt + rule + 模型 + 思考强度 + 类型化输入输出端口，外加在所在工作流集合里选的预载技能与可见 Tool |
| Skill | 技能目录：SKILL.md 正文 + 资源文件；归工作流技能集所有，运行时投影到工作区，由模型按描述决定是否加载，Action 可预载（等同命令行敲 `/技能`） |
| Tool | 按本工作台契约写的执行模块（`execute(args, ctx)`）；由工作流 Tool 集带进运行，平台套 cordis 包装，再把每个 Action 会话收窄到它可见的 Tool |
| Object Type | 产物契约类型；同类型端口才能连线 |
| Workflow | Action + 输入/输出节点组成的有向图，外加工作流设置（指令、插件开关覆盖、MCP 子集、技能集、Tool 集）；保存图定义，运行全程留痕 |

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
设置分三层（[ADR-0016](docs/adr/0016-three-tier-settings.md)）：全局设置给基线，工作流设置页
（画布工具栏「工作流设置」）声明本工作流的指令、插件开关覆盖、MCP 子集、技能集与 Tool 集，
Action 只在其中选预载技能与可见 Tool；越出集合的选择在保存与运行受理时都会被指名拒绝。

编辑器只编排与发起：发起运行后直接跳到那一路的运行页，看一次运行只有 `/runs/<id>` 一个地方
（[ADR-0018](docs/adr/0018-run-page-frozen-graph-replay.md)）。运行页画的是**受理那一刻冻结下来的
图**，因此历史运行也不会被后来的编辑改写：六态节点视觉（未执行/执行中/已完成/失败/跳过/已取消）、
数据已流过的连线变绿、正在供数的连线走流动虚线、节点内联显示秒表与流式输出字数、完成后固定显示
耗时与 token 费用；概要栏可**中途取消**（已取消是区别于失败的独立终态）。底部时间轴一个节点一行、
一轮执行一段，拖动时间光标即回放：进行中的运行默认钉在「现在」跟着直播走，往回拖就停在那一刻，
「跟随」按钮回到现在。点节点开抽屉，看光标所在那一轮的 Agent 轨迹、输入输出与快照——轨迹按回合与
步骤查看系统提示、用户输入、上下文、模型回复与工具调用，输入 / 模型 / 工具三泳道时间条展示先后与
耗时；点击记录查看经过长度限制和物理路径脱敏的参数、结果与附件元数据。循环产生的多轮会话分别切换，
折叠时不会下载会话正文。

## 系统健康（`/monitor`）

开发者/管理员视角的一页，左下角入口：harness runner 与凭据引用是否就绪、在跑的运行子进程、
库表行数、磁盘占用、孤儿运行与孤儿实体，外加**手动清理**面板。

跨运行的实时与检索不在这里：一次运行看运行页 `/runs/<id>`，token 与费用的归集看运行列表页
`/runs`——它按当前筛选（工作流 / 状态 / 来源 / 时间范围）给出运行数、token、费用与按模型的小表。

本版**不做自动清理**：三项清理（运行工作区 / 事件明细 / 旧运行记录）都需人工触发，
且必须先「预览影响」看到条目数与释放空间，执行时二次确认。运行保留输入、会话 JSONL、
日志与全部工作区产物，长期使用仍会持续占用磁盘，应定期查看这一页。

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
npm run db:seed     # 平台基线：内置对象类型与模型（幂等）
npm run dev
```

案例内容不在平台基线里：先执行 `npx tsx scripts/seed-resume.ts` 装入「简历匹配评分」工作流，
再打开 http://localhost:3592 进入「工作流 → 简历匹配评分」。岗位与简历都可上传 PDF、Markdown
或纯文本；文件以原件进入工作区，「简历评分·解析」使用
DeepSeek V4 Flash Vision，自己用 bash 调 Poppler 抽取文本层、逐页栅格化并对每页执行视觉核对，
六个评委与汇总继续使用文本模型。最终汇总会回看岗位与简历原文，自动裁决评委分歧、证据缺口和分数不自洽，并把明确的
推荐判断、依据、证据充分度及所有改分记录写进严格的 `match-result.json`。汇总必须调用
`validate_resume_match_result` 校验字段和总分/档位/否决等跨字段关系，得到 `valid=true` 才能提交。

内部调用方先把岗位和简历分别传给 `/api/uploads`，再把返回的两个 file PortValue 作为
`{ job, resume }` POST 到 `/api/internal/resume-matches`；接口返回 `runId`，随后 GET
`/api/internal/resume-matches/<runId>` 查询状态与最终 JSON，不需要知道工作流或节点 id。POST 会在
付费运行前核对完整图、岗位/简历各自的对象类型与解析连线、JSON 契约、工作流 Tool 集里的校验 Tool
及其契约摘要（公名、描述、参数与返回值 schema、超时、execute 模块）、汇总 Action 对它可见、校验
Tool 与 `read`/`write`/`bash`/`read_image`/`structured_output` 均未被全局停用，以及汇总 Action 不会
被回边重入；八个固定 Action 的完整输入输出端口集合、产物路径及 11 个指定节点间的 23 条业务边都
必须精确齐全，六位评审各自都要收到岗位与简历、并各有且仅有一份结论进入汇总。工作流级指令、
插件开关覆盖、MCP 子集、技能集与 Tool 集，以及八个 Action 的 prompt、rule、provider/model、
思考强度、重入策略、预载技能与可见 Tool，还必须匹配经过代码审查的 seed 摘要 pin。
任一条件被网页编辑
破坏都会直接拒绝，不启动模型。
通过后执行的就是这份图、Action、模型、端口、Tool 与设置快照，并发保存不会把已预检定义替换成另一版。
校验 Tool 同时返回它实际读取内容的 SHA-256；引擎在写 `success` 前把 `valid=true`、错误为空且与
最终产物字节一致的回执固化为运行完成证据，并把精确 JSON 存成随 run 生命周期管理的持久业务结果；
因此工作区或事件明细被清理后仍可读取。仅写出结构合法 JSON、但没有实际完成校验调用的运行会
收束为失败。运行受理时还会把入口来源与结果节点身份和 run
同步持久化；专用 GET 只读取专用 POST 发起的运行，同名工作流经通用运行接口启动也返回 404。
命令行付费验收会真实走这组 HTTP 接口，并继续核对运行历史、工作区产物与 Agent 轨迹：

```bash
npx tsx scripts/run-resume.ts [data/ 内岗位路径] [data/ 内简历路径]
```

运行前需保持 `npm run dev` 在仓库根启动。脚本只打印 run id、最终分/档位、节点/产物/轨迹计数、
token 与费用等脱敏指标，不回显岗位、简历或结果正文。

## 测试

```bash
npm run check      # typecheck + 单测；提交前跑这个
npm test           # vitest 单测
npm run test:e2e   # Playwright E2E（复用 3592 端口的 dev server）
npx vitest run src/rules.test.ts   # AGENTS.md 里能机械核对的约定
```

仓库没有 git hook，门槛在 GitHub Actions：`.github/workflows/ci.yml` 在每个 PR 与 push `main` 上
跑 `typecheck / test / build` 与 Playwright，不花钱；`.github/workflows/smoke.yml` 是付费冒烟，
按需或每日定时跑 `smoke-harness` 与 `smoke-engine`，需要仓库 secret `DEEPSEEK_API_KEY`；在 issue
或 PR 评论里 `@claude` 触发按需评审（需要 `ANTHROPIC_API_KEY` 与 Claude GitHub App）。评审清单在
[.github/REVIEW.md](.github/REVIEW.md)，PR 描述按
[.github/pull_request_template.md](.github/pull_request_template.md) 填三段。

## 执行语义速览

一次运行创建 `data/runs/<workflowId>/<runId>/`、其中的共同 `workspace/` 与一个 dsh 子进程；
每个 Action 的每一轮独占一个会话。全部输入在 Action 启动前物化到共同工作区：文件保留原件，
文字写成 Markdown，JSON 写成 JSON 文件；Action 产物也留在该工作区。连线只告诉下游「去读
哪个路径」，不搬运全文。工作流技能集以目录链接进入工作区，由模型看描述按需加载，Action 预载的
技能在会话首条消息前以 `/技能` 手势显式注入；工作流 Tool 集经平台的 cordis 包装进入本运行，再按
Action 的可见子集收窄每个会话可见面。工作流指令写进工作区的 `AGENTS.md`，全局默认指令写进运行
home 的 `AGENTS.md`，两者都由上游指令载入机制读进每个会话。

每个会话注册带真实 schema 的 `structured_output` 工具，模型用它报告产物路径与具名出口；实质
内容仍写入产物文件，声明的文件没有落盘就判节点失败。dsh 会话事件到达即写 `run_events` /
`node_usage`，运行页通过轮询 SQLite 的 SSE 实时呈现；单个 Action 的完整轨迹则按需
从本次运行的会话 JSONL 投影。完整契约见
[docs/DESIGN.md](docs/DESIGN.md) 的引擎实现规范。

## 许可证

[MIT](LICENSE) © 2026 Ryan Fu
