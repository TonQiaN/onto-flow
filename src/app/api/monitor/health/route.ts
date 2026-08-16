import { NextResponse } from "next/server";
import { handle } from "@/lib/http";
import { getHealth } from "@/server/monitor/health";

export const dynamic = "force-dynamic";

/**
 * GET /api/monitor/health — opencode 可达性、事件泵路由、库表行数、磁盘占用、
 * 孤儿运行（HealthPayload）。opencode 探测超时 2 秒，不可达也返回 200。
 */
export async function GET() {
  return handle(async () => NextResponse.json(await getHealth()));
}
