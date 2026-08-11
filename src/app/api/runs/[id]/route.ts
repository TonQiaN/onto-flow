import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db, runNodes, runs } from "@/db";
import { handle, jsonError } from "@/lib/http";

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
