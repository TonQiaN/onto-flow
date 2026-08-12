# FlowForge v2 实现契约

v1 契约见 [DESIGN.md](./DESIGN.md)（执行引擎、opencode 集成规范仍然有效）。
领域语义见 [../CONTEXT.md](../CONTEXT.md)，本轮新决策见 ADR-0003（标签而非文件夹）、
ADR-0004（画布编辑共享 Action）。

v2 三阶段：① 库与数据层 ② 画布与运行体验 ③ 监控页。本文件是三阶段共同的接口基准。

## 已定的地基（schema 已 push，勿改）

- `tags` / `entity_tags`：跨五库的多归属标签，`entityKind ∈ workflow|action|skill|tool|object_type`。
  标签名可含 `/` 表达层级。
- `revisions`：`(entityKind, entityId, versionNo)` 唯一，`payload` 存该实体完整定义，
  `pinned` 标记不被清理。
- `run_nodes` 新增：`snapshot`（运行快照 JSON）、六个用量字段（inputTokens / outputTokens /
  reasoningTokens / cacheReadTokens / cacheWriteTokens / cost）、状态多一个 `cancelled`。
- `runs` 新增：`workflowName`（冗余快照）、状态多一个 `cancelled`。
- `node_usage`：逐条 assistant 消息的用量明细，`(sessionId, messageId)` 唯一。

## 一、通用列表查询契约（五个库的 GET 列表统一支持）

Query 参数（全部可选，缺省即不过滤）：

| 参数 | 含义 |
|---|---|
| `q` | 关键词，匹配 name + description（大小写不敏感，`LIKE %q%`） |
| `tags` | 逗号分隔的 tag id，**AND 语义**（同时具备这些标签） |
| `sort` | `updated_desc`(默认) / `updated_asc` / `name_asc` / `name_desc` / `refs_desc` |
| `page` | 从 1 开始，默认 1 |
| `pageSize` | 默认 30，上限 100 |

响应统一形状：

```ts
{ items: T[], total: number, page: number, pageSize: number }
```

每个 item 在原有字段基础上追加：

```ts
tags: Array<{ id: string; name: string; color: string | null }>
refCount: number   // 被引用次数，见第三节
```

> 破坏性变更：列表 API 由「裸数组」改为上面的信封形状，前端一并改。不做兼容层（AGENTS.md）。

## 二、标签 API

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/tags` | GET | `?kind=action` 可选。返回 `Array<{id,name,color,counts:{[kind]:number}}>`，按 name 升序 |
| `/api/tags` | POST | `{name, color?}`；name 去空白、非空、唯一（409）；`/` 分隔层级，不允许空段（400） |
| `/api/tags/[id]` | PUT | `{name?, color?}`；改名是全局操作 |
| `/api/tags/[id]` | DELETE | 直接删，`entity_tags` 级联清除（标签是软分类，删除无需引用保护） |
| `/api/tags/assign` | POST | `{entityKind, entityId, tagIds: string[]}` 整体替换该实体的标签集合 |

前端由 `tags` 的扁平列表自行构建层级树（按 `/` 拆分），无需服务端返回树。

## 三、引用（反向索引）API

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/references?kind=&id=` | GET | 谁在引用这个实体 |
| `/api/references/counts?kind=` | GET | `{ [entityId]: number }`，供列表页批量取引用数 |
| `/api/references/orphans?kind=` | GET | 未被任何人引用的实体清单（监控页孤儿检测复用） |
| `/api/references/impact` | POST | 改动前的影响预览，见下 |

`GET /api/references` 响应：

```ts
{
  refs: Array<{
    kind: "workflow" | "action";     // 引用方的种类
    id: string; name: string;
    detail: string;                   // 如「节点：集采计划审核」「输入端口：集采计划」
    href: string;                     // 可跳转的前端路径
  }>
}
```

引用关系定义（唯一事实源，各处实现照此）：
- Action ← `workflow_nodes.action_id`
- Skill ← `action_skills`
- Tool ← `action_tools`
- Object Type ← `action_ports.object_type_id` 与 `workflow_nodes.object_type_id`
- Workflow ← 无（顶层实体，refCount 恒为 0）

`POST /api/references/impact` 请求 `{ kind:"action", id, nextPorts: Array<{direction,name,objectTypeId}> }`，
响应 `{ brokenEdges: Array<{workflowId, workflowName, nodeLabel, portName, reason}> }`——
列出若按 nextPorts 保存，哪些工作流的哪些连线会失效（端口被删或改名、类型变更）。

## 四、修订 API

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/revisions?kind=&id=` | GET | 该实体的修订列表（倒序，含 versionNo/note/pinned/createdAt，不含 payload） |
| `/api/revisions/[revId]` | GET | 单条含 payload |
| `/api/revisions/[revId]/restore` | POST | 回滚：把 payload 写回实体（走与 PUT 相同的写入路径与校验），并**为回滚动作再留一版**修订 |
| `/api/revisions/[revId]` | PATCH | `{pinned?, note?}` |

写入时机：五个库的 **POST 创建**与 **PUT 更新**成功后，在同一事务内追加一条修订
（`versionNo` = 该实体当前最大值 + 1，从 1 开始）。payload 就是该实体的完整定义
（Action 含 ports/skillIds/toolIds；Workflow 含 nodes/edges）。

## 五、共享 UI 组件（`src/components/library/`，五个库页面必须复用，不得各写一套）

```tsx
// 层级标签树（左栏）。tags 扁平列表按 `/` 构建树；点击节点切换选中；父节点选中含子孙。
<TagTree kind={EntityKind} selected={string[]} onChange={(ids:string[])=>void} />

// 搜索 + 排序 + 分页状态条，状态写进 URL query（useSearchParams + router.replace，scroll:false）
<LibraryToolbar
  q={string} onQChange={(v:string)=>void}         // 内部 300ms 防抖
  sort={SortKey} onSortChange={(s:SortKey)=>void}
  total={number} page={number} pageSize={number} onPageChange={(p:number)=>void}
  right={ReactNode}                                // 「新建」按钮插槽
/>

// 实体上的标签编辑（下拉多选 + 新建标签）
<TagPicker kind={EntityKind} entityId={string} value={Tag[]} onChange={(t:Tag[])=>void} />

// 「被引用」面板：自己 fetch /api/references
<ReferencesPanel kind={EntityKind} id={string} />

// 修订历史面板：列表 + 与当前版 diff + 回滚 + pin/备注
<RevisionPanel kind={EntityKind} id={string} onRestored={()=>void} />

// 统一列表骨架：左树 + 右内容 + 空态/加载态/错误态
<LibraryLayout title={string} subtitle={string} tree={ReactNode} children={ReactNode} />
```

URL 参数命名（五个库一致）：`?q=&tags=&sort=&page=`。

## 六、引擎改动（阶段一部分）

1. **运行快照**：`runActionNode` 解析出 Action 配置后，把完整配置写进 `run_nodes.snapshot`：
   ```ts
   { actionId, actionName, prompt, rule, model:{providerId,modelId,displayName},
     reasoningEffort, skills:[{name,content}], tools:[{name,code}],
     ports:{inputs:[{name,objectTypeName,kind}], outputs:[...]} }
   ```
   写入时机：会话创建前（即使随后失败也留有快照）。
2. **用量捕获**：事件循环处理 `message.updated`，当 `info.role==="assistant"` 且带 tokens 时，
   按 `(sessionID, messageID)` upsert 进 `node_usage`，同时累加进 `run_nodes` 的六个用量字段
   （累加 = 重算该 run_node 下 node_usage 的合计，避免重复计数）。
3. `runs.workflowName` 在 startRun 时写入。
4. `cancelled` 状态：引擎侧支持把节点/运行标为 cancelled（取消入口在阶段二实现）。

## 七、阶段二 / 阶段三 要点（届时细化）

- 阶段二：节点面板接 TagTree+搜索；双击节点 → 复用 Action 编辑器（同一组件）+ ReferencesPanel +
  影响预览 + 「复制为新 Action 并替换本节点」；五态视觉 + 边流动动画 + 自动跟随 + 取消运行
  （`session.abort` + 标记 cancelled + 下游 skipped）。
- 阶段三：`/monitor` 六标签（总览 / 实时会话 / Trace / 日志检索 / 成本分析 / 系统健康），
  全局 SSE `/api/monitor/stream`，手动清理（工作区 / 事件明细 / 旧运行）与孤儿检测。
  左下角入口，与主导航分区。
