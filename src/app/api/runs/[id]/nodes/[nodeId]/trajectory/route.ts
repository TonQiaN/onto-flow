import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, runNodes, runs } from "@/db";
import { handle, jsonError } from "@/lib/http";
import { readAgentTrajectory } from "@/server/harness/trajectory";

export const dynamic = "force-dynamic";

/** GET /api/runs/[id]/nodes/[nodeId]/trajectory — 单个 Action 的逐轮会话轨迹。 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  return handle(async () => {
    const { id, nodeId } = await params;
    const run = db.select().from(runs).where(eq(runs.id, id)).get();
    if (!run) return jsonError(404, "运行不存在");
    const node = db
      .select()
      .from(runNodes)
      .where(and(eq(runNodes.runId, id), eq(runNodes.nodeId, nodeId)))
      .get();
    if (!node) return jsonError(404, "运行节点不存在");

    const trajectory = readAgentTrajectory({
      runDir: run.runDir,
      nodeId,
      activeSessionId:
        run.status === "running" && node.status === "running" ? node.sessionId : null,
    });
    return NextResponse.json(trajectory);
  });
}
