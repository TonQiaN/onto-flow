import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db, runNodes, runs } from "@/db";
import { handle, jsonError } from "@/lib/http";
import { CleanupError, deleteRun } from "@/server/monitor/cleanup";

export const dynamic = "force-dynamic";

/** GET /api/runs/[id] — { run, nodes: run_nodes 行[] } */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
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
    return NextResponse.json({ run, nodes });
  });
}

/** DELETE /api/runs/[id] — 删除单个已结束的运行（记录级联 + 工作区目录）。 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
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
