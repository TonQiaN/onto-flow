import { NextResponse } from "next/server";
import { handle, jsonError } from "@/lib/http";
import { assignEntityFolder, isFolderEntityKind } from "@/server/folders";

export const dynamic = "force-dynamic";

/**
 * POST /api/folders/assign  body: { entityKind, entityId, folderId: string | null }
 * 单归属指派：folderId 为 null 时移出文件夹（变未归类）。
 */
export async function POST(request: Request) {
  return handle(async () => {
    const raw: unknown = await request.json();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return jsonError(400, "请求体必须是 JSON 对象");
    const body = raw as Record<string, unknown>;

    if (typeof body.entityKind !== "string" || !isFolderEntityKind(body.entityKind))
      return jsonError(400, `不支持文件夹的实体类型：${String(body.entityKind)}`);
    if (typeof body.entityId !== "string" || body.entityId === "")
      return jsonError(400, "entityId 不能为空");
    if (body.folderId !== null && typeof body.folderId !== "string")
      return jsonError(400, "folderId 必须是字符串或 null");

    const result = assignEntityFolder(body.entityKind, body.entityId, body.folderId);
    if (!result.ok) return jsonError(result.status, result.error);
    return NextResponse.json(result.data);
  });
}
