import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, workflows } from "@/db";
import { validateGraph } from "@/lib/graph";
import { handle, jsonError } from "@/lib/http";
import { resolveWorkflow } from "@/server/resolve";
import "@/server/writers";
import { writeWorkflow } from "@/server/writers/workflow";

export const dynamic = "force-dynamic";

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

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => workflowResponse((await params).id));
}

export async function PUT(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const result = writeWorkflow(id, await request.json());
    if (!result.ok) return jsonError(result.status, result.error);
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
