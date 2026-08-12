import { NextResponse } from "next/server";
// 副作用导入：五个库在此把自己的写入器注册进修订注册表，回滚才能复用 PUT 的写入路径
import "@/server/writers";
import { handle, jsonError } from "@/lib/http";
import { restoreRevision } from "@/server/revisions";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ revId: string }> };

/**
 * POST /api/revisions/[revId]/restore
 * 把该版 payload 经实体自己的写入器写回（与 PUT 同一条校验与写入路径），
 * 并为回滚动作留一版新修订（note：回滚到第 N 版）。
 * 响应：{ revision, restoredFrom }；未注册写入器的实体类型返回 501。
 */
export async function POST(_request: Request, { params }: Params) {
  return handle(async () => {
    const { revId } = await params;
    const result = restoreRevision(revId);
    if (!result.ok) return jsonError(result.status, result.error);
    return NextResponse.json(result.data);
  });
}
