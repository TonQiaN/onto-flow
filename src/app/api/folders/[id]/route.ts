import { NextResponse } from "next/server";
import { handle, jsonError } from "@/lib/http";
import { deleteFolder, updateFolder } from "@/server/folders";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/folders/[id]  body: { name?, parentId? }——重命名 and/or 移动。
 * parentId 传 null = 移到根；循环移动 400，同级重名 409。
 */
export async function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const raw: unknown = await request.json();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return jsonError(400, "请求体必须是 JSON 对象");
    const body = raw as Record<string, unknown>;
    const result = updateFolder(id, {
      name: body.name,
      parentId: body.parentId,
    });
    if (!result.ok) return jsonError(result.status, result.error);
    return NextResponse.json(result.data);
  });
}

/** DELETE /api/folders/[id]——子文件夹与实体指派上移到父级（根级实体变未归类），实体本身永不删除 */
export async function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const result = deleteFolder(id);
    if (!result.ok) return jsonError(result.status, result.error);
    return NextResponse.json(result.data);
  });
}
