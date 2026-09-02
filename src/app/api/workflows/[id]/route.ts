import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, runs, workflows } from "@/db";
import { validateGraph } from "@/lib/graph";
import { handle, jsonError } from "@/lib/http";
import { resolveWorkflow } from "@/server/resolve";
import "@/server/writers";
import { loadWorkflowSets, writeWorkflow } from "@/server/writers/workflow";

export const dynamic = "force-dynamic";

/**
 * GET/PUT 共用的响应：workflow 全量定义（含指令、设置与两个集合，ADR-0016）+
 * NodeDto/EdgeDto + 校验 issues。设置页「先 GET 全量再 PUT 全量」靠的就是这份形状。
 */
async function workflowResponse(id: string) {
  // 编辑面不因 ⊆ 违反而 500：问题随 issues 回到页面，人从设置页把技能/Tool 加进集合即可修复。
  const resolved = await resolveWorkflow(id, { subsetViolations: "collect" });
  if (!resolved) return jsonError(404, "工作流不存在");
  const issues = [...validateGraph(resolved.nodes, resolved.edges), ...resolved.subsetIssues];
  const sets = loadWorkflowSets(id);
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
      instructions: resolved.workflow.instructions,
      settings: resolved.workflow.settings,
      skillIds: sets.skillIds,
      toolIds: sets.toolIds,
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
    const existing = db
      .select({ id: workflows.id })
      .from(workflows)
      .where(eq(workflows.id, id))
      .get();
    if (!existing) return jsonError(404, "工作流不存在");

    // 删除保护：runs.workflow_id 是 onDelete cascade，直接删工作流会连带抹掉在跑的
    // run 行——cancelRun 随后查不到该 run（运行再也无法中止），data/runs/<runId>
    // 工作区在清理器眼里变成无归属的非 running 目录可被误删，而引擎线程仍在跑并继续计费。
    // 因此有 running 运行时拒绝删除，语义与五个库的引用保护一致：409 + { error, usedBy }。
    const activeRunIds = db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.workflowId, id), eq(runs.status, "running")))
      .all()
      .map((run) => run.id);
    if (activeRunIds.length > 0)
      return jsonError(409, "该工作流有正在进行的运行，无法删除", {
        usedBy: activeRunIds,
      });

    db.delete(workflows).where(eq(workflows.id, id)).run();
    return NextResponse.json({ ok: true });
  });
}
