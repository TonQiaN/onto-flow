/**
 * 监控页的聚合查询层。
 *
 * 原则：**能在 sqlite 里算完就不要把行拉进内存**——总览与日志全部走聚合 SQL 与
 * 游标分页，一行都不多拉。
 * 所有时间字段出口统一为 epoch 毫秒（见 ./types.ts 的约定）。
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import type {
  LiveSession,
  LogItem,
  LogsPayload,
  LogsQuery,
  MonitorOverview,
  NodeStatus,
  OverviewPoint,
  SessionActivity,
  SessionsPayload,
} from "./types";

const HOUR_MS = 3_600_000;

/** output 已含 reasoning；总量只加 input/output/cacheRead/cacheWrite。 */
const NODE_TOKENS = sql`(
  run_nodes.input_tokens + run_nodes.output_tokens +
  run_nodes.cache_read_tokens + run_nodes.cache_write_tokens
)`;
const USAGE_TOKENS = sql`(
  node_usage.input_tokens + node_usage.output_tokens +
  node_usage.cache_read_tokens + node_usage.cache_write_tokens
)`;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfHour(ms: number): number {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

/** 本地时区的 ISO 串（保留偏移量，前端当作 x 轴标签直接用） */
function localISO(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:00` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** 事件 payload 在 raw SQL 里回来的是字符串，统一解析（坏数据不抛错） */
function parsePayload(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// ============================================================ 总览

interface LiveRow {
  activeRuns: number;
  activeSessions: number;
  runningNodes: number;
}

interface TodayRunRow {
  runs: number;
  success: number;
  failed: number;
  cancelled: number;
}

interface BucketRow {
  bucket: number;
  a: number;
  b: number;
}

export function getOverview(): MonitorOverview {
  const now = Date.now();
  const todayStart = startOfDay(now);
  const hourAgo = now - HOUR_MS;
  // 近 24 小时 = 当前整点往前数 23 个整点（共 24 个桶）
  const base = startOfHour(now) - 23 * HOUR_MS;

  const live = db.get<LiveRow>(sql`
    select
      (select count(*) from runs where status = 'running') as activeRuns,
      (select count(*) from run_nodes
        where status = 'running' and session_id is not null and session_id <> ''
      ) as activeSessions,
      (select count(*) from run_nodes where status = 'running') as runningNodes
  `);

  const todayRuns = db.get<TodayRunRow>(sql`
    select
      count(*) as runs,
      coalesce(sum(case when status = 'success' then 1 else 0 end), 0) as success,
      coalesce(sum(case when status = 'failed' then 1 else 0 end), 0) as failed,
      coalesce(sum(case when status = 'cancelled' then 1 else 0 end), 0) as cancelled
    from runs where started_at >= ${todayStart}
  `);

  // 用量按 node_usage 的消息时间归集（而不是运行开始时间），跨零点的长运行才不会记错日子
  const todayUsage = db.get<{ tokens: number; cost: number }>(sql`
    select
      coalesce(sum(${USAGE_TOKENS}), 0) as tokens,
      coalesce(sum(node_usage.cost), 0) as cost
    from node_usage where node_usage.ts >= ${todayStart}
  `);

  const avgNode = db.get<{ seconds: number }>(sql`
    select coalesce(avg((finished_at - started_at) / 1000.0), 0) as seconds
    from run_nodes
    where started_at is not null and finished_at is not null
      and finished_at >= started_at and started_at >= ${todayStart}
  `);

  const errors = db.get<{ total: number }>(sql`
    select
      (select count(*) from run_events where type = 'session.error' and ts >= ${hourAgo})
      +
      (select count(*) from run_nodes
        where status = 'failed' and finished_at is not null and finished_at >= ${hourAgo}
      ) as total
  `);

  const runBuckets = db.all<BucketRow>(sql`
    select
      cast((started_at - ${base}) / ${HOUR_MS} as integer) as bucket,
      count(*) as a,
      coalesce(sum(case when status = 'failed' then 1 else 0 end), 0) as b
    from runs where started_at >= ${base}
    group by bucket
  `);

  const usageBuckets = db.all<BucketRow>(sql`
    select
      cast((node_usage.ts - ${base}) / ${HOUR_MS} as integer) as bucket,
      coalesce(sum(${USAGE_TOKENS}), 0) as a,
      coalesce(sum(node_usage.cost), 0) as b
    from node_usage where node_usage.ts >= ${base}
    group by bucket
  `);

  const runByBucket = new Map(runBuckets.map((r) => [num(r.bucket), r]));
  const usageByBucket = new Map(usageBuckets.map((r) => [num(r.bucket), r]));

  const series: OverviewPoint[] = [];
  for (let i = 0; i < 24; i++) {
    const hourMs = base + i * HOUR_MS;
    const r = runByBucket.get(i);
    const u = usageByBucket.get(i);
    series.push({
      hourISO: localISO(hourMs),
      hourMs,
      runs: num(r?.a),
      failed: num(r?.b),
      tokens: num(u?.a),
      cost: num(u?.b),
    });
  }

  return {
    live: {
      activeRuns: num(live?.activeRuns),
      activeSessions: num(live?.activeSessions),
      runningNodes: num(live?.runningNodes),
    },
    today: {
      runs: num(todayRuns?.runs),
      success: num(todayRuns?.success),
      failed: num(todayRuns?.failed),
      cancelled: num(todayRuns?.cancelled),
      tokens: num(todayUsage?.tokens),
      cost: num(todayUsage?.cost),
      avgNodeSeconds: Math.round(num(avgNode?.seconds) * 10) / 10,
    },
    lastHourErrors: num(errors?.total),
    series,
  };
}

// ============================================================ 实时会话

interface SessionRow {
  sessionId: string;
  runId: string;
  nodeId: string;
  nodeLabel: string;
  workflowName: string;
  actionName: string;
  displayName: string;
  providerId: string;
  modelId: string;
  variant: string;
  status: string;
  startedAt: number | null;
  tokens: number;
  cost: number;
}

interface ActivityRow {
  runId: string;
  nodeId: string | null;
  ts: number;
  type: string;
  payload: string | null;
}

/**
 * 活跃会话 = run_nodes.status='running' 且 sessionId 非空。
 * lastActivity 取该节点最近一条 run_events（一次子查询取每个节点的最大 id，不做 N+1）。
 */
export function getLiveSessions(): SessionsPayload {
  const rows = db.all<SessionRow>(sql`
    select
      run_nodes.session_id as sessionId,
      run_nodes.run_id as runId,
      run_nodes.node_id as nodeId,
      run_nodes.label as nodeLabel,
      coalesce(runs.workflow_name, '') as workflowName,
      coalesce(json_extract(run_nodes.snapshot, '$.actionName'), '') as actionName,
      coalesce(json_extract(run_nodes.snapshot, '$.model.displayName'), '') as displayName,
      coalesce(json_extract(run_nodes.snapshot, '$.model.providerId'), '') as providerId,
      coalesce(json_extract(run_nodes.snapshot, '$.model.modelId'), '') as modelId,
      coalesce(json_extract(run_nodes.snapshot, '$.reasoningEffort'), '') as variant,
      run_nodes.status as status,
      run_nodes.started_at as startedAt,
      ${NODE_TOKENS} as tokens,
      run_nodes.cost as cost
    from run_nodes
    join runs on runs.id = run_nodes.run_id
    where run_nodes.status = 'running'
      and run_nodes.session_id is not null and run_nodes.session_id <> ''
    order by run_nodes.started_at asc
  `);

  if (rows.length === 0) return { items: [] };

  const activities = db.all<ActivityRow>(sql`
    select run_id as runId, node_id as nodeId, ts, type, payload
    from run_events
    where id in (
      select max(id) from run_events
      where run_id in (
        select run_id from run_nodes
        where status = 'running' and session_id is not null and session_id <> ''
      )
      group by run_id, node_id
    )
  `);
  const activityByNode = new Map(activities.map((a) => [`${a.runId} ${a.nodeId ?? ""}`, a]));

  const now = Date.now();
  const items: LiveSession[] = rows.map((row) => {
    const startedAt = num(row.startedAt);
    const activity = activityByNode.get(`${row.runId} ${row.nodeId}`);
    return {
      sessionId: row.sessionId,
      runId: row.runId,
      nodeId: row.nodeId,
      nodeLabel: row.nodeLabel,
      workflowName: row.workflowName,
      actionName: row.actionName,
      model: row.displayName || [row.providerId, row.modelId].filter(Boolean).join("/"),
      variant: row.variant,
      status: row.status as NodeStatus,
      startedAt,
      elapsedMs: startedAt > 0 ? Math.max(0, now - startedAt) : 0,
      tokens: num(row.tokens),
      cost: num(row.cost),
      lastActivity: activity ? summarizeActivity(activity) : null,
    };
  });

  return { items };
}

/** 事件 → 一行摘要：tool 取工具名与状态，text 取尾部 60 字 */
function summarizeActivity(row: ActivityRow): SessionActivity {
  const payload = parsePayload(row.payload);
  const ts = num(row.ts);
  if (row.type === "tool") {
    const tool = text(payload?.tool) || "工具";
    const status = text(payload?.status) || "pending";
    const title = text(payload?.title);
    return {
      type: "tool",
      ts,
      text: title ? `${tool} · ${status} · ${clip(title, 40)}` : `${tool} · ${status}`,
    };
  }
  if (row.type === "text") {
    const body = text(payload?.text);
    const tail = body.replace(/\s+/g, " ").trim().slice(-60);
    return { type: "text", ts, text: tail };
  }
  if (row.type === "session.error") {
    return { type: "session.error", ts, text: clip(errorText(payload?.error), 60) };
  }
  if (row.type === "session.idle") {
    return { type: "session.idle", ts, text: "会话空闲" };
  }
  return { type: row.type, ts, text: clip(JSON.stringify(payload ?? {}), 60) };
}

function errorText(value: unknown): string {
  if (value == null) return "未知错误";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const data = o.data as Record<string, unknown> | undefined;
    const message = text(o.message) || text(data?.message) || text(o.name);
    if (message) return message;
  }
  try {
    return JSON.stringify(value) ?? "未知错误";
  } catch {
    return "未知错误";
  }
}

// ============================================================ 日志检索

interface LogRow {
  id: number;
  runId: string;
  nodeId: string | null;
  ts: number;
  type: string;
  payload: string | null;
  nodeLabel: string;
  workflowName: string;
}

const LOG_LIMIT_DEFAULT = 100;
const LOG_LIMIT_MAX = 500;

/**
 * LIKE 的通配符转义：`%` 与 `_` 在 LIKE 里是通配符，不转义的话搜 `save_purchase_plan`
 * 会把下划线当「任意单字符」，命中一大片无关事件。转义符本身（反斜杠）要先转义。
 * 与 `@/server/writers/list.ts` 的 escapeLike 同款处理，配套 `escape '\'` 子句使用。
 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * 事件类型过滤支持逗号分隔多值（如 `text,tool`）：多选时在同一条 SQL 里用 in 过滤，
 * 单一游标返回。前端不得为多选各开一条流再归并——那样各流分页深度不一致，
 * 会让人误判某类事件「不存在」。
 */
function parseTypes(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set(
    raw
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== ""),
  );
  return [...seen];
}

/** 按 id 倒序 + 游标分页；q 匹配 payload 文本（sqlite LIKE 对 ASCII 大小写不敏感） */
export function getLogs(query: LogsQuery): LogsPayload {
  const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? LOG_LIMIT_DEFAULT)), LOG_LIMIT_MAX);

  const conds: SQL[] = [];
  if (query.runId) conds.push(sql`run_events.run_id = ${query.runId}`);
  if (query.nodeId) conds.push(sql`run_events.node_id = ${query.nodeId}`);
  const types = parseTypes(query.type);
  if (types.length === 1) {
    conds.push(sql`run_events.type = ${types[0]}`);
  } else if (types.length > 1) {
    conds.push(
      sql`run_events.type in (${sql.join(
        types.map((t) => sql`${t}`),
        sql`, `,
      )})`,
    );
  }
  if (query.q) {
    conds.push(sql`run_events.payload like ${`%${escapeLike(query.q)}%`} escape '\\'`);
  }
  if (query.onlyErrors) {
    conds.push(sql`(
      run_events.type = 'session.error'
      or (run_events.type = 'tool' and json_extract(run_events.payload, '$.status') = 'error')
      or (run_events.type = 'compaction' and json_extract(run_events.payload, '$.status') = 'error')
    )`);
  }
  if (query.cursor != null && Number.isFinite(query.cursor)) {
    conds.push(sql`run_events.id < ${Math.trunc(query.cursor)}`);
  }
  const where = conds.length > 0 ? sql` where ${sql.join(conds, sql` and `)}` : sql.empty();

  const rows = db.all<LogRow>(sql`
    select
      run_events.id as id, run_events.run_id as runId, run_events.node_id as nodeId,
      run_events.ts as ts, run_events.type as type, run_events.payload as payload,
      coalesce(run_nodes.label, '') as nodeLabel,
      coalesce(runs.workflow_name, '') as workflowName
    from run_events
    left join runs on runs.id = run_events.run_id
    left join run_nodes
      on run_nodes.run_id = run_events.run_id and run_nodes.node_id = run_events.node_id
    ${where}
    order by run_events.id desc
    limit ${limit}
  `);

  const items = rows.map(toLogItem);
  const nextCursor = items.length === limit && items.length > 0 ? items[items.length - 1].id : null;
  return { items, nextCursor };
}

/** 全局 SSE 用：取 afterId 之后的新事件（正序，最多 limit 条） */
export function getLogsAfter(afterId: number, limit = 50): LogItem[] {
  const rows = db.all<LogRow>(sql`
    select
      run_events.id as id, run_events.run_id as runId, run_events.node_id as nodeId,
      run_events.ts as ts, run_events.type as type, run_events.payload as payload,
      coalesce(run_nodes.label, '') as nodeLabel,
      coalesce(runs.workflow_name, '') as workflowName
    from run_events
    left join runs on runs.id = run_events.run_id
    left join run_nodes
      on run_nodes.run_id = run_events.run_id and run_nodes.node_id = run_events.node_id
    where run_events.id > ${afterId}
    order by run_events.id asc
    limit ${Math.min(Math.max(1, Math.trunc(limit)), LOG_LIMIT_MAX)}
  `);
  return rows.map(toLogItem);
}

/** 当前最大事件 id（SSE 连接时定基线，避免把历史全推一遍） */
export function getMaxEventId(): number {
  const row = db.get<{ maxId: number | null }>(sql`select max(id) as maxId from run_events`);
  return num(row?.maxId);
}

function toLogItem(row: LogRow): LogItem {
  return {
    id: num(row.id),
    runId: row.runId,
    nodeId: row.nodeId,
    ts: num(row.ts),
    type: row.type,
    payload: parsePayload(row.payload),
    nodeLabel: row.nodeLabel,
    workflowName: row.workflowName,
  };
}
