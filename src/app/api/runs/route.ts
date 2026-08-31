import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, runNodes, runs } from "@/db";
import { handle, jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

const RUN_STATUSES = ["running", "success", "failed", "cancelled"] as const;
type RunStatus = (typeof RUN_STATUSES)[number];

function isRunStatus(value: string): value is RunStatus {
  return (RUN_STATUSES as readonly string[]).includes(value);
}

/**
 * GET /api/runs?workflowId=&status= — 运行列表，倒序。
 * 工作流名读 runs.workflowName（运行当时的冗余快照，改名后历史仍可读）；
 * 用量 left join run_nodes 求和，列表直接展示总 token 与总费用。
 */
export async function GET(request: Request) {
  return handle(() => {
    const query = new URL(request.url).searchParams;
    const workflowId = query.get("workflowId");
    const statusParam = query.get("status");
    let status: RunStatus | undefined;
    if (statusParam) {
      if (!isRunStatus(statusParam)) return jsonError(400, "status 取值非法");
      status = statusParam;
    }

    const filters = [
      workflowId ? eq(runs.workflowId, workflowId) : undefined,
      status ? eq(runs.status, status) : undefined,
    ].filter((f) => f !== undefined);

    const rows = db
      .select({
        id: runs.id,
        workflowId: runs.workflowId,
        workflowName: runs.workflowName,
        status: runs.status,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
        totalTokens: sql<number>`coalesce(sum(
          ${runNodes.inputTokens} + ${runNodes.outputTokens} +
          ${runNodes.reasoningTokens} + ${runNodes.cacheReadTokens} +
          ${runNodes.cacheWriteTokens}
        ), 0)`,
        totalCost: sql<number>`coalesce(sum(${runNodes.cost}), 0)`,
        // 进度：导航「运行中」面板与列表都要展示 N/M 个节点，避免逐运行再打详情接口
        nodesTotal: sql<number>`count(${runNodes.id})`,
        nodesDone: sql<number>`coalesce(sum(case when ${runNodes.status} in ('success', 'failed', 'cancelled', 'skipped') then 1 else 0 end), 0)`,
      })
      .from(runs)
      .leftJoin(runNodes, eq(runNodes.runId, runs.id))
      .where(filters.length > 0 ? and(...filters) : undefined)
      .groupBy(runs.id)
      .orderBy(desc(runs.startedAt))
      .all();

    return NextResponse.json(rows);
  });
}
