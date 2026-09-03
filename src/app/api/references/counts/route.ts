import { NextResponse } from "next/server";
import { handle, jsonError } from "@/lib/http";
import { isEntityKind, listEntities, refCounts } from "@/server/references";

export const dynamic = "force-dynamic";

/**
 * GET /api/references/counts?kind=  批量取引用数
 * 响应：{ [entityId]: number }，该 kind 下每个实体都在（未被引用的为 0）。
 */
export async function GET(request: Request) {
  return handle(() => {
    const kind = new URL(request.url).searchParams.get("kind");
    if (!isEntityKind(kind)) return jsonError(400, `未知的实体类型：${kind}`);
    const counts = refCounts(kind);
    const out: Record<string, number> = {};
    for (const entity of listEntities(kind)) out[entity.id] = counts[entity.id] ?? 0;
    return NextResponse.json(out);
  });
}
