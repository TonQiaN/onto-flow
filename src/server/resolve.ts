import { asc, eq, inArray } from "drizzle-orm";
import {
  actionPorts,
  actions,
  db,
  objectTypes,
  workflowEdges,
  workflowNodes,
  workflows,
} from "@/db";
import type { GraphEdge, ResolvedNode, ResolvedPort } from "@/lib/graph";

export interface ResolvedWorkflow {
  workflow: typeof workflows.$inferSelect;
  nodes: ResolvedNode[];
  edges: GraphEdge[];
  /** nodeId → 原始行，引擎需要 kind/actionId/objectTypeId */
  nodeRows: Map<string, typeof workflowNodes.$inferSelect>;
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

  const actionIds = nodeRows
    .filter((n) => n.kind === "action" && n.actionId)
    .map((n) => n.actionId!);
  const actionRows = actionIds.length
    ? db.select().from(actions).where(inArray(actions.id, actionIds)).all()
    : [];
  const actionById = new Map(actionRows.map((a) => [a.id, a]));
  const portRows = actionIds.length
    ? db
        .select()
        .from(actionPorts)
        .where(inArray(actionPorts.actionId, actionIds))
        .orderBy(asc(actionPorts.position))
        .all()
    : [];

  const toResolvedPort = (row: {
    name: string;
    objectTypeId: string;
  }): ResolvedPort => {
    const type = types.get(row.objectTypeId);
    return {
      name: row.name,
      objectTypeId: row.objectTypeId,
      objectTypeName: type?.name ?? "未知类型",
      kind: type?.kind ?? "text",
    };
  };

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
  };
}
