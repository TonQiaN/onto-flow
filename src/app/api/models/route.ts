import { NextResponse } from "next/server";
import { db, models } from "@/db";
import { handle } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/models  可选模型全表（Action 编辑器的模型下拉） */
export async function GET() {
  return handle(() => NextResponse.json(db.select().from(models).all()));
}
