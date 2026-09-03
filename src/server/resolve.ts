import { asc, eq, inArray } from "drizzle-orm";
import {
  actionPorts,
  actionPreloads,
  actionTools,
  actions,
  db,
  models,
  objectTypes,
  skills,
  tools,
  workflowEdges,
  workflowNodes,
  workflowSkills,
  workflowTools,
  workflows,
} from "@/db";
import type { GraphEdge, ResolvedNode, ResolvedPort, ValidationIssue } from "@/lib/graph";
import {
  COMPOSITION_TOGGLE_KEYS,
  type CompositionToggles,
  type WorkflowSettings,
} from "@/lib/workflow-settings";
import { skillSlug } from "@/server/skill-library";

export interface ResolvedActionPort {
  name: string;
  objectTypeId: string;
  objectTypeName: string;
  kind: "text" | "file" | "json";
  artifactPath: string | null;
  exitName: string | null;
}

/** 技能只冻结身份：id、当时的名字与派生 slug；正文按活链接契约在会话启动前从工作区读。 */
export interface ResolvedSkillRef {
  id: string;
  name: string;
  /** 工作区 .agents/skills/ 下的目录名，也是预载手势 `/<slug>` 用的名字 */
  slug: string;
}

/** Action 从运行受理到全部节点收束都使用这一份定义，不再逐节点回读共享库。 */
export interface ResolvedActionDefinition {
  action: typeof actions.$inferSelect;
  model: typeof models.$inferSelect;
  ports: { inputs: ResolvedActionPort[]; outputs: ResolvedActionPort[] };
  /**
   * 预载的技能（ADR-0016）：会话开始时以 `/<slug>` 手势注入，只能来自所在工作流的
   * 技能集——受理时校验 ⊆，违反即 422。
   */
  preloads: ResolvedSkillRef[];
}

export interface ResolvedCapabilities {
  /** 工作流技能集全量：symlink 进工作区、对全部 Action 可见。 */
  skills: ResolvedSkillRef[];
  /** 工作流 Tool 集全量行：声明即物化，每个 Action 会话再收窄。 */
  tools: Array<typeof tools.$inferSelect>;
  /** Action id → 该 Action 可见的 Tool 公名（action_tools ⊆ 工作流 Tool 集）。 */
  toolNamesByActionId: ReadonlyMap<string, readonly string[]>;
}

export interface ResolvedWorkflow {
  workflow: typeof workflows.$inferSelect;
  /** 工作流设置：只含五个开关键的覆盖与 MCP 子集名，受理时冻结（ADR-0016）。 */
  settings: WorkflowSettings;
  nodes: ResolvedNode[];
  edges: GraphEdge[];
  /** nodeId → 原始行，引擎需要 kind/actionId/objectTypeId */
  nodeRows: Map<string, typeof workflowNodes.$inferSelect>;
  /** 端口引用的对象类型行；业务预检不得在 resolve 后重新读一版 Schema。 */
  objectTypes: ReadonlyMap<string, typeof objectTypes.$inferSelect>;
  /** Action、模型、端口与预载关系在 resolve 时一次冻结。 */
  actionDefinitions: ReadonlyMap<string, ResolvedActionDefinition>;
  /** 工作流技能集、Tool 集与 Action→Tool 可见关系在 resolve 时冻结；执行器直接物化这里的行。 */
  capabilities: ResolvedCapabilities;
  /** collect 模式下收集的 ⊆ 违反；throw 模式下恒为空（违反即已抛出）。 */
  subsetIssues: ValidationIssue[];
}

/**
 * 受理期的工作流校验失败：Action 的预载或可见 Tool 越出了所在工作流的集合。
 * 与 startRun 的 422 结果同一形状，运行入口据此直接回给调用方。
 */
export class WorkflowResolveError extends Error {
  readonly status = 422 as const;
  constructor(
    message: string,
    readonly issues: ValidationIssue[],
  ) {
    super(message);
    this.name = "WorkflowResolveError";
  }
}

/** 库里的 settings 列宽松存放；受理时只认五个开关键的布尔值与字符串形的服务器名。 */
function normalizeWorkflowSettings(raw: unknown): WorkflowSettings {
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rawToggles =
    body.toggles && typeof body.toggles === "object"
      ? (body.toggles as Record<string, unknown>)
      : {};
  const toggles: Partial<CompositionToggles> = {};
  for (const key of COMPOSITION_TOGGLE_KEYS) {
    if (typeof rawToggles[key] === "boolean") toggles[key] = rawToggles[key] as boolean;
  }
  const mcpServers = Array.isArray(body.mcpServers)
    ? body.mcpServers.filter((name): name is string => typeof name === "string")
    : [];
  return { toggles, mcpServers };
}

/**
 * 把 workflow 的持久化图解析为带端口类型的 ResolvedNode 图。
 * input/output 内置节点的唯一端口名固定为 "value"。
 */
export interface ResolveWorkflowOptions {
  /**
   * 「Action 预载 ⊄ 技能集 / 可见 Tool ⊄ Tool 集」的处理：受理走 throw（422），
   * 编辑面走 collect——问题放进 subsetIssues 带回页面让人去设置页修。
   */
  subsetViolations?: "throw" | "collect";
}

export async function resolveWorkflow(
  workflowId: string,
  options: ResolveWorkflowOptions = {},
): Promise<ResolvedWorkflow | null> {
  const workflow = db.select().from(workflows).where(eq(workflows.id, workflowId)).get();
  if (!workflow) return null;

  const nodeRows = db
    .select()
    .from(workflowNodes)
    .where(eq(workflowNodes.workflowId, workflowId))
    .all();
  const edgeRows = db
    .select()
    .from(workflowEdges)
    .where(eq(workflowEdges.workflowId, workflowId))
    .all();
  const types = new Map(
    db
      .select()
      .from(objectTypes)
      .all()
      .map((t) => [t.id, t]),
  );

  const actionIds = [
    ...new Set(nodeRows.filter((n) => n.kind === "action" && n.actionId).map((n) => n.actionId!)),
  ];
  const actionRows = actionIds.length
    ? db.select().from(actions).where(inArray(actions.id, actionIds)).all()
    : [];
  const actionById = new Map(actionRows.map((a) => [a.id, a]));
  const modelIds = [...new Set(actionRows.map((action) => action.modelId))];
  const modelRows = modelIds.length
    ? db.select().from(models).where(inArray(models.id, modelIds)).all()
    : [];
  const modelById = new Map(modelRows.map((model) => [model.id, model]));
  const portRows = actionIds.length
    ? db
        .select()
        .from(actionPorts)
        .where(inArray(actionPorts.actionId, actionIds))
        .orderBy(asc(actionPorts.position))
        .all()
    : [];

  // 工作流技能集与 Tool 集是引用的唯一来源；Action 的预载与可见 Tool 只在其中选择。
  const workflowSkillRows = db
    .select()
    .from(workflowSkills)
    .where(eq(workflowSkills.workflowId, workflowId))
    .orderBy(asc(workflowSkills.position))
    .all();
  const skillIds = workflowSkillRows.map((relation) => relation.skillId);
  const skillRows = skillIds.length
    ? db.select().from(skills).where(inArray(skills.id, skillIds)).all()
    : [];
  const skillById = new Map(skillRows.map((skill) => [skill.id, skill]));
  const skillRefs: ResolvedSkillRef[] = skillIds.flatMap((id) => {
    const skill = skillById.get(id);
    return skill ? [{ id: skill.id, name: skill.name, slug: skillSlug(skill) }] : [];
  });
  const skillRefById = new Map(skillRefs.map((ref) => [ref.id, ref]));

  const workflowToolRows = db
    .select()
    .from(workflowTools)
    .where(eq(workflowTools.workflowId, workflowId))
    .orderBy(asc(workflowTools.position))
    .all();
  const toolIds = workflowToolRows.map((relation) => relation.toolId);
  const toolRowsUnordered = toolIds.length
    ? db.select().from(tools).where(inArray(tools.id, toolIds)).all()
    : [];
  const toolById = new Map(toolRowsUnordered.map((tool) => [tool.id, tool]));
  const toolRows = toolIds.flatMap((id) => {
    const tool = toolById.get(id);
    return tool ? [tool] : [];
  });

  const preloadRows = actionIds.length
    ? db
        .select()
        .from(actionPreloads)
        .where(inArray(actionPreloads.actionId, actionIds))
        .orderBy(asc(actionPreloads.position))
        .all()
    : [];
  const actionToolRows = actionIds.length
    ? db.select().from(actionTools).where(inArray(actionTools.actionId, actionIds)).all()
    : [];
  // 越界的预载 / 可见 Tool 只能报名字：它们不在工作流集合里，但仍是库里的实体。
  const outsidePreloadSkillIds = [
    ...new Set(
      preloadRows.map((relation) => relation.skillId).filter((id) => !skillRefById.has(id)),
    ),
  ];
  const outsideToolIds = [
    ...new Set(actionToolRows.map((relation) => relation.toolId).filter((id) => !toolById.has(id))),
  ];
  const outsideSkillNames = new Map(
    (outsidePreloadSkillIds.length
      ? db
          .select({ id: skills.id, name: skills.name })
          .from(skills)
          .where(inArray(skills.id, outsidePreloadSkillIds))
          .all()
      : []
    ).map((row) => [row.id, row.name]),
  );
  const outsideToolNames = new Map(
    (outsideToolIds.length
      ? db
          .select({ id: tools.id, name: tools.name })
          .from(tools)
          .where(inArray(tools.id, outsideToolIds))
          .all()
      : []
    ).map((row) => [row.id, row.name]),
  );

  const issues: ValidationIssue[] = [];
  for (const action of actionRows) {
    for (const relation of preloadRows) {
      if (relation.actionId !== action.id || skillRefById.has(relation.skillId)) continue;
      issues.push({
        message:
          `Action「${action.name}」预载的技能「${outsideSkillNames.get(relation.skillId) ?? relation.skillId}」` +
          "不在本工作流的技能集里",
      });
    }
    for (const relation of actionToolRows) {
      if (relation.actionId !== action.id || toolById.has(relation.toolId)) continue;
      issues.push({
        message:
          `Action「${action.name}」可见的 Tool「${outsideToolNames.get(relation.toolId) ?? relation.toolId}」` +
          "不在本工作流的 Tool 集里",
      });
    }
  }
  // 受理默认抛 422；编辑面（工作流 GET/PUT）要的是把问题带回页面让人去设置页修，
  // 而不是 500——否则从 Action 库页改预载越界后，设置页与画布都打不开，无人能修复。
  if (issues.length > 0 && options.subsetViolations !== "collect") {
    throw new WorkflowResolveError("工作流校验未通过", issues);
  }

  const toResolvedPort = (row: {
    name: string;
    objectTypeId: string;
    artifactPath?: string | null;
    exitName?: string | null;
  }): ResolvedPort => {
    const type = types.get(row.objectTypeId);
    return {
      name: row.name,
      objectTypeId: row.objectTypeId,
      objectTypeName: type?.name ?? "未知类型",
      kind: type?.kind ?? "text",
      artifactPath: row.artifactPath ?? null,
      exitName: row.exitName ?? null,
    };
  };

  const actionPort = (row: (typeof portRows)[number]): ResolvedActionPort => {
    const resolved = toResolvedPort(row);
    return {
      name: resolved.name,
      objectTypeId: resolved.objectTypeId,
      objectTypeName: resolved.objectTypeName,
      kind: resolved.kind,
      artifactPath: resolved.artifactPath ?? null,
      exitName: resolved.exitName ?? null,
    };
  };

  const actionDefinitions = new Map<string, ResolvedActionDefinition>();
  for (const action of actionRows) {
    const model = modelById.get(action.modelId);
    if (!model) continue;
    const ports = portRows.filter((port) => port.actionId === action.id);
    actionDefinitions.set(action.id, {
      action,
      model,
      ports: {
        inputs: ports.filter((port) => port.direction === "input").map(actionPort),
        outputs: ports.filter((port) => port.direction === "output").map(actionPort),
      },
      preloads: preloadRows.flatMap((relation) => {
        if (relation.actionId !== action.id) return [];
        const ref = skillRefById.get(relation.skillId);
        return ref ? [ref] : [];
      }),
    });
  }

  const nodes: ResolvedNode[] = nodeRows.map((row) => {
    if (row.kind === "action") {
      const action = row.actionId ? actionById.get(row.actionId) : undefined;
      const ports = portRows.filter((p) => p.actionId === row.actionId);
      return {
        id: row.id,
        kind: "action",
        label: action?.name ?? row.label ?? "（Action 已删除）",
        inputs: ports.filter((p) => p.direction === "input").map(toResolvedPort),
        outputs: ports.filter((p) => p.direction === "output").map(toResolvedPort),
        maxReentries: action?.maxReentries ?? 0,
        onExhausted: action?.onExhausted ?? "fail",
      };
    }
    const type = row.objectTypeId ? types.get(row.objectTypeId) : undefined;
    const port: ResolvedPort = {
      name: "value",
      objectTypeId: row.objectTypeId ?? "",
      objectTypeName: type?.name ?? "未知类型",
      kind: type?.kind ?? "text",
    };
    const label =
      row.label ||
      (row.kind === "input" ? `输入·${port.objectTypeName}` : `输出·${port.objectTypeName}`);
    return row.kind === "input"
      ? { id: row.id, kind: "input", label, inputs: [], outputs: [port] }
      : { id: row.id, kind: "output", label, inputs: [port], outputs: [] };
  });

  return {
    workflow,
    settings: normalizeWorkflowSettings(workflow.settings),
    subsetIssues: issues,
    nodes,
    edges: edgeRows.map((e) => ({
      id: e.id,
      sourceNodeId: e.sourceNodeId,
      sourcePort: e.sourcePort,
      targetNodeId: e.targetNodeId,
      targetPort: e.targetPort,
    })),
    nodeRows: new Map(nodeRows.map((n) => [n.id, n])),
    objectTypes: types,
    actionDefinitions,
    capabilities: {
      skills: skillRefs,
      tools: toolRows,
      toolNamesByActionId: new Map(
        actionIds.map((actionId) => [
          actionId,
          actionToolRows.flatMap((relation) => {
            if (relation.actionId !== actionId) return [];
            const tool = toolById.get(relation.toolId);
            return tool ? [tool.publicName] : [];
          }),
        ]),
      ),
    },
  };
}
