import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { actions, db } from "@/db";
import { handle, jsonError } from "@/lib/http";
import "@/server/writers";
import { loadActionDto, writeAction } from "@/server/writers/action";
import { respond } from "@/server/writers/types";
import { usedByNames } from "@/server/writers/used-by";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const dto = loadActionDto(id);
    if (!dto) return jsonError(404, "Action 不存在");
    return NextResponse.json(dto);
  });
}

export async function PUT(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    return respond(writeAction(id, await request.json()));
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const existing = db.select().from(actions).where(eq(actions.id, id)).get();
    if (!existing) return jsonError(404, "Action 不存在");

    const usedBy = usedByNames("action", id);
    if (usedBy.length > 0) return jsonError(409, "该 Action 正被工作流引用，无法删除", { usedBy });

    db.delete(actions).where(eq(actions.id, id)).run();
    return NextResponse.json({ ok: true });
  });
}
