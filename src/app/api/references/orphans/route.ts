import { NextResponse } from "next/server";
import { ENTITY_KINDS } from "@/db";
import { handle, jsonError } from "@/lib/http";
import { isEntityKind, orphans } from "@/server/references";

export const dynamic = "force-dynamic";

/**
 * GET /api/references/orphans?kind=  未被任何人引用的实体（监控页孤儿检测）
 * kind 省略则返回全部库合并的结果。
 * 响应：{ items: Array<{ kind, id, name, href }> }
 * 注：workflow 是顶层实体（refCount 恒为 0），孤儿概念不适用，恒为空。
 */
export async function GET(request: Request) {
  return handle(() => {
    const kindRaw = new URL(request.url).searchParams.get("kind");
    if (kindRaw !== null && !isEntityKind(kindRaw))
      return jsonError(400, `未知的实体类型：${kindRaw}`);
    const kinds = kindRaw ? [kindRaw] : [...ENTITY_KINDS];
    return NextResponse.json({ items: kinds.flatMap((k) => orphans(k)) });
  });
}
