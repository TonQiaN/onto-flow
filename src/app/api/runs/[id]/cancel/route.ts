import { NextResponse } from "next/server";
import { handle, jsonError } from "@/lib/http";
import { cancelRun } from "@/server/engine/runner";

export const dynamic = "force-dynamic";

/**
 * POST /api/runs/[id]/cancel — 人为中止运行。
 * 引擎负责 abort 会话 + 标记 cancelled/skipped，这里只做 HTTP 映射：
 * 运行不存在 404，已是终态 409，成功 { ok: true }。
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    const result = await cancelRun(id);
    if (result.ok) return NextResponse.json({ ok: true });
    // 409 文案由 HTTP 契约固定；404 沿用引擎文案
    return jsonError(result.status, result.status === 409 ? "运行已结束，无法取消" : result.error);
  });
}
