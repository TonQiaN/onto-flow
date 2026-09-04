import { NextResponse } from "next/server";
import { handle, jsonError } from "@/lib/http";
import { getRevision, patchRevision } from "@/server/revisions";
import { respond } from "@/server/writers/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ revId: string }> };

/** GET /api/revisions/[revId]  单条修订，含 payload */
export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { revId } = await params;
    const revision = getRevision(revId);
    if (!revision) return jsonError(404, "修订不存在");
    return NextResponse.json(revision);
  });
}

/** PATCH /api/revisions/[revId]  body: { pinned?, note? } */
export async function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    const { revId } = await params;
    const raw: unknown = await request.json();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return jsonError(400, "请求体必须是 JSON 对象");
    const body = raw as Record<string, unknown>;
    return respond(
      patchRevision(revId, {
        pinned: body.pinned,
        note: body.note,
      }),
    );
  });
}
