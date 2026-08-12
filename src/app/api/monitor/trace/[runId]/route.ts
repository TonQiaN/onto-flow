import { NextResponse } from "next/server";
import { handle, jsonError } from "@/lib/http";
import { getTrace } from "@/server/monitor/metrics";

export const dynamic = "force-dynamic";

/**
 * GET /api/monitor/trace/[runId] — 把一次运行摊平成 span 树
 * （run → node → session → step，startMs 是相对 run.startedAt 的毫秒偏移）。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  return handle(async () => {
    const { runId } = await params;
    const trace = getTrace(runId);
    if (!trace) return jsonError(404, "运行不存在");
    return NextResponse.json(trace);
  });
}
