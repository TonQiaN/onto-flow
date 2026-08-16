import { NextResponse } from "next/server";
import { handle } from "@/lib/http";
import { getOverview } from "@/server/monitor/metrics";

export const dynamic = "force-dynamic";

/** GET /api/monitor/overview — 实时数 + 今日汇总 + 近 24 小时分桶（MonitorOverview） */
export async function GET() {
  return handle(() => NextResponse.json(getOverview()));
}
