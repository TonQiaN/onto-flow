import { NextResponse } from "next/server";
import { count, desc } from "drizzle-orm";
import { db, workflowNodes, workflows } from "@/db";
import { handle, jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(() => {
    const rows = db
      .select()
      .from(workflows)
      .orderBy(desc(workflows.updatedAt))
      .all();
    const counts = new Map(
      db
        .select({ workflowId: workflowNodes.workflowId, n: count() })
        .from(workflowNodes)
        .groupBy(workflowNodes.workflowId)
        .all()
        .map((r) => [r.workflowId, r.n]),
    );
    return NextResponse.json(
      rows.map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description,
        updatedAt: w.updatedAt,
        nodeCount: counts.get(w.id) ?? 0,
      })),
    );
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    const raw = await request.json();
    if (typeof raw !== "object" || raw === null)
      return jsonError(400, "请求体必须是 JSON 对象");
    const body = raw as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return jsonError(400, "名称不能为空");
    const description =
      typeof body.description === "string" ? body.description : "";
    const row = db
      .insert(workflows)
      .values({ name, description })
      .returning()
      .get();
    return NextResponse.json(row);
  });
}
