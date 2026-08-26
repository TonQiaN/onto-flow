import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, skills } from "@/db";
import { handle, jsonError } from "@/lib/http";
import "@/server/writers";
import { writeSkill } from "@/server/writers/skill";
import { respond } from "@/server/writers/types";
import { removeSkill } from "@/server/skill-library";
import { usedByNames } from "@/server/writers/used-by";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const row = db.select().from(skills).where(eq(skills.id, id)).get();
    if (!row) return jsonError(404, "技能不存在");
    return NextResponse.json(row);
  });
}

export async function PUT(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    return respond(writeSkill(id, await request.json()));
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const row = db.select().from(skills).where(eq(skills.id, id)).get();
    if (!row) return jsonError(404, "技能不存在");

    const usedBy = usedByNames("skill", id);
    if (usedBy.length > 0)
      return jsonError(409, "该技能正被 Action 引用，无法删除", { usedBy });

    db.delete(skills).where(eq(skills.id, id)).run();
    // 库里没了，磁盘投影也要没：否则 skill-filesystem 还会发现它。
    removeSkill(row);
    return NextResponse.json({ ok: true });
  });
}
