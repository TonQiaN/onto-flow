import { asc, eq, inArray } from "drizzle-orm";
import {
  actionPorts,
  actionSkills,
  actionTools,
  actions,
  db,
  models,
  objectTypes,
  skills,
  tools,
  workflowEdges,
  workflowNodes,
  workflows,
} from "@/db";
import type { GraphEdge, ResolvedNode, ResolvedPort } from "@/lib/graph";

export interface ResolvedActionPort {
  name: string;
  objectTypeId: string;
  objectTypeName: string;
  kind: "text" | "file" | "json";
  artifactPath: string | null;
  exitName: string | null;
}

/** Action 从运行受理到全部节点收束都使用这一份定义，不再逐节点回读共享库。 */
export interface ResolvedActionDefinition {
  action: typeof actions.$inferSelect;
  model: typeof models.$inferSelect;
  ports: { inputs: ResolvedActionPort[]; outputs: ResolvedActionPort[] };
  skills: Array<typeof skills.$inferSelect>;
}

export interface ResolvedCapabilities {
  skills: Array<typeof skills.$inferSelect>;
  tools: Array<typeof tools.$inferSelect>;
  toolNamesByActionId: ReadonlyMap<string, readonly string[]>;
}

export interface ResolvedWorkflow {
  workflow: typeof workflows.$inferSelect;
  nodes: ResolvedNode[];
  edges: GraphEdge[];
  /** nodeId → 原始行，引擎需要 kind/actionId/objectTypeId */
  nodeRows: Map<string, typeof workflowNodes.$inferSelect>;
  /** 端口引用的对象类型行；业务预检不得在 resolve 后重新读一版 Schema。 */
  objectTypes: ReadonlyMap<string, typeof objectTypes.$inferSelect>;
  /** Action、模型、端口与 Skill 引用在 resolve 时一次冻结。 */
  actionDefinitions: ReadonlyMap<string, ResolvedActionDefinition>;
  /** Tool 源码与 Action→Tool 归属在 resolve 时冻结；执行器直接物化这里的行。 */
  capabilities: ResolvedCapabilities;
}

/**
 * 把 workflow 的持久化图解析为带端口类型的 ResolvedNode 图。
 * input/output 内置节点的唯一端口名固定为 "value"。
 */
export async function resolveWorkflow(
  workflowId: string,
): Promise<ResolvedWorkflow | null> {
  const workflow = db
    .select()
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .get();
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
    ...new Set(
      nodeRows
        .filter((n) => n.kind === "action" && n.actionId)
        .map((n) => n.actionId!),
    ),
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

  const actionSkillRows = actionIds.length
    ? db
        .select()
        .from(actionSkills)
        .where(inArray(actionSkills.actionId, actionIds))
        .orderBy(asc(actionSkills.position))
        .all()
    : [];
  const skillIds = [...new Set(actionSkillRows.map((relation) => relation.skillId))];
  const skillRows = skillIds.length
    ? db.select().from(skills).where(inArray(skills.id, skillIds)).all()
    : [];
  const skillById = new Map(skillRows.map((skill) => [skill.id, skill]));

  const actionToolRows = actionIds.length
    ? db
        .select()
        .from(actionTools)
        .where(inArray(actionTools.actionId, actionIds))
        .all()
    : [];
  const toolIds = [...new Set(actionToolRows.map((relation) => relation.toolId))];
  const toolRows = toolIds.length
    ? db.select().from(tools).where(inArray(tools.id, toolIds)).all()
    : [];
  const toolById = new Map(toolRows.map((tool) => [tool.id, tool]));

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
      skills: actionSkillRows.flatMap((relation) => {
        if (relation.actionId !== action.id) return [];
        const skill = skillById.get(relation.skillId);
        return skill ? [skill] : [];
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
        outputs: ports
          .filter((p) => p.direction === "output")
          .map(toResolvedPort),
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
      row.label || (row.kind === "input" ? `输入·${port.objectTypeName}` : `输出·${port.objectTypeName}`);
    return row.kind === "input"
      ? { id: row.id, kind: "input", label, inputs: [], outputs: [port] }
      : { id: row.id, kind: "output", label, inputs: [port], outputs: [] };
  });

  return {
    workflow,
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
      skills: skillRows,
      tools: toolRows,
      toolNamesByActionId: new Map(
        actionIds.map((actionId) => [
          actionId,
          actionToolRows.flatMap((relation) => {
            if (relation.actionId !== actionId) return [];
            const tool = toolById.get(relation.toolId);
            return tool ? [tool.name] : [];
          }),
        ]),
      ),
    },
  };
}
