import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

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

/** 五个库共用的实体种类（标签、修订、引用查询都按它区分） */
export const ENTITY_KINDS = [
  "workflow",
  "action",
  "skill",
  "tool",
  "object_type",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * 标签：跨全部库的分类维度，多归属（ADR-0003）。
 * name 可用 `/` 表达层级（`采购/集采`），UI 按层级渲染成可折叠树。
 */
export const tags = sqliteTable("tags", {
  id: id(),
  name: text("name").notNull().unique(),
  /** 树上的色点，留空则按名字哈希取色 */
  color: text("color"),
  ...timestamps,
});

export const entityTags = sqliteTable(
  "entity_tags",
  {
    entityKind: text("entity_kind", { enum: ENTITY_KINDS }).notNull(),
    entityId: text("entity_id").notNull(),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.entityKind, t.entityId, t.tagId] }),
    index("entity_tags_by_tag").on(t.tagId),
  ],
);

/**
 * 修订：实体每次保存留存的完整定义快照，可查看/对比/回滚。
 * payload 是该实体的完整定义（含关联：端口、skillIds、toolIds、图的 nodes/edges）。
 */
export const revisions = sqliteTable(
  "revisions",
  {
    id: id(),
    entityKind: text("entity_kind", { enum: ENTITY_KINDS }).notNull(),
    entityId: text("entity_id").notNull(),
    versionNo: integer("version_no").notNull(),
    payload: text("payload", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    note: text("note").notNull().default(""),
    /** 手动标记保留的版本，清理时跳过 */
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("revisions_entity_version").on(
      t.entityKind,
      t.entityId,
      t.versionNo,
    ),
  ],
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
  /** markdown 全文，被引用时强制注入会话上下文 */
  content: text("content").notNull(),
  ...timestamps,
});

export const tools = sqliteTable("tools", {
  id: id(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  /** 完整的 opencode custom tool TS 源码，运行时物化为 .opencode/tools/<name>.ts */
  code: text("code").notNull(),
  ...timestamps,
});

/** 可选模型白名单（种子数据只有 deepseek-v4-flash 与 gpt-5.6-luna） */
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
  reasoningEffort: text("reasoning_effort", {
    enum: ["low", "medium", "high", "max"],
  })
    .notNull()
    .default("max"),
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
  },
  (t) => [
    uniqueIndex("action_ports_unique").on(t.actionId, t.direction, t.name),
  ],
);

export const actionSkills = sqliteTable(
  "action_skills",
  {
    actionId: text("action_id")
      .notNull()
      .references(() => actions.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.actionId, t.skillId] })],
);

export const actionTools = sqliteTable(
  "action_tools",
  {
    actionId: text("action_id")
      .notNull()
      .references(() => actions.id, { onDelete: "cascade" }),
    toolId: text("tool_id")
      .notNull()
      .references(() => tools.id),
  },
  (t) => [primaryKey({ columns: [t.actionId, t.toolId] })],
);

export const workflows = sqliteTable("workflows", {
  id: id(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  ...timestamps,
});

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
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
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
    /**
     * 运行快照：该节点本次执行实际使用的完整配置（prompt、rule、各 Skill 与 Tool
     * 全文、模型、思考强度、端口定义）。不随实体后续修改而改变。
     */
    snapshot: text("snapshot", { mode: "json" }).$type<Record<
      string,
      unknown
    > | null>(),
    /** 会话级用量汇总（由 message.updated 事件累加，来源见 node_usage） */
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    cost: real("cost").notNull().default(0),
    /** PortValue 映射的 JSON：{ [portName]: PortValue } */
    inputs: text("inputs", { mode: "json" }).$type<Record<string, unknown>>(),
    outputs: text("outputs", { mode: "json" }).$type<Record<string, unknown>>(),
    sessionId: text("session_id"),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("run_nodes_unique").on(t.runId, t.nodeId)],
);

export const runEvents = sqliteTable("run_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  nodeId: text("node_id"),
  ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
  type: text("type").notNull(),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
});

/**
 * 逐条 assistant 消息的用量明细，由 message.updated 事件实时捕获落库。
 * 必须自己存：opencode 1.18.16 对用过结构化输出的会话调 session.messages 会 400，
 * 且 opencode 重启后历史会话不可查——监控页的成本分析只读本表。
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
    cost: real("cost").notNull().default(0),
    finish: text("finish"),
    ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("node_usage_message").on(t.sessionId, t.messageId),
    index("node_usage_by_run").on(t.runId),
  ],
);

/** 首个案例的业务表：集采计划归档（由 save_purchase_plan tool 经 bun:sqlite 写入） */
export const purchasePlans = sqliteTable("purchase_plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** 集采计划编号（如 CPP-2027-001；正文未提供时由归档 Action 生成并注明） */
  planNo: text("plan_no").notNull().unique(),
  planTitle: text("plan_title").notNull(),
  /** 集采分类（一级集采/二三级集采/自定义集采；依据不明时含「待确认」原文） */
  planType: text("plan_type"),
  planYear: text("plan_year"),
  /** 涉及需求部门/单位清单，逗号分隔 */
  orgUnits: text("org_units"),
  categorySummary: text("category_summary"),
  itemCount: integer("item_count"),
  /** 预算总额（元），口径见 budgetNote */
  totalBudget: real("total_budget"),
  budgetNote: text("budget_note"),
  scheduleSummary: text("schedule_summary"),
  /** 审核总结论（通过/有保留通过/退回） */
  reviewConclusion: text("review_conclusion"),
  /** 审核评价 JSON 全文 */
  reviewFeedback: text("review_feedback"),
  planContent: text("plan_content").notNull(),
  pendingIssues: text("pending_issues"),
  backupPath: text("backup_path"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});
