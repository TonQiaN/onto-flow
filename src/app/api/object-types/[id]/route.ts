import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, objectTypes } from "@/db";
import { handle, jsonError } from "@/lib/http";
import "@/server/writers";
import { writeObjectType } from "@/server/writers/object-type";
import { respond } from "@/server/writers/types";
import { usedByNames } from "@/server/writers/used-by";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const row = db.select().from(objectTypes).where(eq(objectTypes.id, id)).get();
    if (!row) return jsonError(404, "对象类型不存在");
    return NextResponse.json(row);
  });
}

export async function PUT(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    return respond(writeObjectType(id, await request.json()));
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const row = db.select().from(objectTypes).where(eq(objectTypes.id, id)).get();
    if (!row) return jsonError(404, "对象类型不存在");
    if (row.builtin) return jsonError(403, "内置类型不可删除");

    const usedBy = usedByNames("object_type", id);
    if (usedBy.length > 0) return jsonError(409, "该对象类型正被引用，无法删除", { usedBy });

    db.delete(objectTypes).where(eq(objectTypes.id, id)).run();
    return NextResponse.json({ ok: true });
  });
}
