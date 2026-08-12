import { NextResponse } from "next/server";
import { handle } from "@/lib/http";
import { getLiveSessions } from "@/server/monitor/metrics";

export const dynamic = "force-dynamic";

/**
 * GET /api/monitor/sessions — 活跃会话（run_nodes.status='running' 且 sessionId 非空）。
 * 每项带最近一条事件的摘要（SessionsPayload）。
 */
export async function GET() {
  return handle(() => NextResponse.json(getLiveSessions()));
}
