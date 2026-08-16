import { NextResponse } from "next/server";
import { handle, jsonError } from "@/lib/http";
import { getCost } from "@/server/monitor/metrics";

export const dynamic = "force-dynamic";

/**
 * GET /api/monitor/cost?days=7 — 按模型 / Action / 工作流 / 日期的用量与费用
 * （CostPayload；days 取值 1–90，缺省 7）。
 */
export async function GET(request: Request) {
  return handle(() => {
    const daysRaw = new URL(request.url).searchParams.get("days");
    let days: number | undefined;
    if (daysRaw) {
      const parsed = Number(daysRaw);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return jsonError(400, "days 必须是不小于 1 的整数");
      }
      days = Math.trunc(parsed);
    }
    return NextResponse.json(getCost(days));
  });
}
