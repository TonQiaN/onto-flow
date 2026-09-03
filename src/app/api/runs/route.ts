import { NextResponse } from "next/server";
import { and, count, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { db, runNodes, runs } from "@/db";
import { handle, jsonError } from "@/lib/http";
import { parsePageQuery } from "@/server/writers/list";

export const dynamic = "force-dynamic";

const RUN_STATUSES = ["running", "success", "failed", "cancelled"] as const;
type RunStatus = (typeof RUN_STATUSES)[number];

function isRunStatus(value: string): value is RunStatus {
  return (RUN_STATUSES as readonly string[]).includes(value);
}

/** 来源名的形状：小写字母开头的短横线标识符（`workflow`、`resume-match-api`）。 */
const SOURCE_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * 受理来源是**读时推导**，不另存一列：这个事实已经在 `imports.invocation` 里，
 * 它同时是专用 GET 核对归属的那份证明，再存一列就是同一事实的第二份表示。
 * coalesce 到 `workflow` 是语义而不是兼容——没有 invocation 的运行只可能是画布发起的。
 */
const RUN_SOURCE = sql<string>`coalesce(json_extract(${runs.imports}, '$.invocation.source'), 'workflow')`;

/** epoch 毫秒整数；空串按「没给」处理，其余非法值让调用方看到 400 而不是被静默忽略。 */
function parseEpochMs(raw: string | null): { ok: true; value: number | null } | { ok: false } {
  if (raw === null || raw.trim() === "") return { ok: true, value: null };
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return { ok: false };
  return { ok: true, value: parsed };
}

/** node_usage 的 token 口径与列表一致：output 已含 reasoning，不再单独加一桶。 */
const USAGE_TOKENS = sql`(
  node_usage.input_tokens + node_usage.output_tokens +
  node_usage.cache_read_tokens + node_usage.cache_write_tokens
)`;

interface SummaryTotalsRow {
  runs: number;
  tokens: number;
  cost: number;
}

interface SummaryModelRow {
  providerId: string | null;
  modelId: string | null;
  tokens: number;
  cost: number;
}

/**
 * GET /api/runs?workflowId=&status=&source=&from=&to=&page=&pageSize=
 *   → { items, total, page, pageSize, summary }
 *
 * 工作流名读 runs.workflowName（运行当时的冗余快照，改名后历史仍可读）；受理来源不是一列，
 * 每次查询从 runs.imports 的 invocation 里 json_extract 推导（见 RUN_SOURCE）；每行的用量 left join
 * run_nodes 求和。summary 按同一组筛选**不分页**聚合：runs 数的是筛选集里 distinct 的运行，
 * 所以零用量的运行（免费的输入→输出工作流、首次模型调用前就失败的运行）也算得上；token 与费用
 * 从按 run_id 预聚合的 node_usage 子查询 left join 过来——内连接会把无用量的运行整行挤掉，
 * 汇总里的运行数就会小于列表的 total。
 */
export async function GET(request: Request) {
  return handle(() => {
    const url = new URL(request.url);
    const query = url.searchParams;

    const workflowId = query.get("workflowId");

    const statusParam = query.get("status");
    let status: RunStatus | undefined;
    if (statusParam) {
      if (!isRunStatus(statusParam)) return jsonError(400, "status 取值非法");
      status = statusParam;
    }

    const sourceParam = query.get("source");
    if (sourceParam !== null && sourceParam !== "" && !SOURCE_PATTERN.test(sourceParam)) {
      return jsonError(400, "source 取值非法");
    }
    const source = sourceParam === null || sourceParam === "" ? undefined : sourceParam;

    const from = parseEpochMs(query.get("from"));
    if (!from.ok) return jsonError(400, "from 必须是 epoch 毫秒整数");
    const to = parseEpochMs(query.get("to"));
    if (!to.ok) return jsonError(400, "to 必须是 epoch 毫秒整数");

    const { page, pageSize } = parsePageQuery(request.url);

    // 时间窗是左闭右开：相邻两天的窗口不会把同一次运行数两遍。
    const filters: SQL[] = [
      workflowId ? eq(runs.workflowId, workflowId) : undefined,
      status ? eq(runs.status, status) : undefined,
      source ? sql`${RUN_SOURCE} = ${source}` : undefined,
      from.value === null ? undefined : gte(runs.startedAt, new Date(from.value)),
      to.value === null ? undefined : lt(runs.startedAt, new Date(to.value)),
    ].filter((f): f is SQL => f !== undefined);
    const where = filters.length > 0 ? and(...filters) : undefined;
    const whereSql = where ? sql`where ${where}` : sql``;

    const total = db.select({ n: count() }).from(runs).where(where).get()?.n ?? 0;

    const items = db
      .select({
        id: runs.id,
        workflowId: runs.workflowId,
        workflowName: runs.workflowName,
        status: runs.status,
        source: RUN_SOURCE,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
        totalTokens: sql<number>`coalesce(sum(
          ${runNodes.inputTokens} + ${runNodes.outputTokens} +
          ${runNodes.cacheReadTokens} + ${runNodes.cacheWriteTokens}
        ), 0)`,
        totalCost: sql<number>`coalesce(sum(${runNodes.cost}), 0)`,
        // 进度：导航「运行中」面板与列表都要展示 N/M 个节点，避免逐运行再打详情接口
        nodesTotal: sql<number>`count(${runNodes.id})`,
        nodesDone: sql<number>`coalesce(sum(case when ${runNodes.status} in ('success', 'failed', 'cancelled', 'skipped') then 1 else 0 end), 0)`,
      })
      .from(runs)
      .leftJoin(runNodes, eq(runNodes.runId, runs.id))
      .where(where)
      .groupBy(runs.id)
      .orderBy(desc(runs.startedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all();

    // 子查询先把 node_usage 收成一行一运行，再 left join；不先收敛的话一次运行的多条用量明细
    // 会把 runs 行复制成多份，count(distinct) 还对但任何非去重统计都会翻倍。
    const totals = db.get<SummaryTotalsRow>(sql`
      select
        count(distinct ${runs.id}) as runs,
        coalesce(sum(u.tokens), 0) as tokens,
        coalesce(sum(u.cost), 0) as cost
      from runs
      left join (
        select run_id,
          sum(${USAGE_TOKENS}) as tokens,
          sum(node_usage.cost) as cost
        from node_usage group by run_id
      ) u on u.run_id = ${runs.id}
      ${whereSql}
    `);

    const byModel = db.all<SummaryModelRow>(sql`
      select
        u.provider_id as providerId,
        u.model_id as modelId,
        coalesce(sum(u.tokens), 0) as tokens,
        coalesce(sum(u.cost), 0) as cost
      from runs
      left join (
        select run_id, provider_id, model_id,
          sum(${USAGE_TOKENS}) as tokens,
          sum(node_usage.cost) as cost
        from node_usage group by run_id, provider_id, model_id
      ) u on u.run_id = ${runs.id}
      ${whereSql}
      group by u.provider_id, u.model_id
      -- left join 让无用量的运行也留在结果里，它们聚成 provider/model 皆空的那一组；
      -- 那一组代表「没有模型调用」，不是一个模型，从按模型的排行里去掉。
      having u.provider_id is not null
      order by cost desc, tokens desc
    `);

    return NextResponse.json({
      items,
      total,
      page,
      pageSize,
      summary: {
        runs: totals?.runs ?? 0,
        tokens: totals?.tokens ?? 0,
        cost: totals?.cost ?? 0,
        byModel: byModel.map((row) => ({
          providerId: row.providerId ?? "",
          modelId: row.modelId ?? "",
          tokens: row.tokens,
          cost: row.cost,
        })),
      },
    });
  });
}
