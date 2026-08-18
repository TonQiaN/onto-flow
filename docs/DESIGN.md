# OntoFlow 设计契约

实现阶段所有模块共同遵守的契约。领域语义见 [CONTEXT.md](../CONTEXT.md)，架构决策见 [adr/](./adr/)。

## 目录结构

```
src/
├── app/
│   ├── layout.tsx / globals.css        # 工作台外壳（已建）
│   ├── workflows/                      # 工作流列表 + [id]/ 画布编辑器
│   ├── actions/  skills/  tools/  object-types/   # 四个库的管理页
│   ├── runs/                           # 运行历史列表 + [id]/ 详情
│   ├── documents/                      # 归档文档（purchase_plans）浏览
│   └── api/                            # REST 路由（下表）
├── components/                         # 共享 UI（nav 已建）
├── db/  schema.ts  index.ts            # Drizzle（已建，改动需全员同步）
├── lib/
│   ├── graph.ts                        # 图校验/拓扑（已建，已测）
│   └── values.ts                       # PortValue 封装（已建）
└── server/
    ├── resolve.ts                      # DB 行 → ResolvedNode（图解析）
    ├── engine/                         # 执行引擎（run 编排 + opencode 会话）
    └── opencode/                       # opencode server 生命周期与 SDK 封装
```

## API 面（全部 JSON；错误统一 `{ error: string }` + 4xx/5xx）

| 路由 | 方法 | 说明 |
|---|---|---|
| /api/object-types, /api/skills, /api/tools | GET, POST | 列表/新建 |
| /api/object-types/[id] 等同上三者 | GET, PUT, DELETE | 详情/更新/删除；被引用时 DELETE 返回 409 `{ error, usedBy }`；builtin 类型不可删改 |
| /api/models | GET | 模型白名单 |
| /api/actions | GET, POST | POST/PUT 载荷含 `ports: {direction,name,objectTypeId,position}[]`、`skillIds`、`toolIds`，整体替换 |
| /api/actions/[id] | GET, PUT, DELETE | 被 workflow 节点引用时 DELETE 409 |
| /api/workflows | GET, POST | |
| /api/workflows/[id] | GET, PUT, DELETE | GET 返回 nodes+edges+校验结果；PUT 保存整图（nodes+edges 整体替换，节点 id 由前端生成保持连线引用） |
| /api/workflows/[id]/run | POST | body: `{ inputs: { [inputNodeId]: PortValue } }`；校验不通过 422 `{ issues }`；通过则建 run 异步执行，返回 `{ runId }` |
| /api/runs?workflowId= | GET | 运行列表 |
| /api/runs/[id] | GET | run + run_nodes 全量 |
| /api/runs/[id]/events | GET | SSE：`event: node`（run_node 状态变化）、`event: log`（run_events 增量）、`event: run`（终态）；连接时先回放已有事件再跟增量 |
| /api/uploads | POST | multipart 单文件 → 存 `data/uploads/<uuid>/<原名>`，返回 PortValue(file) |
| /api/documents | GET | purchase_plans 倒序列表 |

## 约定

- 所有 route handler 顶部 `export const dynamic = "force-dynamic"`（sqlite 本地读写，禁静态化）。
- 服务端校验：name 非空且唯一冲突返回 409；未知 id 返回 404。
- 前端数据获取：凡是要数据的页面都是 client component（`"use client"` 起手），一律 `fetch` 打 `/api/*` 后在 `useEffect` 里取数。没有 Server Action，也没有任何 Server Component 读 DB——只有根 `app/page.tsx`（仅 redirect）与 `app/layout.tsx`（静态外壳）不带 `"use client"`。
- UI 文案全部中文；Tailwind 工具类直接写，不引组件库；整体风格与既有外壳（zinc 系工作台）一致。
- 画布：@xyflow/react 12。node.data 只放展示与引用所需（actionId、端口清单、objectType 名与 kind），实体真身在 DB；连线校验用 `isValidConnection` 调 graph.ts 的同款逻辑（Object Type id 相等）。
- 执行引擎：拓扑序串行；每节点一个全新 opencode session；工作区 `data/runs/<runId>/<nodeId>/`；file 输入物化到工作区 `inputs/`；引用 tools 物化到 `.opencode/tools/`；rule+skills 以 noReply 上下文注入；多输出或含 json 输出**一律用 prompt 约定纯 JSON**（schema 按输出端口生成、json 端口有自定义 schema 则内嵌，写进 prompt 末尾的输出契约），**禁用 `format: json_schema`**（理由见下方引擎实现规范的「输出提取」）。
- 运行期间每个节点的 opencode 事件写 run_events（节流：文本增量可合并），SSE 转发。

## 引擎实现规范（opencode SDK 1.18.16 实测定稿）

一律用 **v2 API**（`@opencode-ai/sdk/v2`）——只有 v2 的 `session.prompt` 有 `format` 与 `variant`。
所有 SDK 调用返回 `{ data, error, response }`，用 data 前必须查 error。

- **Server 单例**：`createOpencodeServer({ hostname:"127.0.0.1", port:4977, config })`，
  挂 globalThis 防 HMR 重启。`config` 经 OPENCODE_CONFIG_CONTENT 与全局配置**合并**：在其中为
  deepseek/deepseek-v4-flash 与 newapi/openai/gpt-5.6-luna 定义 low/medium/high/max 四个
  variants（`variants.<name> = { reasoningEffort }`）。spawn 前设置
  `process.env.ONTOFLOW_DB_PATH`（ontoflow.db 绝对路径）与 `ONTOFLOW_DATA_DIR`
  （data/ 绝对路径），custom tools 靠它们定位数据库与备份目录。端口不要用 0（实测不生效）。
- **会话绑定工作区**：`createOpencodeClient({ baseUrl, directory })` 或 per-call `directory`；
  `session.create({ directory: <workspace> })`。custom tools 按 **session 目录**发现：
  物化到 `<workspace>/.opencode/tools/<name>.ts`，无需装 @opencode-ai/plugin（opencode 自动装）。
- **注入顺序**：① `session.prompt({ noReply: true, parts: [rule+skills 文本] })`（不触发模型）；
  ② 正式 prompt：`{{端口}}` 占位符插值（file 端口→占位文本），file 输入追加
  `{ type:"file", mime, filename, url:"file://<绝对路径>" }` part。
- **工具**：不传 `tools` map——内置工具全开（与 opencode CLI 行为一致），custom tools
  物化到工作区 `.opencode/tools/` 后由 opencode 自动发现启用（未列出的工具默认启用，实测）。
- **思考强度**：prompt 顶层 `variant: <low|medium|high|max>`（不在 model 对象里）。
- **输出提取**：单 text 输出→`parts.filter(p=>p.type==="text").map(p=>p.text).join("")`；
  多输出或含 json 输出→**prompt 约定纯 JSON**：正式 prompt 末尾追加输出契约
  （给出 JSON Schema，要求最终回答只输出一个 JSON 对象），解析（全文→最后一个代码
  围栏→首尾大括号切片）+ 必填键校验，失败同会话反馈重试（共 3 轮）。
  **禁用 `format: json_schema`**：opencode 的 format 靠「合成工具 + tool_choice:required」
  实现，DeepSeek 思考模式等 provider 直接 400（"Thinking mode does not support this
  tool_choice"，HTTP 仍 200、parts 为空、错误走 session.error 事件）；且用过 format 的
  session 再调 `session.messages` 会 400（1.18.16）。prompt 约定对所有 provider 兼容。
- **完成/错误判定**：v2 prompt 阻塞到回合结束；`session.idle` 事件是可靠完成信号；错误三通道
  （res.error / session.error 事件 / info.error）都要接。工具调用过程只出现在 events
  （`message.part.updated`，ToolPart state pending→running→completed），prompt 响应只含最终消息。
- **事件→run_events**：opencode 事件流按 directory 作用域隔离，故每个会话按其工作区目录
  单独起 `event.subscribe({ directory })` 事件泵，sessionID→(runId,nodeId) 路由，text delta
  节流合并（≥500ms 或 ≥500 字符落一条），工具调用状态逐条落库，节点结束时 abort。
  SSE 路由轮询 sqlite（500ms）推增量，不依赖进程内 pubsub。

## 安全与健壮性约束（终审确认项）

- **运行输入的 file PortValue 不可信**：`/api/workflows/[id]/run` 直接接收请求体里的
  PortValue，`file.path` 必须经 `src/server/fs-safety.ts` 的 `resolveWithinData` 约束在
  `data/` 内（`isWithinData` 在 startRun 入口 422 拦截，`resolveWithinData` 在 action.ts
  物化时纵深兜底），`file.name` 用 `safeBasename` 只取 basename——防目录穿越读任意文件外泄、
  或写入 opencode 会扫描执行的 `.opencode/tools/` 目录。
- **孤儿运行对账**：`src/instrumentation.ts` 启动钩子调用 `reconcileOrphanRuns`，把上次进程
  遗留的 `running` run 及其 running/pending 节点失败化——否则 SSE 结束条件永假、无限轮询。
- **模型输出用作文件名前先净化**：`save_purchase_plan` 里 `plan_no` 由模型产出，拼进备份
  文件名前 `replace(/[^\w.-]/g, "_")`，防穿越写出 `documents/` 之外。
- **进程级 Map 生命周期**：`releaseSession` 清理 sessionRoutes/textBuffers/sessionPumps/
  **sessionErrors**（全部四个），防长跑进程内存单调增长。

## 首个案例种子（scripts/seed.ts，幂等：按 name upsert；内容取自 scratchpad research/erp-seed.json）

- Object Types：需求文件(file)、需求Prompt(text)、集采计划(text)、**审核评价(json+完整schema)**、
  **归档回执(text)** + 内置 text/file/json。
- Models：DeepSeek V4 Flash (deepseek/deepseek-v4-flash)、GPT-5.6 Luna (newapi/openai/gpt-5.6-luna)。
- Skills：集采计划编制规范、集采计划审核要点（全文见 erp-seed.json）。
- Tool：save_purchase_plan——**在 opencode（bun）运行时执行**，用 `bun:sqlite` 打开
  `process.env.ONTOFLOW_DB_PATH` 写 purchase_plans（17 字段见 schema.ts），备份 Markdown 写
  `ONTOFLOW_DATA_DIR/documents/集采计划-<planNo>-<日期>.md`，返回 { id, planNo, backupPath }。
- Actions（prompt/rule 全文见 erp-seed.json）：需求整理(deepseek, low)、集采计划生成(deepseek, high)、
  集采计划审核(deepseek, high；输出 审核评价+集采计划透传)、集采计划归档(deepseek, low；引用 save_purchase_plan)。
- Workflow「采购集采计划生成」：输入节点(需求文件) → 需求整理 → 集采计划生成 → 集采计划审核 →
  集采计划归档 → 输出节点(归档回执)；审核评价另接一个输出节点(审核评价)。
- 示例需求文件写入 data/samples/采购需求示例.txt。
