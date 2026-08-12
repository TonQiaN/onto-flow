import { NextResponse } from "next/server";
import { handle, jsonError } from "@/lib/http";
import { getLogs } from "@/server/monitor/metrics";

export const dynamic = "force-dynamic";

/**
 * GET /api/monitor/logs?runId=&nodeId=&type=&q=&onlyErrors=&limit=&cursor=
 * 按 id 倒序、游标分页（cursor = 上一页最小 id）。payload 已 JSON.parse，
 * 并冗余 nodeLabel / workflowName（LogsPayload）。
 */
export async function GET(request: Request) {
  return handle(() => {
    const query = new URL(request.url).searchParams;

    const limitRaw = query.get("limit");
    let limit: number | undefined;
    if (limitRaw) {
      const parsed = Number(limitRaw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return jsonError(400, "limit 必须是正整数");
      }
      limit = Math.trunc(parsed);
    }

    const cursorRaw = query.get("cursor");
    let cursor: number | undefined;
    if (cursorRaw) {
      const parsed = Number(cursorRaw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return jsonError(400, "cursor 必须是非负整数");
      }
      cursor = Math.trunc(parsed);
    }

    return NextResponse.json(
      getLogs({
        runId: query.get("runId") ?? undefined,
        nodeId: query.get("nodeId") ?? undefined,
        type: query.get("type") ?? undefined,
        q: query.get("q") ?? undefined,
        onlyErrors: query.get("onlyErrors") === "true",
        limit,
        cursor,
      }),
    );
  });
}
