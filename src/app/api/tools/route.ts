import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { db, tools } from "@/db";
import { handle } from "@/lib/http";
import "@/server/writers";
import {
  listEnvelope,
  parseListQuery,
  selectLibraryPage,
} from "@/server/writers/list";
import { createTool } from "@/server/writers/tool";
import { respond } from "@/server/writers/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(() => {
    const query = parseListQuery(request.url);
    const page = selectLibraryPage({
      kind: "tool",
      table: tools,
      columns: {
        id: tools.id,
        name: tools.name,
        description: tools.description,
        updatedAt: tools.updatedAt,
        // 库页按模型可见的公名也能搜到
        extraSearch: tools.publicName,
      },
      query,
    });
    const rows =
      page.ids.length > 0
        ? db.select().from(tools).where(inArray(tools.id, page.ids)).all()
        : [];
    return NextResponse.json(listEnvelope(page, rows));
  });
}

export async function POST(request: Request) {
  return handle(async () => respond(createTool(await request.json())));
}
