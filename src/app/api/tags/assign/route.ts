import { NextResponse } from "next/server";
import { handle, jsonError } from "@/lib/http";
import { isEntityKind } from "@/server/references";
import { assignTags } from "@/server/tags";

export const dynamic = "force-dynamic";

/**
 * POST /api/tags/assign  body: { entityKind, entityId, tagIds: string[] }
 * 整体替换该实体的标签集合，响应为替换后的标签清单。
 */
export async function POST(request: Request) {
  return handle(async () => {
    const raw: unknown = await request.json();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return jsonError(400, "请求体必须是 JSON 对象");
    const body = raw as Record<string, unknown>;

    if (!isEntityKind(body.entityKind))
      return jsonError(400, `未知的实体类型：${String(body.entityKind)}`);
    if (typeof body.entityId !== "string" || body.entityId === "")
      return jsonError(400, "entityId 不能为空");

    const result = assignTags(body.entityKind, body.entityId, body.tagIds);
    if (!result.ok) return jsonError(result.status, result.error);
    return NextResponse.json({ tags: result.data });
  });
}
