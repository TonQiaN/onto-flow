import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
  blob,
} from "drizzle-orm/sqlite-core";
// 相对路径而非 @/ 别名：drizzle-kit 打包 schema.ts 时不认 tsconfig 的路径映射。
import { EMPTY_RUN_GRAPH, type RunGraph } from "../lib/run-graph";
import type { ArtifactValidation } from "../lib/artifact-contract";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
};

/** 五个库共用的实体种类（修订、引用查询都按它区分） */
export const ENTITY_KINDS = ["workflow", "action", "skill", "tool", "object_type"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** 可进文件夹的四个库（workflow 明确不分类，ADR-0005） */
export const FOLDER_ENTITY_KINDS = ["action", "skill", "tool", "object_type"] as const;
export type FolderEntityKind = (typeof FOLDER_ENTITY_KINDS)[number];

/**
 * 文件夹：跨四个库共享的单归属流程树（ADR-0005，推翻 ADR-0003）。
 * name 是单段名（不含 `/`），层级由 parentId 表达；同级同名由服务层拒绝
 * （SQLite 唯一索引把 NULL 视作互不相等，root 层级无法用 DB 约束）。
 */
export const folders = sqliteTable(
  "folders",
  {
    id: id(),
    name: text("name").notNull(),
    /** null = 根层级 */
    parentId: text("parent_id").references((): AnySQLiteColumn => folders.id),
    ...timestamps,
  },
  (t) => [index("folders_by_parent").on(t.parentId)],
);

/** 实体 → 文件夹的单归属指派；无行 = 未归类。故意不 cascade：删文件夹必须显式上移内容 */
export const entityFolders = sqliteTable(
  "entity_folders",
  {
    entityKind: text("entity_kind", { enum: FOLDER_ENTITY_KINDS }).notNull(),
    entityId: text("entity_id").notNull(),
    folderId: text("folder_id")
      .notNull()
      .references(() => folders.id),
  },
  (t) => [
    primaryKey({ columns: [t.entityKind, t.entityId] }),
    index("entity_folders_by_folder").on(t.folderId),
  ],
);

/**
 * 修订：实体每次保存留存的完整定义快照，可查看/对比/回滚。
 * payload 是该实体的完整定义（含关联：Action 的端口、preloadSkillIds、toolIds；Skill 的 files；
 * Tool 的契约六字段；工作流的 instructions、settings、skillIds、toolIds 与图的 nodes/edges）。
 */
export const revisions = sqliteTable(
  "revisions",
  {
    id: id(),
    entityKind: text("entity_kind", { enum: ENTITY_KINDS }).notNull(),
    entityId: text("entity_id").notNull(),
    versionNo: integer("version_no").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    note: text("note").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("revisions_entity_version").on(t.entityKind, t.entityId, t.versionNo)],
);

/** 对象类型注册表：端口的 nominal 类型（ADR-0002） */
export const objectTypes = sqliteTable("object_types", {
  id: id(),
  name: text("name").notNull().unique(),
  kind: text("kind", { enum: ["text", "file", "json"] }).notNull(),
  description: text("description").notNull().default(""),
  /** kind=json 时可选的 JSON Schema（序列化字符串），同时用作结构化输出 schema */
  jsonSchema: text("json_schema"),
  /** 内置类型（text/file/json 兜底）不可删除 */
  builtin: integer("builtin", { mode: "boolean" }).notNull().default(false),
  ...timestamps,
});

export const skills = sqliteTable("skills", {
  id: id(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  /**
   * SKILL.md 的正文（不含 frontmatter）。技能是一个目录：正文加 skill_files 里的资源文件，
   * 投影到 data/skills/<slug>/，归工作流的技能集所有、对全部 Action 可见，由模型看描述
   * 自行加载；必定要用上的由 Action 预载（ADR-0016）。
   */
  content: text("content").notNull(),
  ...timestamps,
});

/**
 * 技能目录里的资源文件（参考资料、脚本）。path 是目录内相对路径，写入口校验：不含 ..、
 * 不以 / 开头、单文件 ≤ 1 MiB、每技能 ≤ 32 个；数据库是唯一真相，磁盘投影随写重建。
 */
export const skillFiles = sqliteTable(
  "skill_files",
  {
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    content: blob("content", { mode: "buffer" }).notNull(),
    size: integer("size").notNull(),
  },
  (t) => [primaryKey({ columns: [t.skillId, t.path] })],
);

/**
 * Tool 是 OntoFlow 契约，不是裸 cordis 插件（ADR-0017）：作者只写模型可见的名字、描述、
 * 参数 schema、可选的输出 schema 与超时，以及一个 execute 模块；平台物化时套上自己维护的
 * cordis 包装（src/server/harness/tool-plugin.ts）。
 */
export const tools = sqliteTable("tools", {
  id: id(),
  /** 库里的展示名（中文） */
  name: text("name").notNull().unique(),
  /** 模型可见的工具名：^[a-z][a-z0-9_]{0,63}$，全库唯一；也是 disabledTools 与 Action 收窄用的公名 */
  publicName: text("public_name").notNull().unique(),
  description: text("description").notNull().default(""),
  /** 参数的对象根 JSON Schema（上游子集：不允许 type 数组） */
  parameters: text("parameters", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  /** 返回值的对象根 JSON Schema；省略即不校验返回值 */
  output: text("output", { mode: "json" }).$type<Record<string, unknown> | null>(),
  /** 单次调用预算（毫秒）；声明了才受 timeout-policy 约束 */
  timeoutMs: integer("timeout_ms"),
  /**
   * execute 模块源码：`export default async function execute(args, ctx)`，ctx 是
   * src/server/harness/tool-contract.ts 定义的稳定小面。可以 import node: 内置模块与仓库依赖
   * （模块解析从运行目录向上走到仓库根），不得 import @deepseek-ai/*。
   */
  code: text("code").notNull(),
  ...timestamps,
});

/** 可选模型白名单；providerId 是 dsh provider 路由，不是厂商显示名。 */
export const models = sqliteTable(
  "models",
  {
    id: id(),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    displayName: text("display_name").notNull(),
  },
  (t) => [uniqueIndex("models_provider_model").on(t.providerId, t.modelId)],
);

export const actions = sqliteTable("actions", {
  id: id(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  /** 任务描述，可用 {{输入端口名}} 占位符 */
  prompt: text("prompt").notNull(),
  /** 执行时必须遵守的规则，注入上下文 */
  rule: text("rule").notNull().default(""),
  modelId: text("model_id")
    .notNull()
    .references(() => models.id),
  /** 档位对齐 dsh 的 reasoningEffort：off 关思考，其余三档递增（ADR-0006） */
  reasoningEffort: text("reasoning_effort", {
    enum: ["off", "low", "high", "max"],
  })
    .notNull()
    .default("high"),
  /** 被回边重入的上限；0 表示不可重入，不能作为回边的目标（ADR-0009） */
  maxReentries: integer("max_reentries").notNull().default(0),
  /** 重入次数耗尽时的收束方式：fail 判失败，accept 以最后一轮结果收束 */
  onExhausted: text("on_exhausted", { enum: ["fail", "accept"] })
    .notNull()
    .default("fail"),
  ...timestamps,
});

export const actionPorts = sqliteTable(
  "action_ports",
  {
    id: id(),
    actionId: text("action_id")
      .notNull()
      .references(() => actions.id, { onDelete: "cascade" }),
    direction: text("direction", { enum: ["input", "output"] }).notNull(),
    name: text("name").notNull(),
    objectTypeId: text("object_type_id")
      .notNull()
      .references(() => objectTypes.id),
    position: integer("position").notNull().default(0),
    /**
     * 输出端口的产物路径（相对运行工作区）。Action 把实质内容写进这个文件，
     * 下游经连线拿到的只是「去读这个路径」（ADR-0008）。输入端口恒为 null。
     */
    artifactPath: text("artifact_path"),
    /**
     * 输出端口所属的具名出口。null 是默认出口——节点没有分支，全部输出恒生效。
     * 一旦有具名出口，该 Action 的每个输出端口都必须归属某个出口，运行时由数据面
     * 的 exit 字段选中其一，只有它的出线激活（ADR-0009）。
     */
    exitName: text("exit_name"),
  },
  (t) => [uniqueIndex("action_ports_unique").on(t.actionId, t.direction, t.name)],
);

/**
 * Action 预载的技能：会话开始时以上游「/技能名」显式调用注入，等同于人在 CLI 里敲斜杠命令。
 * 只能预载所在工作流技能集里的技能，工作流保存与运行受理时都校验（ADR-0016）。
 * 预载与可见勾选是在工作流已引用范围内的选择、不是引用，删除保护只看工作流集合；
 * 实体真被删时这里随之级联，不让一次不受保护的选择把删除撞成外键 500。
 */
export const actionPreloads = sqliteTable(
  "action_preloads",
  {
    actionId: text("action_id")
      .notNull()
      .references(() => actions.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.actionId, t.skillId] })],
);

/** Action 可见的 Tool：工作流 Tool 集的子集，未勾选的在该 Action 会话里被收窄掉（ADR-0016）。 */
export const actionTools = sqliteTable(
  "action_tools",
  {
    actionId: text("action_id")
      .notNull()
      .references(() => actions.id, { onDelete: "cascade" }),
    toolId: text("tool_id")
      .notNull()
      .references(() => tools.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.actionId, t.toolId] })],
);

/**
 * 全局设置：单行表，整份文档存 JSON。
 *
 * 不拆成列是因为它整体被读写——每次运行开始时读一次生成组合配置，设置页整份
 * 提交。拆列只会让「加一个设置项」变成一次 schema 变更。校验在写入口做，
 * 见 src/server/settings.ts。
 */
export const settings = sqliteTable("settings", {
  /** 恒为 1：这张表只有一行 */
  id: integer("id").primaryKey(),
  document: text("document", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const workflows = sqliteTable("workflows", {
  id: id(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  /** 工作流级共同指令：原样物化为 workspace/AGENTS.md（ADR-0016） */
  instructions: text("instructions").notNull().default(""),
  /** 工作流设置：可切换插件的覆盖与启用的 MCP 子集；形状见 src/lib/workflow-settings.ts */
  settings: text("settings", { mode: "json" })
    .$type<{ toggles: Record<string, boolean>; mcpServers: string[] }>()
    .notNull()
    .default({ toggles: {}, mcpServers: [] }),
  ...timestamps,
});

/** 工作流的技能集：symlink 进工作区、对全部 Action 可见的技能（ADR-0016）。 */
export const workflowSkills = sqliteTable(
  "workflow_skills",
  {
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.workflowId, t.skillId] })],
);

/** 工作流的 Tool 集：全部物化进运行、注册到全局工具面，再由各 Action 收窄（ADR-0016）。 */
export const workflowTools = sqliteTable(
  "workflow_tools",
  {
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    toolId: text("tool_id")
      .notNull()
      .references(() => tools.id),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.workflowId, t.toolId] })],
);

export const workflowNodes = sqliteTable("workflow_nodes", {
  id: id(),
  workflowId: text("workflow_id")
    .notNull()
    .references(() => workflows.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["action", "input", "output"] }).notNull(),
  /** kind=action 时引用的 Action（纯引用，无实例级覆盖） */
  actionId: text("action_id").references(() => actions.id),
  /** kind=input|output 时节点承载的 Object Type */
  objectTypeId: text("object_type_id").references(() => objectTypes.id),
  label: text("label").notNull().default(""),
  x: real("x").notNull().default(0),
  y: real("y").notNull().default(0),
});

export const workflowEdges = sqliteTable("workflow_edges", {
  id: id(),
  workflowId: text("workflow_id")
    .notNull()
    .references(() => workflows.id, { onDelete: "cascade" }),
  sourceNodeId: text("source_node_id")
    .notNull()
    .references(() => workflowNodes.id, { onDelete: "cascade" }),
  /** 输入/输出节点的端口名固定为 "value" */
  sourcePort: text("source_port").notNull(),
  targetNodeId: text("target_node_id")
    .notNull()
    .references(() => workflowNodes.id, { onDelete: "cascade" }),
  targetPort: text("target_port").notNull(),
});

export const runs = sqliteTable("runs", {
  id: id(),
  workflowId: text("workflow_id")
    .notNull()
    .references(() => workflows.id, { onDelete: "cascade" }),
  /** cancelled 是人为中止的独立终态，区别于 failed */
  status: text("status", {
    enum: ["running", "success", "failed", "cancelled"],
  }).notNull(),
  /** 冗余快照：运行当时的工作流名，改名后历史仍可读 */
  workflowName: text("workflow_name").notNull().default(""),
  error: text("error"),
  /** 本次运行的运行目录（相对仓库根）；工作区、日志、会话记录都在它下面 */
  runDir: text("run_dir"),
  /**
   * 运行元数据：受理入口来源，以及工作流级共同指令与各项技能/工具在启动时刻的内容摘要。
   * 工作区里是指向全局库活目录的链接，所以摘要只能证明「是不是同一份」，
   * 证明不了能把旧内容取回来（ADR-0007）。
   */
  imports: text("imports", { mode: "json" }).$type<Record<string, unknown> | null>(),
  /**
   * 受理时冻结的三层设置（ADR-0016）：全局设置文档、工作流设置与集合、以及二者合成的生效
   * 开关与 MCP 子集。运行详情据此解释「那次为什么有 web_search」；形状见 src/lib/workflow-settings.ts。
   */
  settingsSnapshot: text("settings_snapshot", { mode: "json" }).$type<Record<
    string,
    unknown
  > | null>(),
  /**
   * 受理时与 runs 行同一事务冻结的图（ADR-0018）：节点、坐标、端口与出口名、连线。
   * 运行页只读它，从不回查 workflow_nodes / workflow_edges——运行会活过图的下一次编辑。
   * 早于 ADR-0018 的运行由列默认值拿到空图，同一条渲染路径，不留旧数据分支。
   */
  graph: text("graph", { mode: "json" }).$type<RunGraph>().notNull().default(EMPTY_RUN_GRAPH),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
});

/**
 * 专用工作流调用入口的持久业务结果。它已经通过入口的完成门禁，因此独立于可清理的
 * 运行工作区；删除 runs 行时级联删除，结果保留期与运行历史一致。
 */
export const runResults = sqliteTable("run_results", {
  runId: text("run_id")
    .primaryKey()
    .references(() => runs.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  /** 保留完成门禁核对过的精确 UTF-8 文本，不重新序列化 JSON 改变摘要。 */
  content: text("content").notNull(),
  sha256: text("sha256").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const runNodes = sqliteTable(
  "run_nodes",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    /** 冗余快照：节点当时的展示名（Action 名/输入输出类型名），历史回看不受后续改名影响 */
    label: text("label").notNull(),
    status: text("status", {
      enum: ["pending", "running", "success", "failed", "skipped", "cancelled"],
    }).notNull(),
    /** 节点各轮会话的累计用量；逐 step 明细来源见 node_usage。 */
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    /** 人民币；节点各轮会话费用的累计，口径同 node_usage.cost。 */
    cost: real("cost").notNull().default(0),
    sessionId: text("session_id"),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("run_nodes_unique").on(t.runId, t.nodeId)],
);

/**
 * 一个节点的一次执行一行（ADR-0018）。输入、产物与运行快照只存在这里：`run_nodes`
 * 一个节点只有一行，回边重入会覆盖它的起止与终态，只看它回放不出「第 1 轮打回、
 * 第 2 轮通过」；`run_nodes` 只继续作为节点的最新状态行与用量累计行。
 *
 * 每一次执行都算一轮，不只 Action：输入 / 输出节点与被跳过的节点由 runner.ts 直接落成
 * 零时长的 success / skipped 行——回边重置的是下游全部节点，评审循环里输出节点会在打回
 * 那轮被跳过、在通过那轮成功。取消、整运行失败与启动对账不属于任何一轮，它们把仍在 running
 * 的行收口成对应终态，并给仍 pending 的节点补一行零时长 skipped。
 */
export const runNodeRounds = sqliteTable(
  "run_node_rounds",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    /** 第几轮，0 起；重入把整个环体的轮次一起推进（ADR-0009） */
    round: integer("round").notNull(),
    /** 本轮的会话 id；输入 / 输出 / 被跳过的节点没有会话 */
    sessionId: text("session_id"),
    status: text("status", {
      enum: ["running", "success", "failed", "cancelled", "skipped"],
    }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    /** 本轮走出的具名出口；无具名出口为 null */
    exitName: text("exit_name"),
    error: text("error"),
    /**
     * 这一轮自己的 PortValue 映射（`{ [portName]: PortValue }`）与运行快照——快照是该节点
     * 本轮实际使用的完整配置（prompt、rule、各 Skill 与 Tool 全文、模型、思考强度、端口
     * 定义），不随实体后续修改而改变。抽屉按光标所在轮读这一行；事件清理只置空重载荷列。
     */
    inputs: text("inputs", { mode: "json" }).$type<Record<string, unknown> | null>(),
    outputs: text("outputs", { mode: "json" }).$type<Record<string, unknown> | null>(),
    snapshot: text("snapshot", { mode: "json" }).$type<Record<string, unknown> | null>(),
    /** 产物契约证据随轮次按需读取，事件清理与其他重载荷一起置空。 */
    artifactValidation: text("artifact_validation", {
      mode: "json",
    }).$type<ArtifactValidation | null>(),
    /** 事件清理的事实；null 表示没有清理，不能从空载荷反推。 */
    payloadClearedAt: integer("payload_cleared_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("run_node_rounds_unique").on(t.runId, t.nodeId, t.round)],
);

export const runEvents = sqliteTable(
  "run_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    nodeId: text("node_id"),
    /**
     * 事件所属的会话，据此把事件归到轮（第 0 轮是节点 id，之后是 `<节点id>#<轮次+1>`）。
     * 可空只为早于 ADR-0018 的历史行；新写入的事件没有一条为 null。
     */
    sessionId: text("session_id"),
    ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [
    // SSE 轮询（run_id=? and id>?）、tool/result 的 call 关联查询与删除运行时的
    // 外键级联都按运行过滤；没有它们全是整表扫描，并行运行的交错写入把扫描越推越深。
    index("run_events_by_run").on(t.runId, t.id),
  ],
);

/**
 * 逐 step 的用量明细，由 dsh usage chunk 到达时实时捕获落库。
 * 必须自己存：运行子进程收束后不再提供查询面——运行列表的用量汇总只读本表。
 */
export const nodeUsage = sqliteTable(
  "node_usage",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    sessionId: text("session_id").notNull(),
    messageId: text("message_id").notNull(),
    providerId: text("provider_id").notNull().default(""),
    modelId: text("model_id").notNull().default(""),
    variant: text("variant"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    /** 人民币；按该条 usage 到达时刻的官方峰谷单价计算（src/server/pricing.ts）。 */
    cost: real("cost").notNull().default(0),
    finish: text("finish"),
    ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    // 唯一键必须带 runId：会话 id 取的是画布节点 id、messageId 每会话从头计数，
    // 同一工作流并行或先后运行会撞出相同 (sessionId, messageId)，缺 runId 时
    // 后到运行的整份用量明细被 onConflictDoNothing 静默丢弃，成本统计系统性少记
    //（实测同一工作流第三次运行 node_usage 一行都没落）。
    // runId 前缀同时服务按运行的查询，原 node_usage_by_run 并入此索引。
    uniqueIndex("node_usage_message").on(t.runId, t.sessionId, t.messageId),
  ],
);
