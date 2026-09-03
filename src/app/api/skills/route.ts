import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { db, skills } from "@/db";
import { handle } from "@/lib/http";
import "@/server/writers";
import { listEnvelope, parseListQuery, selectLibraryPage } from "@/server/writers/list";
import { createSkill } from "@/server/writers/skill";
import { respond } from "@/server/writers/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(() => {
    const query = parseListQuery(request.url);
    const page = selectLibraryPage({
      kind: "skill",
      table: skills,
      columns: {
        id: skills.id,
        name: skills.name,
        description: skills.description,
        updatedAt: skills.updatedAt,
      },
      query,
    });
    const rows =
      page.ids.length > 0 ? db.select().from(skills).where(inArray(skills.id, page.ids)).all() : [];
    return NextResponse.json(listEnvelope(page, rows));
  });
}

export async function POST(request: Request) {
  return handle(async () => respond(createSkill(await request.json())));
}
