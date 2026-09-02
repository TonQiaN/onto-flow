/**
 * 监控页的聚合查询层。
 *
 * 原则：**能在 sqlite 里算完就不要把行拉进内存**——总览/成本/日志全部走聚合 SQL 与
 * 游标分页；只有 Trace（单次运行）才把该运行的事件读全，因为要推导 span 树。
 * 所有时间字段出口统一为 epoch 毫秒（见 ./types.ts 的约定）。
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import type {
  CostByAction,
  CostByModel,
  CostByWorkflow,
  CostDailyPoint,
  CostPayload,
  LiveSession,
  LogItem,
  LogsPayload,
  LogsQuery,
  MonitorOverview,
  NodeStatus,
  OverviewPoint,
  RunStatus,
  SessionActivity,
  SessionsPayload,
  TracePayload,
  TraceSpan,
} from "./types";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

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

/** 本地日期 YYYY-MM-DD */
function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
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
  const activityByNode = new Map(
    activities.map((a) => [`${a.runId} ${a.nodeId ?? ""}`, a]),
  );

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
      model:
        row.displayName ||
        [row.providerId, row.modelId].filter(Boolean).join("/"),
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

// ============================================================ Trace

interface TraceRunRow {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

interface TraceNodeRow {
  nodeId: string;
  label: string;
  status: string;
  sessionId: string | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  tokens: number;
  cost: number;
  actionName: string;
  model: string;
  variant: string;
}

interface TraceEventRow {
  id: number;
  nodeId: string | null;
  ts: number;
  type: string;
  payload: string | null;
}

interface TraceUsageRow {
  nodeId: string;
  ts: number;
  tokens: number;
  cost: number;
}

/**
 * 把一次运行摊平成 span 树：run 根 → 每个 run_node → 该节点的 session →
 * session 内的 step（由 run_events 推导）。
 *
 * step 的推导规则（run_events 只有 text|tool|session.error|session.idle 四类）：
 * - 节点开始到首条事件之间 → 「会话准备与上下文注入」（覆盖建会话、noReply 注入规则技能、发 prompt）；
 * - tool 事件按 callId 聚合成一个 span（状态取最后一次更新）；
 * - 连续的 text 事件合成一个「模型输出」span，session.idle 作为回合分界，
 *   第二回合起标注「JSON 解析重试」——引擎对结构化输出解析失败时正是同会话再发一轮 prompt；
 * - session.error 单独成一个失败 span。
 * 每个回合的 node_usage 归到该回合的模型输出 span 上（父级 node span 仍是全量合计）；
 * 整个节点一条 text 事件都没有时（首轮就报错等），补一个「模型调用（无文本输出）」span
 * 承接全部用量——各 step 用量之和恒等于 node 合计是硬承诺，不允许有 token 落不到 step 上。
 */
export function getTrace(runId: string): TracePayload | null {
  const run = db.get<TraceRunRow>(sql`
    select id, workflow_id as workflowId, workflow_name as workflowName,
      status, error, started_at as startedAt, finished_at as finishedAt
    from runs where id = ${runId}
  `);
  if (!run) return null;

  const nodes = db.all<TraceNodeRow>(sql`
    select
      run_nodes.node_id as nodeId, run_nodes.label as label, run_nodes.status as status,
      run_nodes.session_id as sessionId, run_nodes.error as error,
      run_nodes.started_at as startedAt, run_nodes.finished_at as finishedAt,
      ${NODE_TOKENS} as tokens, run_nodes.cost as cost,
      coalesce(json_extract(run_nodes.snapshot, '$.actionName'), '') as actionName,
      coalesce(json_extract(run_nodes.snapshot, '$.model.displayName'), '') as model,
      coalesce(json_extract(run_nodes.snapshot, '$.reasoningEffort'), '') as variant
    from run_nodes where run_nodes.run_id = ${runId}
    order by coalesce(run_nodes.started_at, 9223372036854775807) asc
  `);

  const events = db.all<TraceEventRow>(sql`
    select id, node_id as nodeId, ts, type, payload
    from run_events where run_id = ${runId} order by id asc
  `);

  const usage = db.all<TraceUsageRow>(sql`
    select node_id as nodeId, node_usage.ts as ts,
      ${USAGE_TOKENS} as tokens, node_usage.cost as cost
    from node_usage where run_id = ${runId} order by node_usage.ts asc
  `);

  const now = Date.now();
  const runStart = num(run.startedAt);
  const runEnd = run.finishedAt == null ? now : num(run.finishedAt);

  const eventsByNode = new Map<string, TraceEventRow[]>();
  for (const ev of events) {
    const key = ev.nodeId ?? "";
    const list = eventsByNode.get(key);
    if (list) list.push(ev);
    else eventsByNode.set(key, [ev]);
  }
  const usageByNode = new Map<string, TraceUsageRow[]>();
  for (const u of usage) {
    const list = usageByNode.get(u.nodeId);
    if (list) list.push(u);
    else usageByNode.set(u.nodeId, [u]);
  }

  const totalTokens = nodes.reduce((sum, n) => sum + num(n.tokens), 0);
  const totalCost = nodes.reduce((sum, n) => sum + num(n.cost), 0);

  const rootId = `run:${run.id}`;
  const spans: TraceSpan[] = [
    {
      id: rootId,
      parentId: null,
      kind: "run",
      label: run.workflowName || "（未命名工作流）",
      startMs: 0,
      durMs: Math.max(0, runEnd - runStart),
      status: run.status as RunStatus,
      tokens: totalTokens,
      cost: totalCost,
      detail: run.error ?? "",
    },
  ];

  for (const node of nodes) {
    const nodeSpanId = `node:${node.nodeId}`;
    const nodeStart = node.startedAt == null ? runStart : num(node.startedAt);
    const nodeEnd = node.finishedAt == null ? now : num(node.finishedAt);
    const started = node.startedAt != null;

    spans.push({
      id: nodeSpanId,
      parentId: rootId,
      kind: "node",
      label: node.label,
      startMs: Math.max(0, nodeStart - runStart),
      durMs: started ? Math.max(0, nodeEnd - nodeStart) : 0,
      status: node.status as NodeStatus,
      tokens: num(node.tokens),
      cost: num(node.cost),
      detail: node.error ?? node.actionName,
    });

    if (!node.sessionId) continue;

    // 会话可能比节点「活得久」：取消运行时节点立刻标 cancelled，事件泵却还在收尾
    // （最后几段 text 仍会落库）。session span 因此按最后一条事件收口，
    // 保证它的 step 子 span 不会溢出父区间。
    const nodeEvents = eventsByNode.get(node.nodeId) ?? [];
    const lastEventTs =
      nodeEvents.length > 0 ? num(nodeEvents[nodeEvents.length - 1].ts) : 0;
    const sessionEnd = Math.max(nodeEnd, lastEventTs);

    const sessionSpanId = `session:${node.nodeId}`;
    spans.push({
      id: sessionSpanId,
      parentId: nodeSpanId,
      kind: "session",
      label: node.sessionId,
      startMs: Math.max(0, nodeStart - runStart),
      durMs: started ? Math.max(0, sessionEnd - nodeStart) : 0,
      status: node.status as NodeStatus,
      tokens: num(node.tokens),
      cost: num(node.cost),
      detail: [node.model, node.variant].filter(Boolean).join(" · "),
    });

    spans.push(
      ...buildStepSpans({
        parentId: sessionSpanId,
        nodeId: node.nodeId,
        nodeStart,
        sessionEnd,
        runStart,
        events: nodeEvents,
        usage: usageByNode.get(node.nodeId) ?? [],
      }),
    );
  }

  return {
    run: {
      id: run.id,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      status: run.status as RunStatus,
      error: run.error,
      startedAt: runStart,
      finishedAt: run.finishedAt == null ? null : num(run.finishedAt),
      tokens: totalTokens,
      cost: totalCost,
    },
    spans,
  };
}

interface StepContext {
  parentId: string;
  nodeId: string;
  nodeStart: number;
  /** 父 session span 的收口时刻，用来把兜底 span 夹在父区间内 */
  sessionEnd: number;
  runStart: number;
  events: TraceEventRow[];
  usage: TraceUsageRow[];
}

interface ToolAcc {
  tool: string;
  start: number;
  end: number;
  status: string;
  detail: string;
}

interface TextAcc {
  start: number;
  end: number;
  chars: number;
  head: string;
}

function buildStepSpans(ctx: StepContext): TraceSpan[] {
  const { events, nodeId, nodeStart, runStart, parentId } = ctx;
  const spans: TraceSpan[] = [];
  let seq = 0;
  const nextId = () => `step:${nodeId}:${seq++}`;

  // 没有事件也可能有用量（首轮就报错、或事件泵没收到 text 就断了），
  // 这时仍要往下走去补承接 span，否则这些 token 会凭空消失
  if (events.length === 0 && ctx.usage.length === 0) return spans;

  const first = events[0];
  const firstTs = first ? num(first.ts) : nodeStart;
  if (first && firstTs > nodeStart) {
    spans.push({
      id: nextId(),
      parentId,
      kind: "step",
      label: "会话准备与上下文注入",
      startMs: Math.max(0, nodeStart - runStart),
      durMs: Math.max(0, firstTs - nodeStart),
      status: "success",
      tokens: 0,
      cost: 0,
      detail: "建会话、物化工具与输入文件、noReply 注入规则与技能、发送正式 prompt",
    });
  }

  const tools = new Map<string, ToolAcc>();
  const toolOrder: string[] = [];
  /** 模型输出 span 在 spans 里的下标（按出现顺序），用来回填每一轮的用量 */
  const outputSpans: Array<{ index: number; start: number }> = [];
  let acc: TextAcc | null = null;

  const flushText = () => {
    if (!acc) return;
    const round = outputSpans.length;
    const index = spans.length;
    spans.push({
      id: nextId(),
      parentId,
      kind: "step",
      // 第二轮起必定是引擎的 JSON 解析重试：同会话再发一条要求纯 JSON 的 prompt
      label: round === 0 ? "模型输出" : `模型输出（第 ${round + 1} 轮 · JSON 解析重试）`,
      startMs: Math.max(0, acc.start - runStart),
      durMs: Math.max(0, acc.end - acc.start),
      status: "success",
      tokens: 0,
      cost: 0,
      detail: `${acc.chars} 字 · ${clip(acc.head, 120)}`,
    });
    outputSpans.push({ index, start: acc.start });
    acc = null;
  };

  for (const ev of events) {
    const ts = num(ev.ts);
    const payload = parsePayload(ev.payload);
    if (ev.type === "text") {
      const body = text(payload?.text);
      if (!acc) acc = { start: ts, end: ts, chars: 0, head: body };
      acc.end = ts;
      acc.chars += body.length;
      continue;
    }
    // 工具事件不切断文本分组：一次模型回合里本来就可能「说几句 → 调工具 → 接着说」，
    // 切断会把同一回合的输出误标成「降级重试」。只有 idle / error 才是回合边界。
    if (ev.type === "tool") {
      // events.ts 写的是 callId；曾拼成 callID，同一次工具调用的 running/ok 永远合不成一个 span。
      const callId = text(payload?.callId) || `${ev.id}`;
      const status = text(payload?.status) || "pending";
      const existing = tools.get(callId);
      const detail =
        text(payload?.title) ||
        clip(text(payload?.input) || text(payload?.output), 120);
      if (existing) {
        existing.end = ts;
        existing.status = status;
        if (detail) existing.detail = detail;
      } else {
        tools.set(callId, {
          tool: text(payload?.tool) || "tool",
          start: ts,
          end: ts,
          status,
          detail,
        });
        toolOrder.push(callId);
      }
      continue;
    }
    if (ev.type === "session.error") {
      flushText();
      spans.push({
        id: nextId(),
        parentId,
        kind: "step",
        label: "会话错误",
        startMs: Math.max(0, ts - runStart),
        durMs: 0,
        status: "failed",
        tokens: 0,
        cost: 0,
        detail: clip(errorText(payload?.error), 200),
      });
      continue;
    }
    // session.idle 是回合结束的可靠信号：本身不成 span，只用来收口当前的模型输出分组
    if (ev.type === "session.idle") flushText();
  }
  flushText();

  for (const callId of toolOrder) {
    const t = tools.get(callId);
    if (!t) continue;
    spans.push({
      id: `step:${nodeId}:tool:${callId}`,
      parentId,
      kind: "step",
      label: `工具 ${t.tool}`,
      startMs: Math.max(0, t.start - runStart),
      durMs: Math.max(0, t.end - t.start),
      status: t.status === "error" ? "failed" : t.status === "completed" ? "success" : "running",
      tokens: 0,
      cost: 0,
      detail: t.detail,
    });
  }

  // 用量归集：每条 assistant 消息（node_usage 一行）归给「开始时间不晚于它的最后一个模型输出
  // span」——消息完成时刻总在这一轮文本产出之后。这样各 step 的用量之和恒等于 node 的合计，
  // 不会有 token 凭空消失。
  if (outputSpans.length > 0) {
    for (const u of ctx.usage) {
      const ts = num(u.ts);
      let target = outputSpans[0];
      for (const candidate of outputSpans) {
        if (candidate.start <= ts) target = candidate;
      }
      const span = spans[target.index];
      span.tokens += num(u.tokens);
      span.cost += num(u.cost);
    }
  } else if (ctx.usage.length > 0) {
    // 一条 text 事件都没有（例如首轮就 session.error）→ 没有模型输出 span 可承接。
    // 直接丢弃会让「各 step 用量之和恒等于 node 合计」的承诺失效，所以补一个覆盖整段的
    // 模型调用 span 把这些用量兜住；末端夹到 session span 的收口时刻，不溢出父区间。
    let tokens = 0;
    let cost = 0;
    let lastTs = nodeStart;
    for (const u of ctx.usage) {
      tokens += num(u.tokens);
      cost += num(u.cost);
      lastTs = Math.max(lastTs, num(u.ts));
    }
    spans.push({
      id: nextId(),
      parentId,
      kind: "step",
      label: "模型调用（无文本输出）",
      startMs: Math.max(0, nodeStart - runStart),
      durMs: Math.max(0, Math.min(lastTs, ctx.sessionEnd) - nodeStart),
      status: "success",
      tokens,
      cost,
      detail: `${ctx.usage.length} 条 assistant 消息计费，但会话未产出文本`,
    });
  }

  spans.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
  return spans;
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
  const limit = Math.min(
    Math.max(1, Math.trunc(query.limit ?? LOG_LIMIT_DEFAULT)),
    LOG_LIMIT_MAX,
  );

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
    conds.push(
      sql`run_events.payload like ${`%${escapeLike(query.q)}%`} escape '\\'`,
    );
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
  const where =
    conds.length > 0 ? sql` where ${sql.join(conds, sql` and `)}` : sql.empty();

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
  const nextCursor =
    items.length === limit && items.length > 0
      ? items[items.length - 1].id
      : null;
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
  const row = db.get<{ maxId: number | null }>(
    sql`select max(id) as maxId from run_events`,
  );
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

// ============================================================ 成本分析

const COST_DAYS_DEFAULT = 7;
const COST_DAYS_MAX = 90;

/**
 * 成本分析**只读 node_usage**（逐条 assistant 消息的真实用量）。
 *
 * 四张表（byModel / byAction / byWorkflow / daily）必须共用同一个窗口谓词
 * `node_usage.ts >= since`：曾经 byAction/byWorkflow 改用 `runs.started_at >= since`
 * 过滤 run_nodes 汇总列，同一页的合计互相对不上——跨零点的长运行会被整段算进运行开始
 * 那一天，而 byModel/daily 按消息时间拆到两天。所以 byAction/byWorkflow 也从 node_usage
 * 出发，join run_nodes / runs 只为取归集维度（actionName / workflowName），不取用量列。
 *
 * byAction 的 actionName 从 run_nodes.snapshot 里 json_extract——Action 改名或删除后，
 * 历史成本仍按当时的名字归集。
 */
export function getCost(daysInput?: number): CostPayload {
  const days = Math.min(
    Math.max(1, Math.trunc(daysInput ?? COST_DAYS_DEFAULT)),
    COST_DAYS_MAX,
  );
  const since = startOfDay(Date.now()) - (days - 1) * DAY_MS;

  const byModel = db.all<CostByModel>(sql`
    select
      node_usage.model_id as modelId,
      node_usage.provider_id as providerId,
      count(*) as messages,
      coalesce(sum(${USAGE_TOKENS}), 0) as tokens,
      coalesce(sum(node_usage.cost), 0) as cost
    from node_usage where node_usage.ts >= ${since}
    group by node_usage.provider_id, node_usage.model_id
    order by cost desc, tokens desc
  `);

  // nodes = 窗口内产生过用量的节点执行次数（run_id + node_id 去重），不是 node_usage 行数
  const byAction = db.all<CostByAction>(sql`
    select
      json_extract(run_nodes.snapshot, '$.actionName') as actionName,
      count(distinct node_usage.run_id || ' ' || node_usage.node_id) as nodes,
      coalesce(sum(${USAGE_TOKENS}), 0) as tokens,
      coalesce(sum(node_usage.cost), 0) as cost
    from node_usage
    join run_nodes
      on run_nodes.run_id = node_usage.run_id and run_nodes.node_id = node_usage.node_id
    where node_usage.ts >= ${since}
      and json_extract(run_nodes.snapshot, '$.actionName') is not null
    group by actionName
    order by cost desc, tokens desc
  `);

  // runs = 窗口内产生过用量的运行数；空跑（一条 assistant 消息都没有）本就 0 成本，不列
  const byWorkflow = db.all<CostByWorkflow>(sql`
    select
      runs.workflow_name as workflowName,
      count(distinct node_usage.run_id) as runs,
      coalesce(sum(${USAGE_TOKENS}), 0) as tokens,
      coalesce(sum(node_usage.cost), 0) as cost
    from node_usage
    join runs on runs.id = node_usage.run_id
    where node_usage.ts >= ${since}
    group by runs.workflow_name
    order by cost desc, runs desc
  `);

  const dailyRows = db.all<BucketRow>(sql`
    select
      cast((node_usage.ts - ${since}) / ${DAY_MS} as integer) as bucket,
      coalesce(sum(${USAGE_TOKENS}), 0) as a,
      coalesce(sum(node_usage.cost), 0) as b
    from node_usage where node_usage.ts >= ${since}
    group by bucket
  `);
  const dailyByBucket = new Map(dailyRows.map((r) => [num(r.bucket), r]));
  const daily: CostDailyPoint[] = [];
  for (let i = 0; i < days; i++) {
    const dayMs = since + i * DAY_MS;
    const row = dailyByBucket.get(i);
    daily.push({
      dayISO: localDay(dayMs),
      tokens: num(row?.a),
      cost: num(row?.b),
    });
  }

  return {
    days,
    since,
    byModel: byModel.map((r) => ({
      modelId: r.modelId ?? "",
      providerId: r.providerId ?? "",
      messages: num(r.messages),
      tokens: num(r.tokens),
      cost: num(r.cost),
    })),
    byAction: byAction.map((r) => ({
      actionName: r.actionName ?? "",
      nodes: num(r.nodes),
      tokens: num(r.tokens),
      cost: num(r.cost),
    })),
    byWorkflow: byWorkflow.map((r) => ({
      workflowName: r.workflowName || "（未命名工作流）",
      runs: num(r.runs),
      tokens: num(r.tokens),
      cost: num(r.cost),
    })),
    daily,
  };
}
