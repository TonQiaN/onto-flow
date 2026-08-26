import { NextResponse } from "next/server";
import { handle } from "@/lib/http";
import { getHealth } from "@/server/monitor/health";

export const dynamic = "force-dynamic";

/**
 * GET /api/monitor/health — 引擎就绪、在跑的运行子进程、库表行数、磁盘占用、
 * 孤儿运行（HealthPayload）。全部本地读取，不联网，任何一段失败也返回 200。
 */
export async function GET() {
  return handle(async () => NextResponse.json(await getHealth()));
}
