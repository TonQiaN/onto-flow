import { NextResponse } from "next/server";
import { actions } from "@/db";
import { handle } from "@/lib/http";
import "@/server/writers";
import { createAction, loadActionDtos } from "@/server/writers/action";
import {
  listEnvelope,
  parseListQuery,
  selectLibraryPage,
} from "@/server/writers/list";
import { respond } from "@/server/writers/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(() => {
    const query = parseListQuery(request.url);
    const page = selectLibraryPage({
      kind: "action",
      table: actions,
      columns: {
        id: actions.id,
        name: actions.name,
        description: actions.description,
        updatedAt: actions.updatedAt,
      },
      query,
    });
    // 列表项是完整 ActionDto（含 ports/skillIds/toolIds），再附 folder/refCount
    return NextResponse.json(listEnvelope(page, loadActionDtos(page.ids)));
  });
}

export async function POST(request: Request) {
  return handle(async () => respond(createAction(await request.json())));
}
