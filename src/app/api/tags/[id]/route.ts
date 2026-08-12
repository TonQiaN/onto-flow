import { NextResponse } from "next/server";
import { handle, jsonError } from "@/lib/http";
import { deleteTag, updateTag } from "@/server/tags";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** PUT /api/tags/[id]  body: { name?, color? }——改名是全局操作 */
export async function PUT(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const raw: unknown = await request.json();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return jsonError(400, "请求体必须是 JSON 对象");
    const body = raw as Record<string, unknown>;
    const result = updateTag(id, { name: body.name, color: body.color });
    if (!result.ok) return jsonError(result.status, result.error);
    return NextResponse.json(result.data);
  });
}

/** DELETE /api/tags/[id]——标签是软分类，直接删，entity_tags 级联清除 */
export async function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const result = deleteTag(id);
    if (!result.ok) return jsonError(result.status, result.error);
    return NextResponse.json(result.data);
  });
}
