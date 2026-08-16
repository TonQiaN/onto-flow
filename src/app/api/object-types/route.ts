import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { db, objectTypes } from "@/db";
import { handle } from "@/lib/http";
import "@/server/writers";
import {
  listEnvelope,
  parseListQuery,
  selectLibraryPage,
} from "@/server/writers/list";
import { createObjectType } from "@/server/writers/object-type";
import { respond } from "@/server/writers/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(() => {
    const query = parseListQuery(request.url);
    const page = selectLibraryPage({
      kind: "object_type",
      table: objectTypes,
      columns: {
        id: objectTypes.id,
        name: objectTypes.name,
        description: objectTypes.description,
        updatedAt: objectTypes.updatedAt,
      },
      query,
    });
    const rows =
      page.ids.length > 0
        ? db
            .select()
            .from(objectTypes)
            .where(inArray(objectTypes.id, page.ids))
            .all()
        : [];
    return NextResponse.json(listEnvelope(page, rows));
  });
}

export async function POST(request: Request) {
  return handle(async () => respond(createObjectType(await request.json())));
}
