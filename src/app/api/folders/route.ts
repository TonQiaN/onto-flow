import { NextResponse } from "next/server";
import { handle, jsonError } from "@/lib/http";
import { createFolder, isFolderEntityKind, listEntityLeaves, listFolders } from "@/server/folders";
import { respond } from "@/server/writers/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/folders               → { folders }（文件夹选择器用，全部文件夹按 name 升序）
 * GET /api/folders?kind=action   → { folders, entities }（列表页左树用，entities 为该库实体叶子）
 * kind 非四库之一 → 400（workflow 明确不进文件夹，ADR-0005）。
 */
export async function GET(request: Request) {
  return handle(() => {
    const kindRaw = new URL(request.url).searchParams.get("kind");
    if (kindRaw === null) return NextResponse.json({ folders: listFolders() });
    if (!isFolderEntityKind(kindRaw)) return jsonError(400, `不支持文件夹的实体类型：${kindRaw}`);
    return NextResponse.json({
      folders: listFolders(),
      entities: listEntityLeaves(kindRaw),
    });
  });
}

/** POST /api/folders  body: { name, parentId? }——409 同级重名 / 404 父不存在 */
export async function POST(request: Request) {
  return handle(async () => {
    const raw: unknown = await request.json();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return jsonError(400, "请求体必须是 JSON 对象");
    const body = raw as Record<string, unknown>;
    return respond(createFolder(body.name, body.parentId));
  });
}
