/**
 * GET/PUT /api/settings — 全局设置文档。
 *
 * 凭据只有引用名，值不经这条路：PUT 的请求体里出现的永远是环境变量名。
 */
import { NextResponse } from "next/server";
import { handle } from "@/lib/http";
import { readSettings, writeSettings } from "@/server/settings";
import { respond } from "@/server/writers/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => NextResponse.json(readSettings()));
}

export async function PUT(request: Request) {
  return handle(async () => respond(writeSettings(await request.json())));
}
