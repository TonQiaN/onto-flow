import { NextResponse } from "next/server";
import { handle, jsonError } from "@/lib/http";
import { isEntityKind } from "@/server/references";
import { createTag, listTags } from "@/server/tags";

export const dynamic = "force-dynamic";

/**
 * GET /api/tags?kind=action
 * 传 kind 只返回该库下挂载过的标签（列表页左树）；不传返回全部（标签选择器）。
 * 响应：Array<{ id, name, color, counts: { [kind]: number } }>，按 name 升序。
 */
export async function GET(request: Request) {
  return handle(() => {
    const kindRaw = new URL(request.url).searchParams.get("kind");
    if (kindRaw !== null && !isEntityKind(kindRaw))
      return jsonError(400, `未知的实体类型：${kindRaw}`);
    return NextResponse.json(listTags(kindRaw ?? undefined));
  });
}

/** POST /api/tags  body: { name, color? } */
export async function POST(request: Request) {
  return handle(async () => {
    const raw: unknown = await request.json();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return jsonError(400, "请求体必须是 JSON 对象");
    const body = raw as Record<string, unknown>;
    const result = createTag(body.name, body.color);
    if (!result.ok) return jsonError(result.status, result.error);
    return NextResponse.json(result.data);
  });
}
