import { NextResponse } from "next/server";
import { handle, jsonError } from "@/lib/http";
import { entityExists, isEntityKind } from "@/server/references";
import { listRevisions } from "@/server/revisions";

export const dynamic = "force-dynamic";

/**
 * GET /api/revisions?kind=&id=  该实体的修订列表（版本号倒序，不含 payload）
 * 响应：{ items: Array<{ id, entityKind, entityId, versionNo, note, pinned, createdAt }> }
 */
export async function GET(request: Request) {
  return handle(() => {
    const sp = new URL(request.url).searchParams;
    const kind = sp.get("kind");
    const id = sp.get("id");
    if (!isEntityKind(kind)) return jsonError(400, `未知的实体类型：${kind}`);
    if (!id) return jsonError(400, "缺少 id 参数");
    if (!entityExists(kind, id)) return jsonError(404, "实体不存在");
    return NextResponse.json({ items: listRevisions(kind, id) });
  });
}
