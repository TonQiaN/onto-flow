import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import {
  actions,
  db,
  objectTypes,
  workflowEdges,
  workflowNodes,
  workflows,
} from "@/db";
import { validateGraph } from "@/lib/graph";
import { handle, jsonError } from "@/lib/http";
import { resolveWorkflow } from "@/server/resolve";

export const dynamic = "force-dynamic";

interface NodePayload {
  id: string;
  kind: "action" | "input" | "output";
  actionId: string | null;
  objectTypeId: string | null;
  label: string;
  x: number;
  y: number;
}

interface EdgePayload {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
}

/** GET/PUT 共用的响应：workflow 摘要 + NodeDto/EdgeDto + 校验 issues */
async function workflowResponse(id: string) {
  const resolved = await resolveWorkflow(id);
  if (!resolved) return jsonError(404, "工作流不存在");
  const issues = validateGraph(resolved.nodes, resolved.edges);
  const nodes = [...resolved.nodeRows.values()].map((n) => ({
    id: n.id,
    kind: n.kind,
    actionId: n.actionId,
    objectTypeId: n.objectTypeId,
    label: n.label,
    x: n.x,
    y: n.y,
  }));
  return NextResponse.json({
    workflow: {
      id: resolved.workflow.id,
      name: resolved.workflow.name,
      description: resolved.workflow.description,
    },
    nodes,
    edges: resolved.edges,
    issues,
  });
}

function parseGraphPayload(
  body: Record<string, unknown>,
): { nodes: NodePayload[]; edges: EdgePayload[] } | { error: NextResponse } {
  const fail = (msg: string) => ({ error: jsonError(400, msg) });
  if (!Array.isArray(body.nodes)) return fail("nodes 必须是数组");
  if (!Array.isArray(body.edges)) return fail("edges 必须是数组");

  const nodes: NodePayload[] = [];
  const nodeIds = new Set<string>();
  for (const item of body.nodes as unknown[]) {
    if (typeof item !== "object" || item === null)
      return fail("节点格式不正确");
    const n = item as Record<string, unknown>;
    const nodeId = typeof n.id === "string" ? n.id : "";
    if (!nodeId) return fail("节点缺少 id");
    if (nodeIds.has(nodeId)) return fail(`节点 id 重复：${nodeId}`);
    nodeIds.add(nodeId);
    const kind = n.kind;
    if (kind !== "action" && kind !== "input" && kind !== "output")
      return fail("节点 kind 必须是 action/input/output 之一");
    const label = typeof n.label === "string" ? n.label : "";
    const x = typeof n.x === "number" ? n.x : 0;
    const y = typeof n.y === "number" ? n.y : 0;
    if (kind === "action") {
      const actionId = typeof n.actionId === "string" ? n.actionId : "";
      if (!actionId)
        return fail(`Action 节点「${label || nodeId}」缺少 actionId`);
      nodes.push({ id: nodeId, kind, actionId, objectTypeId: null, label, x, y });
    } else {
      const objectTypeId =
        typeof n.objectTypeId === "string" ? n.objectTypeId : "";
      if (!objectTypeId)
        return fail(`输入/输出节点「${label || nodeId}」缺少 objectTypeId`);
      nodes.push({ id: nodeId, kind, actionId: null, objectTypeId, label, x, y });
    }
  }

  const actionIds = [
    ...new Set(
      nodes.flatMap((n) => (n.actionId !== null ? [n.actionId] : [])),
    ),
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
      return fail("节点引用的 Action 不存在");
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
      return fail("节点引用的对象类型不存在");
  }

  const edges: EdgePayload[] = [];
  const edgeIds = new Set<string>();
  for (const item of body.edges as unknown[]) {
    if (typeof item !== "object" || item === null)
      return fail("连线格式不正确");
    const e = item as Record<string, unknown>;
    const edgeId =
      typeof e.id === "string" && e.id !== "" ? e.id : crypto.randomUUID();
    if (edgeIds.has(edgeId)) return fail(`连线 id 重复：${edgeId}`);
    edgeIds.add(edgeId);
    const sourceNodeId =
      typeof e.sourceNodeId === "string" ? e.sourceNodeId : "";
    const targetNodeId =
      typeof e.targetNodeId === "string" ? e.targetNodeId : "";
    if (!nodeIds.has(sourceNodeId))
      return fail("连线的 sourceNodeId 不在本次提交的节点中");
    if (!nodeIds.has(targetNodeId))
      return fail("连线的 targetNodeId 不在本次提交的节点中");
    const sourcePort = typeof e.sourcePort === "string" ? e.sourcePort : "";
    const targetPort = typeof e.targetPort === "string" ? e.targetPort : "";
    if (!sourcePort || !targetPort) return fail("连线缺少端口名");
    edges.push({ id: edgeId, sourceNodeId, sourcePort, targetNodeId, targetPort });
  }

  return { nodes, edges };
}

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => workflowResponse((await params).id));
}

export async function PUT(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const existing = db
      .select()
      .from(workflows)
      .where(eq(workflows.id, id))
      .get();
    if (!existing) return jsonError(404, "工作流不存在");

    const raw = await request.json();
    if (typeof raw !== "object" || raw === null)
      return jsonError(400, "请求体必须是 JSON 对象");
    const body = raw as Record<string, unknown>;

    let name: string | undefined;
    if (body.name !== undefined) {
      name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return jsonError(400, "名称不能为空");
    }
    let description: string | undefined;
    if (body.description !== undefined) {
      if (typeof body.description !== "string")
        return jsonError(400, "description 必须是字符串");
      description = body.description;
    }

    const parsed = parseGraphPayload(body);
    if ("error" in parsed) return parsed.error;
    const { nodes, edges } = parsed;

    db.transaction((tx) => {
      tx.update(workflows)
        .set({
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          updatedAt: new Date(),
        })
        .where(eq(workflows.id, id))
        .run();
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
    });

    return workflowResponse(id);
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const deleted = db
      .delete(workflows)
      .where(eq(workflows.id, id))
      .returning({ id: workflows.id })
      .get();
    if (!deleted) return jsonError(404, "工作流不存在");
    return NextResponse.json({ ok: true });
  });
}
