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
│   ├── graph.ts                        # 图校验、回边分类、出口与下游闭包
│   └── values.ts                       # PortValue 封装（已建）
└── server/
    ├── resolve.ts                      # DB 行 → ResolvedNode（图解析）
    ├── engine/                         # 就绪驱动编排、Action 执行与事件落库
    └── harness/                        # 每运行 dsh 子进程、组合、工作区与 RPC
```

## API 面（全部 JSON；错误统一 `{ error: string }` + 4xx/5xx）

| 路由 | 方法 | 说明 |
|---|---|---|
| /api/object-types, /api/skills, /api/tools | GET, POST | 列表/新建 |
| /api/object-types/[id] 等同上三者 | GET, PUT, DELETE | 详情/更新/删除；被引用时 DELETE 返回 409 `{ error, usedBy }`；builtin 类型不可删改 |
| /api/models | GET | 模型白名单 |
| /api/actions | GET, POST | POST/PUT 载荷含 `ports: {direction,name,objectTypeId,position,artifactPath,exitName}[]`、`maxReentries`、`onExhausted`、`skillIds`、`toolIds`，整体替换；每个输出端口的 `artifactPath` 必填，输入端口两字段归一为 null |
| /api/actions/[id] | GET, PUT, DELETE | 被 workflow 节点引用时 DELETE 409 |
| /api/workflows | GET, POST | |
| /api/workflows/[id] | GET, PUT, DELETE | GET 返回 nodes+edges+校验结果；PUT 保存整图（nodes+edges 整体替换，节点 id 由前端生成保持连线引用） |
| /api/workflows/[id]/run | POST | body: `{ inputs: { [inputNodeId]: PortValue } }`；校验不通过 422 `{ issues }`；通过则建 run 异步执行，返回 `{ runId }`；同时 running 的运行数达上限（16）时 429，排队归调用方 |
| /api/internal/resume-matches | POST | 「简历匹配评分」工作流调用入口；body 严格为 `{ job: PortValue(file), resume: PortValue(file) }`，调用方先经 `/api/uploads` 取得两个值；202 返回 `runId`、`statusUrl`、`historyUrl`，不暴露工作流或节点 id |
| /api/internal/resume-matches/[id] | GET | 只查询由该入口 POST 受理并在 run 元数据中留下来源证明的运行（同名工作流经通用入口启动仍为 404）；running/failed/cancelled 时 `result=null`，success 时读取完成门禁写入 `run_results` 的精确 JSON，再次严格校验并核对完成证据里的内容 SHA-256 后返回；工作区/事件清理不影响结果，删除 run 才级联删除 |
| /api/runs?workflowId=&status= | GET | 运行列表；每行带 `nodesTotal` / `nodesDone` 进度（导航「运行中」面板与列表页共用） |
| /api/runs/[id] | GET, DELETE | GET：run + run_nodes 全量；DELETE：删除单个已结束运行（run_nodes / run_events / node_usage / run_results 外键级联，连同运行目录），running 时 409 |
| /api/runs/[id]/files?path= | GET | 只读预览已结束运行目录内的 UTF-8 文本文件（执行中 409；路径收敛在该 run 的 run_dir 内；256KB 按完整字符截断，二进制或非法 UTF-8 为 415）；运行详情看输入与产物正文的唯一通道（ADR-0012） |
| /api/runs/[id]/events | GET | SSE：`event: node`（run_node 状态变化）、`event: log`（run_events 增量）、`event: run`（终态）；连接时先回放已有事件再跟增量 |
| /api/runs/[id]/nodes/[nodeId]/trajectory | GET | 按需读取该 Action 各轮会话 JSONL，返回按回合与步骤组织的系统、用户、上下文、模型及工具折叠轨迹；工作区已清理时返回可展示的 unavailable 结果 |
| /api/uploads | POST | multipart 单文件 → 存 `data/uploads/<uuid>/<原名>`，返回 PortValue(file) |
| /api/documents | GET | purchase_plans 倒序列表 |

## 约定

- 所有 route handler 顶部 `export const dynamic = "force-dynamic"`（sqlite 本地读写，禁静态化）。
- 服务端校验：name 非空且唯一冲突返回 409；未知 id 返回 404。
- 前端数据获取：凡是要数据的页面都是 client component（`"use client"` 起手），一律 `fetch` 打 `/api/*` 后在 `useEffect` 里取数。没有 Server Action，也没有任何 Server Component 读 DB——只有根 `app/page.tsx`（仅 redirect）与 `app/layout.tsx`（静态外壳）不带 `"use client"`。
- UI 文案全部中文；Tailwind 工具类直接写，不引组件库；整体风格与既有外壳（zinc 系工作台）一致。
- 画布：@xyflow/react 12。node.data 只放展示与引用所需（actionId、端口清单、objectType 名与 kind），实体真身在 DB；连线校验用 `isValidConnection` 调 graph.ts 的同款逻辑（Object Type id 相等）。
- 执行引擎：就绪节点并行、并发上限 10；前向边决定首轮就绪，具名出口激活分支，回边触发受上限约束的新一轮会话（ADR-0009）。
- 运行之间并行且互相独立：同一个工作流可同时发起多次运行，跨运行状态一律按 runId 隔离（工作区目录、子进程、globalThis 上的取消/进程/输入表）。唯一的准入闸门在 `startRun`：同时 running 的运行数达 `MAX_CONCURRENT_RUNS`（16）即返回 429 而不排队——每个运行是一整个 node+tsx+dsh 子进程，队列归外部调用方管。仓库内付费批量脚本实行全有或全撤：任一项被拒时取消并等齐同批已经受理的运行后才报错。
- 多路运行的界面契约：导航侧栏的「运行中」面板逐路列出进行中的运行（轮询 `/api/runs?status=running`），点击深链 `/workflows/<id>?runId=<runId>` 精确跟随那一路；画布运行条在同一工作流多路并行时出现切换器，「运行」按钮在运行中仍可再次发起（发起后运行条切到新的一路，旧的经切换器回看）；运行详情的「回画布看动画」同样带 runId 深链。
- 一次运行独占 `data/runs/<workflowId>/<runId>/`、其中的共同 `workspace/` 与一个 dsh 子进程；每个 Action 的每一轮独占一个会话。全部输入物化到 `workspace/inputs/<节点id>/`——文件拷原件，文字物化为 `<节点名>.md`、JSON 为 `<节点名>.json`，提示里只给路径不内联（ADR-0012）；Action 之间只经共同工作区的产物文件交流（ADR-0006 / ADR-0008）。
- 运行期间 dsh 会话事件到达即写 `run_events` / `node_usage`；两条 SSE 端点轮询 SQLite 回放与追增量，不依赖进程内 pubsub。`run_events` 只是跨节点实时摘要；单个 Action 的完整轨迹以运行目录内的会话 JSONL 为权威源，用户展开面板时才读取并投影，不把原始 token chunk 复制进 SQLite 或默认下载到浏览器。
- 专用工作流调用入口可注册完成门禁；门禁核对最终产物后，引擎在同一事务内把完成证据写进 run 元数据、把精确 UTF-8 结果写进 `run_results`，随后才把运行标为 success。工作区与事件清理不删除持久业务结果；删除 run 时由外键级联删除。

## 引擎实现规范（DeepSeek Harness）

DeepSeek Harness（`dsh`）是唯一执行引擎（ADR-0006）。Next 进程负责运行编排，运行专属子进程
负责 cordis 组合、会话与模型循环；两者只经 stdio JSON-RPC 通信。

- **每运行一套运行时**：先创建共同工作区，再生成 `cordis.yml`，最后以
  `node --import tsx src/server/harness/runner.ts <cordis.yml>` 启动子进程；无常驻共享 host。
  子进程 stdout 只承载 JSON-RPC，stderr 写 `<run>/logs/harness.stderr.log`，运行结束在 `finally`
  中逐级收束子进程，任何路径都不得遗留 `running`。
- **受理时执行快照**：`resolveWorkflow` 在同一个事件循环片段内一次读取图所引用的 Object Type、
  Action、模型、端口、Skill 身份关系、Tool 源码与 Action→Tool 归属。运行受理、Tool 物化和稍后
  启动的每个 Action 都消费同一对象；共享库的并发保存只影响下一次运行。Skill 正文仍按下条的活链接
  契约读取，并在各 Action 会话启动前把当时可读的工作区投影全文写进节点快照；受理边界先验证并
  持有全部 Skill 投影，库内删除不会在运行与子进程完全收束前拆掉链接目标。
- **能力与隔离**：工作流级指令写 `workspace/AGENTS.md`；Skill 以 ASCII slug 链进
  `workspace/.agents/skills/`，由 `skill-filesystem` 按描述发现，不强制拼进提示。Tool 以 ASCII id
  物化为 `<run>/plugins/tool-<id>.ts` cordis 插件；工作流并集进入全局工具面后，每个 Action
  会话再按自己的 `action_tools` 引用收窄可见面。`DSH_HOME`、`dshHome` 与 `agentsHome` 全部钉在
  运行目录内，避免发现机器所有者的个人能力。
- **提示与产物**：Action 的任务、规则、上游取用说明、产物路径和出口要求组成一条文本消息。
  文件输入与上游产物都只给工作区相对路径；实质内容不沿边复制。循环第 N 轮的产物写进
  `rounds/N/`，不覆盖前一轮（ADR-0008 / ADR-0009）。
- **结构化结果**：每个 Action 会话按真实输出 schema 注册一次性的 `structured_output` 工具；
  工具参数只报告产物路径与所选出口，实质内容仍在文件。捕获值以 `tools/result` 的权威结果
  两阶段提交；会话收束后未捕获、出口不合法或声明的产物文件不存在，节点都失败。
- **模型调用**：模型行的 `providerId` 是 dsh 路由；`deepseek-official` 由
  `llm-deepseek` 提供。思考强度经会话 scope 上的 `agent/request` waterfall 无条件覆盖到调用配置；
  每节点最多 40 步、墙钟 15 分钟。图与全局设置在运行准入时冻结并传给执行器；网页保存只影响
  下一次运行。全局停用工具从会话工具面移除，晚注册工具另由 guard 兜底。
- **完成、取消与错误**：`session/prompt` 懒创建会话，Next 侧等待同一会话依次进入 running / idle；
  人工取消走 `session/cancel`，运行与节点进入独立的 `cancelled` 终态。节点完成后关闭会话，一次
  运行完成后关闭子进程；崩溃、超时与无产物都写入 run / run_node 的失败事实。无论发生在
  initialize 失败后的收束，还是正常执行的 finally，若 dispose 在终止升级后仍不能确认子进程
  退出，该运行都保持 active 隔离所有权：预览、清理、删除与新准入容量 fail-closed，不能用
  数据库终态冒充工作区已经静止。若 Action 会话与整个进程都无法确认静止，该会话的用量结算
  保持活跃：每条迟到 usage 落明细后，以本会话前的节点历史为固定基线幂等刷新节点累计与同一
  usage 事件；确认进程退出后再做最后一次刷新。节点累计或 usage 事件任一落库失败时，运行继续
  占用 active 所有权并定时重试，二者都持久化后才释放进程句柄与内存兜底。
- **事件、轨迹与用量**：`session.event` 通知到达时立刻归一为 text / reasoning / tool /
  session.idle / session.error 并落库。每个 step 的 usage chunk 是不累积值，按
  `(sessionId, turn:step)` 唯一化后求和；完整原始会话另存 `<run>/sessions/**/session.jsonl`。
  正常会话与隔离会话都用会话前节点基线幂等结算；节点累计与 usage 事件任一写入失败，
  都保留结算状态并在子进程退出后持续重试，不能只留数字而永久缺失事件。
  DeepSeek 的 `outputTokens` 已含 reasoning；运行详情、历史 API、画布运行条、轨迹与监控汇总
  均只把 input/output/cacheRead/cacheWrite 计入总 token，reasoning 只保留为拆分明细。
  运行详情展开某个 Action 时，从数据库记录的 `runDir` 枚举 `nodeId` 与 `nodeId#N` 会话，使用
  dsh 公共 codec 解包 chunk 行，再按回合与步骤折叠、按 `callId` 配对 Tool 调用与结果。界面只
  返回有长度边界且物理路径脱敏的折叠记录，输入 / 模型 / 工具三泳道和选中记录详情由同一投影
  生成；折叠状态不预取正文。

## 安全与健壮性约束（终审确认项）

- **运行输入的 file PortValue 不可信**：`/api/workflows/[id]/run` 直接接收请求体里的
  PortValue，`file.path` 必须经 `src/server/fs-safety.ts` 的 `resolveWithinData` 约束在
  `data/` 内（`isWithinData` 在 startRun 入口 422 拦截，`resolveWithinData` 在 runner.ts
  物化时纵深兜底），`file.name` 用 `safeBasename` 只取 basename——防目录穿越读任意文件外泄、
  或覆盖工作区目标目录之外的文件。
- **输入在受理边界可完整物化**：文字与 JSON 内容上限都是 32 MiB；JSON 按落盘格式预先
  序列化，递归过深等无法安全序列化的输入以 422 拒绝，不得先建立运行再异步失败。
- **文件输入原样物化，平台不做任何预处理（ADR-0011）**：所有文件输入原样拷贝为
  `inputs/<节点id>/<文件名>`；格式转换（抽文本、栅格化、逐页 `read_image`）是 Action 会话里
  模型用 `bash` 自己的工作。上传请求体在 multipart 解析前流式限流，单文件上限 32 MiB。
- **节点 id 在 Workflow 写入边界限制为 120 个 ASCII 字符**：它会直接成为
  `inputs/<节点id>/` 的目录段，不能让超长 id 在运行已受理后才以 `ENAMETOOLONG` 异步失败。
- **每个会话都有 `bash`，写入被沙箱圈定**：`bash` 与 `read`/`write`/`edit`/`read_image`/`skill`
  同为基础工具面，对所有 Action 可见。bash 与 write/edit 共用一份 `workspace-write` 沙箱策略，
  写入只放行运行工作区与系统临时目录，但两族的围栏强度不同：bash 的命令经 Seatbelt
  （`sandbox-exec`）内核围栏执行，runner 不可用时 fail-closed 拒绝执行命令；write/edit 走
  `dsh-fs-sandbox` 的进程内路径检查，上游明言它是策略围栏而非内核边界，也不经 runner。
  read 与网络两族都不受限；模型请求的沙箱升级因 `approval policy: "never"` 一律拒绝。
- **孤儿运行对账**：`src/instrumentation.ts` 启动钩子调用 `reconcileOrphanRuns`，把上次进程
  遗留的 `running` run 及其 running/pending 节点失败化——否则 SSE 结束条件永假、无限轮询。
- **模型输出用作文件名前先净化**：`save_purchase_plan` 里 `plan_no` 由模型产出，拼进备份
  文件名前先取 basename、做 NFKC 归一与字符白名单净化；最终绝对路径再约束在 `data/documents/` 内，
  防止穿越写出 `documents/` 之外。
- **HMR 下的运行所有权**：取消标记与在跑子进程句柄挂在 `globalThis`，使开发期 HMR 不会丢失
  对现存运行的取消和收束能力；运行结束必须删除对应句柄与取消标记。

## 首个案例种子（scripts/seed.ts，幂等：按 name upsert；内容取自 scratchpad research/erp-seed.json）

- Object Types：需求文件(file)、需求Prompt(text)、集采计划(text)、**审核评价(json+完整schema)**、
  **归档回执(text)** + 内置 text/file/json。
- Models：DeepSeek V4 Flash Vision / V4 Flash / V4 Pro，provider 路由均为 `deepseek-official`。
- Skills：集采计划编制规范、集采计划审核要点（全文见 erp-seed.json）。
- Tool：save_purchase_plan——物化为 cordis 插件并在本运行的 harness 子进程执行，用 `node:sqlite` 打开
  `process.env.ONTOFLOW_DB_PATH` 写 purchase_plans（17 字段见 schema.ts），备份 Markdown 写
  `ONTOFLOW_DATA_DIR/documents/<safePlanNo>-<日期>-<UUID>.md`；同一 `plan_no` 的并发 upsert 以
  `BEGIN IMMEDIATE` 排定顺序，提交新指针后删除被替换的旧备份，返回 { id, planNo, backupPath }。
- Actions（prompt/rule 全文见 erp-seed.json）：需求整理(deepseek, low)、集采计划生成(deepseek, high)、
  集采计划审核(deepseek, high；输出 审核评价+集采计划透传)、集采计划归档(deepseek, low；引用 save_purchase_plan)。
- Workflow「采购集采计划生成」：输入节点(需求文件) → 需求整理 → 集采计划生成 → 集采计划审核 →
  集采计划归档 → 输出节点(归档回执)；审核评价另接一个输出节点(审核评价)。
- 示例需求文件写入 data/samples/采购需求示例.txt。

## 第二个案例种子（scripts/seed-resume.ts）

- 工作流「简历匹配评分」是两个文件输入 → 一个解析 Action → 六个评委扇出 → 一个汇总 →
  一个输出的 11 节点图。
- `岗位JD文件` 与 `简历文件` 都以原件进入工作区，PDF、Markdown、纯文本一视同仁。
- 只有「简历评分·解析」使用 `deepseek-v4-flash-vision-exp`。它必须把输入当不可信数据，自己用
  bash 处理 PDF：`pdfinfo` 确认页数、`pdftotext` 抽文本层、`pdftoppm` 逐页栅格化后逐页调用
  `read_image` 核对，需要时写脚本裁剪放大局部；扫描件文本层为空也不得跳页，页面与文本冲突时
  以可见页面为准。
- 六个评委与汇总使用 `deepseek-v4-flash`。评委只经 `job.md` / `resume.md` 读解析结果；汇总等
  六份 `scores/*.md` 全部结算后，再回看 `job.md` / `resume.md`，自动裁决评委分歧、证据缺口、
  分数不自洽与不允许的评分依据。最终产物固定为 `match-result.json`：JSON Schema 禁止额外字段，
  `src/lib/resume-match.ts` 再核对总分、档位、否决、证据充分度、硬性条件及改分记录的跨字段关系。
- 汇总 Action 独享 `validate_resume_match_result` Tool；它写出文件后必须反复调用，直到轨迹留下
  `valid=true`、错误为空且带实际读取内容 SHA-256 的回执。引擎在写 `success` 前核对该 SHA-256
  与最终产物字节，并把它固化进运行元数据，同时把精确 JSON 写入 `run_results`；工作区与事件明细
  随后可以清理，成功结果不会因此失去读取依据。
  只写出合法 JSON 却跳过 Tool、回执落库失败或校验后又改文件的运行都收束为失败。Agent 自检与
  API 边界不会各自维护一套规则。该入口还会验证汇总 Action 仍引用此 Tool、源码 SHA-256 匹配
  内置 pin，本次全局设置快照没有停用它或 `read`/`write`/`bash`/`read_image`/
  `structured_output` 这些必需基础工具，且汇总 Action 不在任何回边的重入范围内。受理时把
  结果输出节点和汇总校验节点 id 与来源证明
  一起持久化，不按 `startedAt` 反推修订。岗位 JD 与简历输入还必须
  各自使用指定 Object Type，并分别连到解析 Action 的对应端口；八个固定 Action 的完整输入输出
  端口集合、产物路径与 11 个指定节点间的 23 条业务边必须精确匹配种子定义，六位评审各自接齐岗位与
  简历且各有一份结论进入汇总。工作流描述生成的共同指令，以及八个 Action 的 prompt、rule、
  provider/model、思考强度、重入策略及完整 Skill/Tool 集合，也必须匹配经过审查的 seed 摘要 pin；
  网页编辑任一行为定义后，专用入口拒绝付费
  运行，直到 seed 定义与 pin 经过代码审查并同步更新。随后把通过预检的同一图、
  Action/Tool 定义与设置对象交给 `startResolvedRun`，并发画布或共享库保存不能换掉实际执行快照。
  缺失或被改写的契约不得先产生模型费用再失败。
