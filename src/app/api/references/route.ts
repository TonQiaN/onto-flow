import { NextResponse } from "next/server";
import { handle, jsonError } from "@/lib/http";
import { entityExists, isEntityKind, referencesOf } from "@/server/references";

export const dynamic = "force-dynamic";

/**
 * GET /api/references?kind=&id=  谁在引用这个实体
 * 响应：{ refs: Array<{ kind, id, name, detail, href }> }
 */
export async function GET(request: Request) {
  return handle(() => {
    const sp = new URL(request.url).searchParams;
    const kind = sp.get("kind");
    const id = sp.get("id");
    if (!isEntityKind(kind)) return jsonError(400, `未知的实体类型：${kind}`);
    if (!id) return jsonError(400, "缺少 id 参数");
    if (!entityExists(kind, id)) return jsonError(404, "实体不存在");
    return NextResponse.json({ refs: referencesOf(kind, id) });
  });
}
