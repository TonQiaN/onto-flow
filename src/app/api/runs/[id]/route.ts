import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db, runNodes, runs } from "@/db";
import { handle, jsonError } from "@/lib/http";
import { parseRunGraph } from "@/lib/run-graph";
import { CleanupError, deleteRun } from "@/server/monitor/cleanup";
import { listRoundSkeletons } from "@/server/run-rounds";

export const dynamic = "force-dynamic";

/**
 * GET /api/runs/[id] — `{ run, nodes, rounds }`。
 *
 * `run.graph` 是受理时冻结的那张图（ADR-0018），运行页只画它；`nodes` 是各节点的最新状态，
 * `rounds` 是每个节点每一次执行的一行**骨架**——这一轮的输入输出与快照按轮另取
 * （`/api/runs/[id]/nodes/[nodeId]/rounds/[round]`），不跟着每一帧 snapshot 反复下发。
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    const run = db.select().from(runs).where(eq(runs.id, id)).get();
    if (!run) return jsonError(404, "运行不存在");
    const nodes = db
      .select()
      .from(runNodes)
      .where(eq(runNodes.runId, id))
      .orderBy(asc(runNodes.startedAt))
      .all();
    const rounds = listRoundSkeletons(id);
    return NextResponse.json({ run: { ...run, graph: parseRunGraph(run.graph) }, nodes, rounds });
  });
}

/** DELETE /api/runs/[id] — 删除单个已结束的运行（记录级联 + 工作区目录）。 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    try {
      const result = deleteRun(id);
      if (!result.ok) return jsonError(result.status, result.error);
      return NextResponse.json({ ok: true });
    } catch (err) {
      if (err instanceof CleanupError) return jsonError(400, err.message);
      throw err;
    }
  });
}
