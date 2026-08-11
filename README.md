# FlowForge 工作台

低代码 workflow 编排工作台：以 **Action** 为原子单位，通过拖拽连线把 Action 的输入输出编排为
DAG，每次运行经 [opencode](https://opencode.ai) 以全新会话真实执行（模型推理 + 工具调用）。

- 领域术语见 [CONTEXT.md](CONTEXT.md)，架构决策见 [docs/adr/](docs/adr/)，
  实现契约见 [docs/DESIGN.md](docs/DESIGN.md)。
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

## 运行前提

- 本机安装 opencode CLI（≥1.18），且 `~/.config/opencode/opencode.jsonc` 已配好模型
  `deepseek/deepseek-v4-flash` 与 `newapi` 下的 `openai/gpt-5.6-luna`（工作台白名单）。

## 启动

```bash
npm install
npm run db:push     # 建表（./data/flowforge.db）
npm run db:seed     # 灌入采购集采计划案例（幂等）
npm run dev
```

打开 http://localhost:3000 ，进入「工作流 → 采购集采计划生成」，点「运行」并上传
`data/samples/采购需求示例.txt`，即可看到四个 Action 依次真实执行：
需求整理 → 集采计划生成 → 集采计划审核（结构化 JSON 评价）→ 集采计划归档
（经 `save_purchase_plan` 工具写入 `purchase_plans` 表 + 备份 Markdown 到 `data/documents/`）。

## 测试

```bash
npm test           # vitest 单测（图校验/拓扑）
npm run test:e2e   # Playwright E2E（自动起 3111 端口 dev server）
```

## 执行语义速览

共享 opencode server（127.0.0.1:4977）+ 每节点全新 session；独立工作区
`data/runs/<runId>/<nodeId>/`；rule+skills 经 noReply 注入；内置工具全部禁用、仅放行
Action 引用的 custom tools；思考强度经 per-prompt variant；多输出走 JSON Schema 结构化返回
（DeepSeek 思考模式不支持时自动降级为同会话纯 JSON 追问）；事件流按工作区目录订阅落库
`run_events`，前端经 SSE 实时呈现。
