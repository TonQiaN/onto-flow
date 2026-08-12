import { eq, inArray } from "drizzle-orm";
import {
  actions,
  db,
  objectTypes,
  workflowEdges,
  workflowNodes,
  workflows,
} from "@/db";
import { recordRevision } from "@/server/revisions";
import { asObject, type WriteResult, writeFail, writeOk } from "./types";

export interface NodePayload {
  id: string;
  kind: "action" | "input" | "output";
  actionId: string | null;
  objectTypeId: string | null;
  label: string;
  x: number;
  y: number;
}

export interface EdgePayload {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
}

export type WorkflowRow = typeof workflows.$inferSelect;

function parseGraphPayload(
  body: Record<string, unknown>,
): WriteResult<{ nodes: NodePayload[]; edges: EdgePayload[] }> {
  if (!Array.isArray(body.nodes)) return writeFail(400, "nodes 必须是数组");
  if (!Array.isArray(body.edges)) return writeFail(400, "edges 必须是数组");

  const nodes: NodePayload[] = [];
  const nodeIds = new Set<string>();
  for (const item of body.nodes as unknown[]) {
    if (typeof item !== "object" || item === null)
      return writeFail(400, "节点格式不正确");
    const n = item as Record<string, unknown>;
    const nodeId = typeof n.id === "string" ? n.id : "";
    if (!nodeId) return writeFail(400, "节点缺少 id");
    if (nodeIds.has(nodeId)) return writeFail(400, `节点 id 重复：${nodeId}`);
    nodeIds.add(nodeId);
    const kind = n.kind;
    if (kind !== "action" && kind !== "input" && kind !== "output")
      return writeFail(400, "节点 kind 必须是 action/input/output 之一");
    const label = typeof n.label === "string" ? n.label : "";
    const x = typeof n.x === "number" ? n.x : 0;
    const y = typeof n.y === "number" ? n.y : 0;
    if (kind === "action") {
      const actionId = typeof n.actionId === "string" ? n.actionId : "";
      if (!actionId)
        return writeFail(400, `Action 节点「${label || nodeId}」缺少 actionId`);
      nodes.push({
        id: nodeId,
        kind,
        actionId,
        objectTypeId: null,
        label,
        x,
        y,
      });
    } else {
      const objectTypeId =
        typeof n.objectTypeId === "string" ? n.objectTypeId : "";
      if (!objectTypeId)
        return writeFail(
          400,
          `输入/输出节点「${label || nodeId}」缺少 objectTypeId`,
        );
      nodes.push({
        id: nodeId,
        kind,
        actionId: null,
        objectTypeId,
        label,
        x,
        y,
      });
    }
  }

  const actionIds = [
    ...new Set(nodes.flatMap((n) => (n.actionId !== null ? [n.actionId] : []))),
  ];
  if (actionIds.length > 0) {
    const found = new Set(
      db
        .select({ id: actions.id })
        .from(actions)
        .where(inArray(actions.id, actionIds))
        .all()
        .map((r) => r.id),
    );
    if (actionIds.some((a) => !found.has(a)))
      return writeFail(400, "节点引用的 Action 不存在");
  }
  const typeIds = [
    ...new Set(
      nodes.flatMap((n) => (n.objectTypeId !== null ? [n.objectTypeId] : [])),
    ),
  ];
  if (typeIds.length > 0) {
    const found = new Set(
      db
        .select({ id: objectTypes.id })
        .from(objectTypes)
        .where(inArray(objectTypes.id, typeIds))
        .all()
        .map((r) => r.id),
    );
    if (typeIds.some((t) => !found.has(t)))
      return writeFail(400, "节点引用的对象类型不存在");
  }

  const edges: EdgePayload[] = [];
  const edgeIds = new Set<string>();
  for (const item of body.edges as unknown[]) {
    if (typeof item !== "object" || item === null)
      return writeFail(400, "连线格式不正确");
    const e = item as Record<string, unknown>;
    const edgeId =
      typeof e.id === "string" && e.id !== "" ? e.id : crypto.randomUUID();
    if (edgeIds.has(edgeId)) return writeFail(400, `连线 id 重复：${edgeId}`);
    edgeIds.add(edgeId);
    const sourceNodeId =
      typeof e.sourceNodeId === "string" ? e.sourceNodeId : "";
    const targetNodeId =
      typeof e.targetNodeId === "string" ? e.targetNodeId : "";
    if (!nodeIds.has(sourceNodeId))
      return writeFail(400, "连线的 sourceNodeId 不在本次提交的节点中");
    if (!nodeIds.has(targetNodeId))
      return writeFail(400, "连线的 targetNodeId 不在本次提交的节点中");
    const sourcePort = typeof e.sourcePort === "string" ? e.sourcePort : "";
    const targetPort = typeof e.targetPort === "string" ? e.targetPort : "";
    if (!sourcePort || !targetPort) return writeFail(400, "连线缺少端口名");
    edges.push({
      id: edgeId,
      sourceNodeId,
      sourcePort,
      targetNodeId,
      targetPort,
    });
  }

  return writeOk({ nodes, edges });
}

/** 修订 payload：Workflow 的完整定义（含 nodes/edges） */
function revisionPayload(
  name: string,
  description: string,
  nodes: NodePayload[],
  edges: EdgePayload[],
): Record<string, unknown> {
  return { name, description, nodes, edges };
}

export function createWorkflow(raw: unknown): WriteResult<WorkflowRow> {
  const parsed = asObject(raw);
  if (!parsed.ok) return writeFail(400, "请求体必须是 JSON 对象");
  const body = parsed.body;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return writeFail(400, "名称不能为空");
  const description =
    typeof body.description === "string" ? body.description : "";

  const row = db.transaction((tx) => {
    const inserted = tx
      .insert(workflows)
      .values({ name, description })
      .returning()
      .get();
    recordRevision(
      "workflow",
      inserted.id,
      revisionPayload(name, description, [], []),
      "",
      tx,
    );
    return inserted;
  });
  return writeOk(row);
}

/**
 * PUT 与回滚共用的写入路径：整图（nodes+edges）整体替换，
 * 节点 id 由调用方给定以保持连线引用。
 */
export function writeWorkflow(
  id: string,
  raw: unknown,
): WriteResult<WorkflowRow> {
  const existing = db.select().from(workflows).where(eq(workflows.id, id)).get();
  if (!existing) return writeFail(404, "工作流不存在");

  const parsed = asObject(raw);
  if (!parsed.ok) return writeFail(400, "请求体必须是 JSON 对象");
  const body = parsed.body;

  let name: string | undefined;
  if (body.name !== undefined) {
    name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return writeFail(400, "名称不能为空");
  }
  let description: string | undefined;
  if (body.description !== undefined) {
    if (typeof body.description !== "string")
      return writeFail(400, "description 必须是字符串");
    description = body.description;
  }

  const graph = parseGraphPayload(body);
  if (!graph.ok) return graph;
  const { nodes, edges } = graph.data;

  const row = db.transaction((tx) => {
    const updated = tx
      .update(workflows)
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        updatedAt: new Date(),
      })
      .where(eq(workflows.id, id))
      .returning()
      .get();
    tx.delete(workflowEdges).where(eq(workflowEdges.workflowId, id)).run();
    tx.delete(workflowNodes).where(eq(workflowNodes.workflowId, id)).run();
    if (nodes.length > 0)
      tx.insert(workflowNodes)
        .values(nodes.map((n) => ({ ...n, workflowId: id })))
        .run();
    if (edges.length > 0)
      tx.insert(workflowEdges)
        .values(edges.map((e) => ({ ...e, workflowId: id })))
        .run();
    recordRevision(
      "workflow",
      id,
      revisionPayload(updated.name, updated.description, nodes, edges),
      "",
      tx,
    );
    return updated;
  });

  return writeOk(row);
}
