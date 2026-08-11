import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db, runs, workflows } from "@/db";
import { handle } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/runs?workflowId= — 运行列表（join workflows 拿 workflowName），倒序 */
export async function GET(request: Request) {
  return handle(() => {
    const workflowId = new URL(request.url).searchParams.get("workflowId");
    const base = db
      .select({
        id: runs.id,
        workflowId: runs.workflowId,
        workflowName: workflows.name,
        status: runs.status,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
      })
      .from(runs)
      .innerJoin(workflows, eq(runs.workflowId, workflows.id));
    const rows = (
      workflowId ? base.where(eq(runs.workflowId, workflowId)) : base
    )
      .orderBy(desc(runs.startedAt))
      .all();
    return NextResponse.json(rows);
  });
}
