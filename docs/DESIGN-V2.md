# OntoFlow v2 实现契约

v1 与现行 DeepSeek Harness 引擎契约见 [DESIGN.md](./DESIGN.md)，领域语义见
[../CONTEXT.md](../CONTEXT.md)。文件夹决策见 ADR-0005；ADR-0010 已推翻 ADR-0004，但节点自带
定义的迁移尚未实现，因此本文涉及共享 Action 的部分只描述当前代码，不是目标领域模型。

v2 三阶段：① 库与数据层 ② 画布与运行体验 ③ 监控页。本文件是三阶段共同的接口基准。

## 已定的地基（schema 已 push，勿改）

- `folders` / `entity_folders`：跨四库（`entityKind ∈ action|skill|tool|object_type`）共享的
  单归属文件夹树（ADR-0005）。`folders.name` 是单段名（不含 `/`），层级由 `parentId` 表达；
  `entity_folders` 无行 = 未归类；workflow 明确不分类。
- `revisions`：`(entityKind, entityId, versionNo)` 唯一，`payload` 存该实体完整定义，
  `pinned` 标记不被清理。
- `run_nodes` 新增：`snapshot`（运行快照 JSON）、六个用量字段（inputTokens / outputTokens /
  reasoningTokens / cacheReadTokens / cacheWriteTokens / cost）、状态多一个 `cancelled`。
- `runs` 新增：`workflowName`（冗余快照）、状态多一个 `cancelled`。
- `node_usage`：逐 step 的用量明细，`messageId` 取 `turn:step`，`(sessionId, messageId)` 唯一。

## 一、通用列表查询契约（五个库的 GET 列表统一支持）

Query 参数（全部可选，缺省即不过滤）：

| 参数 | 含义 |
|---|---|
| `q` | 关键词，匹配 name + description（大小写不敏感，`LIKE %q%`） |
| `folder` | 单个文件夹 id，**含全部子孙**语义（命中该文件夹整棵子树内的实体）；kind=workflow 忽略此参数 |
| `sort` | `updated_desc`(默认) / `updated_asc` / `name_asc` / `name_desc` / `refs_desc` |
| `page` | 从 1 开始，默认 1 |
| `pageSize` | 默认 30，上限 100 |

响应统一形状：

```ts
{ items: T[], total: number, page: number, pageSize: number }
```

每个 item 在原有字段基础上追加：

```ts
folder: { id: string; name: string; path: string } | null   // path = 根到本文件夹的 name 用 "/" 连接；未归类与 workflow 恒为 null
refCount: number   // 被引用次数，见第三节
```

`folder` 取「自身 + 全部子孙」的理由：文件夹树（第五节）是单选「进入」语义，
点父文件夹 = 看到其整棵子树下的全部内容，与树上显示的子树实体计数一致。
过滤实现为 `subtreeIds(folderId)`（自身 + 全部子孙 id），实体 id ∈ 指派到这些
文件夹的集合；文件夹不存在时结果强制为空页。

> 破坏性变更：列表 API 由「裸数组」改为上面的信封形状，前端一并改。不做兼容层（AGENTS.md）。

## 二、文件夹 API

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/folders` | GET | `{ folders: FolderDto[] }`，按 name 升序 |
| `/api/folders?kind=action` | GET | `{ folders: FolderDto[], entities: Array<{id,name,folderId\|null}> }`（本库实体叶子）；kind 非四库之一 400 |
| `/api/folders` | POST | `{name, parentId?}` → FolderDto；name 折叠空白、非空、不含 `/`；父不存在 404，同级同名 409 |
| `/api/folders/[id]` | PATCH | `{name?, parentId?}`（parentId 传 null = 移到根）→ FolderDto；移到自己或自己的子孙 400，目标同级同名 409 |
| `/api/folders/[id]` | DELETE | `{ ok: true }`；子文件夹与实体指派上移到父级（父为 null 时实体变未归类），实体本身永不删除 |
| `/api/folders/assign` | POST | `{entityKind, entityId, folderId: string \| null}` 单归属指派，null = 取消归类 |

前端由 `folders` 的扁平列表 + `parentId` 自行组装树，无需服务端返回树。

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
// 文件夹树（左栏，四个库页用；workflows 列表页无左栏）。Zed 式：树里是文件夹 + 本库
// 实体叶子，未归类实体是根级散叶子；单选「进入」文件夹（含全部子孙，见第一节），
// selected=null 即「全部」；点实体叶子 onOpenEntity 在右侧列表定位并高亮；
// 右键管理（新建子文件夹/重命名/删除），拖实体入文件夹、拖文件夹改层级。
<FolderTree
  kind={EntityKind}                       // 只会传四库之一
  selected={string | null}                // null = 全部
  onSelect={(folderId: string | null) => void}
  onOpenEntity={(entity: EntityLeaf) => void}
/>

// 搜索 + 排序 + 分页状态条，状态写进 URL query（useSearchParams + router.replace，scroll:false）
<LibraryToolbar
  q={string} onQChange={(v:string)=>void}         // 内部 300ms 防抖
  sort={SortKey} onSortChange={(s:SortKey)=>void}
  total={number} page={number} pageSize={number} onPageChange={(p:number)=>void}
  right={ReactNode}                                // 「新建」按钮插槽
/>

// 编辑器里的文件夹选择器（备选归类途径，只选择不管理）。触发按钮显示 value?.path ?? "未归类"
<FolderPicker
  kind={EntityKind}
  entityId={string}                 // '' = 新建表单未落库，只改内存态，落库后由页面补指派
  value={FolderRef | null}
  onChange={(folder: FolderRef | null) => void}
/>

// 「被引用」面板：自己 fetch /api/references
<ReferencesPanel kind={EntityKind} id={string} />

// 修订历史面板：列表 + 与当前版 diff + 回滚 + pin/备注
<RevisionPanel kind={EntityKind} id={string} onRestored={()=>void} />

// 统一列表骨架：左树 + 右内容 + 空态/加载态/错误态
<LibraryLayout title={string} subtitle={string} tree={ReactNode} children={ReactNode} />
```

URL 参数命名：四个库页 `?q=&folder=&sort=&page=`（另有 `highlight` 定位并高亮卡片）；
workflows 列表页不分类，无 `folder`（LibraryLayout 不传 tree）。

## 六、引擎改动（阶段一部分）

1. **运行快照**：`resolveWorkflow` 在受理时冻结图、Action、模型、端口与 Tool 定义；`runActionNode`
   不再回读这些共享库行，只把这份定义和本轮实际渲染提示写进 `run_nodes.snapshot`。Skill 只冻结
   引用关系，正文在会话启动前从工作区活链接读取，并把当时的完整 `SKILL.md` 一并写入；链接目录
   只由 Skill 实体 id 派生，网页改名不会让已经受理的运行断链：
   ```ts
   { actionId, actionName, prompt, rule, model:{providerId,modelId,displayName},
     reasoningEffort, skills:[{name,content}], renderedPrompt,
     ports:{inputs:[{name,objectTypeName,kind}], outputs:[{...,artifactPath,exitName}]} }
   ```
   节点快照写入时机：会话创建前（即使随后失败也留有快照）。
2. **用量捕获**：dsh 每个 step 发一条不累积的 usage chunk，按
   `(sessionId, turn:step)` 唯一化写入 `node_usage`；节点收束时把该会话各 step 求和写入
   `run_nodes` 的用量字段。
3. `runs.workflowName` 在 startRun 时写入。
4. `cancelled` 状态：引擎侧支持把节点/运行标为 cancelled（取消入口在阶段二实现）。

## 七、阶段二 / 阶段三 要点（届时细化）

- 阶段二：节点面板按文件夹路径分组（单归属，未归类沉底）+ 关键词搜索；双击节点 → 复用 Action 编辑器（同一组件）+ ReferencesPanel +
  影响预览 + 「复制为新 Action 并替换本节点」；五态视觉 + 边流动动画 + 自动跟随 + 取消运行
  （`session/cancel` + 标记 cancelled + 下游 skipped）。
- 阶段三：`/monitor` 六标签（总览 / 实时会话 / Trace / 日志检索 / 成本分析 / 系统健康），
  全局 SSE `/api/monitor/stream`，手动清理（工作区 / 事件明细 / 旧运行）与孤儿检测。
  左下角入口，与主导航分区。
