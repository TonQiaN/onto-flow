import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, tools } from "@/db";
import { handle, jsonError } from "@/lib/http";
import "@/server/writers";
import { writeTool } from "@/server/writers/tool";
import { respond } from "@/server/writers/types";
import { usedByNames } from "@/server/writers/used-by";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const row = db.select().from(tools).where(eq(tools.id, id)).get();
    if (!row) return jsonError(404, "Tool 不存在");
    return NextResponse.json(row);
  });
}

export async function PUT(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    return respond(writeTool(id, await request.json()));
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const row = db.select().from(tools).where(eq(tools.id, id)).get();
    if (!row) return jsonError(404, "Tool 不存在");

    const usedBy = usedByNames("tool", id);
    if (usedBy.length > 0)
      return jsonError(409, "该 Tool 正被工作流引用，无法删除", { usedBy });

    db.delete(tools).where(eq(tools.id, id)).run();
    return NextResponse.json({ ok: true });
  });
}
