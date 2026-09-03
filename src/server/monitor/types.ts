/**
 * 监控页（阶段三）服务端与前端共用的载荷类型。
 *
 * 约定：**所有时间字段一律是 epoch 毫秒数（number）**，不是 Date 也不是 ISO 串——
 * 服务层在返回前统一归一，前端可直接丢给 `@/app/runs/lib` 的
 * `formatDateTime` / `formatClock` / `formatDuration`，无需再过 `toMillis`。
 * 例外只有显式带 `ISO` 后缀的分桶键（`hourISO` / `dayISO`），那是给图表当 x 轴标签用的。
 *
 * token 口径与运行历史页一致：output 已含 reasoning，总量只加
 * input/output/cacheRead/cacheWrite；reasoning 仅作为 output 的拆分明细展示。
 */
import type { NodeStatus, RunStatus } from "@/app/runs/lib";

export type { NodeStatus, RunStatus };

// ---------------- 总览 ----------------

/** 此刻正在发生的事（每次请求实时数） */
export interface OverviewLive {
  /** runs.status='running' */
  activeRuns: number;
  /** run_nodes.status='running' 且有 sessionId */
  activeSessions: number;
  /** run_nodes.status='running' */
  runningNodes: number;
}

/** 今天（本地零点起）的汇总 */
export interface OverviewToday {
  runs: number;
  success: number;
  failed: number;
  cancelled: number;
  tokens: number;
  cost: number;
  /** 今日已结束节点的平均耗时（秒，一位小数） */
  avgNodeSeconds: number;
}

/** 近 24 小时的每小时分桶点（缺失小时补 0） */
export interface OverviewPoint {
  /** 该小时起点的 ISO 串（含时区偏移，桶按本地整点对齐） */
  hourISO: string;
  /** 桶起点的 epoch 毫秒，方便前端直接格式化 */
  hourMs: number;
  runs: number;
  failed: number;
  tokens: number;
  cost: number;
}

export interface MonitorOverview {
  live: OverviewLive;
  today: OverviewToday;
  /** 近一小时的错误数：session.error 事件 + 该时段内失败的节点 */
  lastHourErrors: number;
  series: OverviewPoint[];
}

// ---------------- 实时会话 ----------------

/** 会话最近一条事件的摘要（tool 取工具名与状态，text 取尾部 60 字） */
export interface SessionActivity {
  type: string;
  text: string;
  /** 事件时间（epoch 毫秒） */
  ts: number;
}

export interface LiveSession {
  sessionId: string;
  runId: string;
  nodeId: string;
  nodeLabel: string;
  workflowName: string;
  /** 取自 run_nodes.snapshot.actionName，无快照时为空串 */
  actionName: string;
  /** 快照里的模型展示名（退化为 providerId/modelId） */
  model: string;
  /** 思考强度档位（快照的 reasoningEffort） */
  variant: string;
  status: NodeStatus;
  /** epoch 毫秒；理论上活跃会话一定有开始时间，异常数据兜底为 0 */
  startedAt: number;
  elapsedMs: number;
  tokens: number;
  cost: number;
  lastActivity: SessionActivity | null;
}

export interface SessionsPayload {
  items: LiveSession[];
}

// ---------------- Trace ----------------

export type SpanKind = "run" | "node" | "session" | "step";

/** span 状态：复用节点状态词，外加 step 专用的 running/success/failed */
export type SpanStatus = NodeStatus | RunStatus;

export interface TraceSpan {
  id: string;
  parentId: string | null;
  kind: SpanKind;
  label: string;
  /** 相对 run.startedAt 的毫秒偏移 */
  startMs: number;
  durMs: number;
  status: SpanStatus;
  tokens: number;
  cost: number;
  /** 一行补充说明（错误信息、工具入参摘要、模型名等） */
  detail: string;
}

export interface TraceRunInfo {
  id: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  tokens: number;
  cost: number;
}

export interface TracePayload {
  run: TraceRunInfo;
  spans: TraceSpan[];
}

// ---------------- 日志检索 ----------------

export interface LogItem {
  id: number;
  runId: string;
  nodeId: string | null;
  /** epoch 毫秒 */
  ts: number;
  /** text | tool | session.error | session.idle */
  type: string;
  payload: Record<string, unknown> | null;
  /** 冗余：该事件所属节点的展示名（run_nodes.label） */
  nodeLabel: string;
  /** 冗余：该事件所属运行的工作流名（runs.workflowName） */
  workflowName: string;
}

export interface LogsQuery {
  runId?: string;
  nodeId?: string;
  /**
   * 事件类型过滤，**支持逗号分隔多值**（如 `text,tool`；单值仍是 `text`）。
   * 服务端把多值合进同一条 SQL 的 `in` 里、返回单一游标——多选时不要在前端各开一条流
   * 再归并，那样每条流各自分页、深度不一致，会让人误判某类事件不存在。
   */
  type?: string;
  /** payload 全文子串；服务端已转义 LIKE 通配符，`_` / `%` 按字面匹配 */
  q?: string;
  onlyErrors?: boolean;
  limit?: number;
  /** 上一页最小 id，按 id 倒序取更旧的 */
  cursor?: number;
}

export interface LogsPayload {
  items: LogItem[];
  /** 还有更旧的数据时是本页最小 id，否则 null */
  nextCursor: number | null;
}

// ---------------- 成本分析 ----------------

export interface CostByModel {
  modelId: string;
  providerId: string;
  /** assistant 消息条数（node_usage 行数） */
  messages: number;
  tokens: number;
  cost: number;
}

export interface CostByAction {
  actionName: string;
  /** 用到该 Action 的节点执行次数 */
  nodes: number;
  tokens: number;
  cost: number;
}

export interface CostByWorkflow {
  workflowName: string;
  runs: number;
  tokens: number;
  cost: number;
}

export interface CostDailyPoint {
  /** 本地日期 YYYY-MM-DD */
  dayISO: string;
  tokens: number;
  cost: number;
}

export interface CostPayload {
  /** 统计窗口（天） */
  days: number;
  /** 窗口起点 epoch 毫秒（本地零点） */
  since: number;
  byModel: CostByModel[];
  byAction: CostByAction[];
  byWorkflow: CostByWorkflow[];
  daily: CostDailyPoint[];
}

// ---------------- 系统健康 ----------------

export interface HealthEngine {
  /** 运行子进程的 runner 入口绝对路径 */
  runnerEntry: string;
  /** 入口文件在不在——不在则一次运行都起不来 */
  ready: boolean;
  /** 模型凭据引用名 */
  credentialRef: string;
  /** 该引用名在本进程环境里有没有值（只看有无，不读值） */
  credentialConfigured: boolean;
  error?: string;
}

export interface LiveRunProcess {
  runId: string;
  pid: number | null;
}

export interface HealthRunProcesses {
  /** 进程内在跑的运行子进程数（一次运行一个，见 ADR-0007） */
  activeRuns: number;
  runs: LiveRunProcess[];
}

export interface HealthTable {
  name: string;
  rows: number;
}

export interface HealthDb {
  path: string;
  bytes: number;
  tables: HealthTable[];
}

export interface DiskDirStat {
  bytes: number;
  /** 目录数（仅 data/runs 用：一个子目录 = 一次运行的工作区） */
  dirs?: number;
  /** 文件数 */
  files?: number;
}

export interface HealthDisk {
  runsDir: DiskDirStat & { dirs: number };
  uploads: DiskDirStat & { files: number };
}

/** 孤儿运行明细：状态仍是 running 但进程内已无事件泵路由 */
export interface OrphanRun {
  id: string;
  workflowName: string;
  status: string;
  startedAt: number | null;
  pendingNodes: number;
  reason: string;
}

export interface HealthCounts {
  runs: number;
  runNodes: number;
  runEvents: number;
  nodeUsage: number;
}

export interface HealthPayload {
  engine: HealthEngine;
  runProcesses: HealthRunProcesses;
  db: HealthDb;
  disk: HealthDisk;
  /** status='running' 但进程内已无对应子进程的运行（多半是上次进程留下的） */
  orphanRuns: OrphanRun[];
  counts: HealthCounts;
}

// ---------------- 清理 ----------------

export const CLEANUP_TARGETS = ["workspaces", "events", "runs"] as const;
export type CleanupTarget = (typeof CLEANUP_TARGETS)[number];

export interface CleanupRequest {
  target: CleanupTarget;
  /** 保留最近 N 天，删除更早的；必须是正整数 */
  beforeDays: number;
  /** true 只预览影响面不删（前端二次确认前必须先跑一遍） */
  dryRun?: boolean;
}

export interface CleanupResult {
  target: CleanupTarget;
  affected: {
    count: number;
    /** 可回收（或已回收）的字节数；事件清理是按 payload 长度的估算 */
    bytes?: number;
  };
  /** false 表示这次只是预览 */
  deleted: boolean;
  detail: string;
}

// ---------------- 全局 SSE ----------------

/**
 * `/api/monitor/stream` 的事件名与载荷：
 * - `overview` → MonitorOverview
 * - `sessions` → SessionsPayload
 * - `logs`     → MonitorStreamLogs（增量，最多 50 条）
 */
export interface MonitorStreamLogs {
  items: LogItem[];
}
