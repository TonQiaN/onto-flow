import { NextResponse } from "next/server";
import { handle, jsonError } from "@/lib/http";
import { readRoundPayload } from "@/server/run-rounds";

export const dynamic = "force-dynamic";

/**
 * GET /api/runs/[id]/nodes/[nodeId]/rounds/[round] — 这一轮的重载荷
 * `{ inputs, outputs, snapshot }`（ADR-0018）。
 *
 * 骨架跟着 `/api/runs/[id]` 与 SSE 的 snapshot 帧全量下发，重载荷只在抽屉打开或换轮时取一轮：
 * 快照含 prompt、rule、渲染后的提示与技能正文，循环运行会成倍复制，跟着每一帧走就是把同一份
 * 大对象反复推给页面。被事件清理置空的列返回 null——与「这一轮本就没有」同一形状，页面用同一句
 * 文案解释，不为清理另开一条分支。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; nodeId: string; round: string }> },
) {
  return handle(async () => {
    const { id, nodeId, round } = await params;
    const roundNo = Number(round);
    if (!Number.isSafeInteger(roundNo) || roundNo < 0) {
      return jsonError(400, "轮次必须是非负整数");
    }
    const payload = readRoundPayload(id, nodeId, roundNo);
    if (!payload) return jsonError(404, "该轮次不存在");
    return NextResponse.json(payload);
  });
}
