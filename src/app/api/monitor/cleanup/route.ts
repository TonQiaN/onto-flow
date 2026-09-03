import { NextResponse } from "next/server";
import { handle, jsonError } from "@/lib/http";
import { CleanupError, isCleanupTarget, runCleanup } from "@/server/monitor/cleanup";

export const dynamic = "force-dynamic";

/**
 * POST /api/monitor/cleanup
 * body: { target: "workspaces"|"events"|"runs", beforeDays: number, dryRun?: boolean }
 *
 * dryRun=true 只算影响面不删（前端二次确认前必须先预览一次）。
 * 进行中的运行永不参与清理；beforeDays 必须是正整数。
 */
export async function POST(request: Request) {
  return handle(async () => {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object") {
      return jsonError(400, "请求体必须是 JSON 对象");
    }
    const { target, beforeDays, dryRun } = body as Record<string, unknown>;

    if (!isCleanupTarget(target)) {
      return jsonError(400, "target 必须是 workspaces / events / runs 之一");
    }
    if (typeof beforeDays !== "number" || !Number.isInteger(beforeDays) || beforeDays < 1) {
      return jsonError(400, "beforeDays 必须是正整数（保留最近 N 天）");
    }
    if (dryRun !== undefined && typeof dryRun !== "boolean") {
      return jsonError(400, "dryRun 必须是布尔值");
    }

    try {
      return NextResponse.json(runCleanup({ target, beforeDays, dryRun }));
    } catch (err) {
      if (err instanceof CleanupError) return jsonError(400, err.message);
      throw err;
    }
  });
}
