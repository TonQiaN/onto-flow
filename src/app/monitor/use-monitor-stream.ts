"use client";

/**
 * 监控台的全局实时数据源：订阅 `GET /api/monitor/stream`（SSE）。
 *
 * 载荷类型是服务端与前端共用的 `@/server/monitor/types`（**纯类型导入，构建时擦除**，
 * 不会把服务端代码打进客户端包）。事件契约见该文件末尾「全局 SSE」一节：
 *
 * ```
 * event: overview   data: MonitorOverview          // live / today / lastHourErrors / series(24 桶)
 * event: sessions   data: { items: LiveSession[] } // 全量替换
 * event: logs       data: { items: LogItem[] }     // 增量，按 id 去重，不回放历史
 * ```
 *
 * 时间字段一律 epoch 毫秒（服务端已归一），前端可直接丢给 `@/app/runs/lib` 的格式化函数。
 * 解析仍走一层宽松校验：坏帧丢弃、缺字段补零，服务端出问题也只是数字归零而不是白屏。
 *
 * 连接策略：断线自动重连 **一次**（每次成功握手后重置该额度），再失败就停在
 * `closed`，交给页面上的「重试」按钮；组件卸载立即 close，不留悬挂连接。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LiveSession,
  LogItem,
  MonitorOverview,
  NodeStatus,
  OverviewPoint,
  SessionActivity,
} from "@/server/monitor/types";

export type { LiveSession, LogItem, MonitorOverview, OverviewPoint, SessionActivity };

const STREAM_URL = "/api/monitor/stream";
const DEFAULT_LOG_LIMIT = 400;
const RECONNECT_DELAY_MS = 1500;

export type MonitorConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export interface MonitorConnection {
  state: MonitorConnectionState;
  /** 仅在 closed 时有值 */
  error: string | null;
  /** 最近一次收到数据帧的时刻 */
  lastMessageAt: number | null;
  /** 手动重连（重置重试额度） */
  retry: () => void;
}

export interface MonitorStream {
  /** 未收到过 overview 帧时为 null（区别于「全是 0」） */
  overview: MonitorOverview | null;
  /** 未收到过 sessions 帧时为 null（区别于「确实没有活跃会话」的空数组） */
  sessions: LiveSession[] | null;
  logs: LogItem[];
  connection: MonitorConnection;
}

/* ------------------------------- 宽松解析 -------------------------------- */

type Dict = Record<string, unknown>;

const NODE_STATUSES: readonly NodeStatus[] = [
  "pending",
  "running",
  "success",
  "failed",
  "skipped",
  "cancelled",
];

const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function asNodeStatus(value: unknown): NodeStatus {
  const hit = NODE_STATUSES.find((s) => s === value);
  return hit ?? "running";
}

/** 服务端统一用 `{ items: [...] }` 信封；裸数组也认 */
function asItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isDict(raw) && Array.isArray(raw.items)) return raw.items;
  return [];
}

function asOverview(raw: unknown): MonitorOverview | null {
  if (!isDict(raw)) return null;
  const live = isDict(raw.live) ? raw.live : {};
  const today = isDict(raw.today) ? raw.today : {};
  const series: OverviewPoint[] = (Array.isArray(raw.series) ? raw.series : []).flatMap(
    (item: unknown) => {
      if (!isDict(item)) return [];
      return [
        {
          hourISO: str(item.hourISO),
          hourMs: num(item.hourMs),
          runs: num(item.runs),
          failed: num(item.failed),
          tokens: num(item.tokens),
          cost: num(item.cost),
        },
      ];
    },
  );

  return {
    live: {
      activeRuns: num(live.activeRuns),
      activeSessions: num(live.activeSessions),
      runningNodes: num(live.runningNodes),
    },
    today: {
      runs: num(today.runs),
      success: num(today.success),
      failed: num(today.failed),
      cancelled: num(today.cancelled),
      tokens: num(today.tokens),
      cost: num(today.cost),
      avgNodeSeconds: num(today.avgNodeSeconds),
    },
    lastHourErrors: num(raw.lastHourErrors),
    series,
  };
}

function asSession(item: unknown): LiveSession | null {
  if (!isDict(item)) return null;
  const sessionId = str(item.sessionId);
  const runId = str(item.runId);
  if (!sessionId || !runId) return null;
  const activity = isDict(item.lastActivity) ? item.lastActivity : null;
  return {
    sessionId,
    runId,
    nodeId: str(item.nodeId),
    nodeLabel: str(item.nodeLabel),
    workflowName: str(item.workflowName),
    actionName: str(item.actionName),
    model: str(item.model),
    variant: str(item.variant),
    status: asNodeStatus(item.status),
    startedAt: num(item.startedAt),
    elapsedMs: num(item.elapsedMs),
    tokens: num(item.tokens),
    cost: num(item.cost),
    lastActivity: activity
      ? {
          type: str(activity.type),
          text: str(activity.text),
          ts: num(activity.ts),
        }
      : null,
  };
}

function asLogItem(item: unknown): LogItem | null {
  if (!isDict(item)) return null;
  const id = num(item.id);
  if (id <= 0) return null;
  return {
    id,
    runId: str(item.runId),
    nodeId: typeof item.nodeId === "string" ? item.nodeId : null,
    ts: num(item.ts),
    type: str(item.type),
    payload: isDict(item.payload) ? item.payload : null,
    nodeLabel: str(item.nodeLabel),
    workflowName: str(item.workflowName),
  };
}

/* --------------------------------- hook ---------------------------------- */

export function useMonitorStream(options?: {
  /** 内存里保留的日志条数上限，默认 400 */
  logLimit?: number;
}): MonitorStream {
  const logLimit = options?.logLimit ?? DEFAULT_LOG_LIMIT;
  const logLimitRef = useRef(logLimit);
  logLimitRef.current = logLimit;

  const [overview, setOverview] = useState<MonitorOverview | null>(null);
  const [sessions, setSessions] = useState<LiveSession[] | null>(null);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [state, setState] = useState<MonitorConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);
  /** 自增即重连 */
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let disposed = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retried = false;
    const seenLogIds = new Set<number>();

    setState("connecting");
    setError(null);

    const parse = (event: Event): unknown => {
      const data = (event as MessageEvent<string>).data;
      if (typeof data !== "string" || data.length === 0) return null;
      try {
        return JSON.parse(data) as unknown;
      } catch {
        return null; // 坏帧直接丢
      }
    };

    const touch = () => {
      if (!disposed) setLastMessageAt(Date.now());
    };

    const applyLogs = (raw: unknown) => {
      const incoming = asItems(raw).flatMap((item) => {
        const row = asLogItem(item);
        if (!row || seenLogIds.has(row.id)) return [];
        seenLogIds.add(row.id);
        return [row];
      });
      if (incoming.length === 0) return;
      setLogs((prev) => {
        const merged = [...prev, ...incoming].sort((a, b) => a.id - b.id);
        const limit = logLimitRef.current;
        return merged.length > limit ? merged.slice(merged.length - limit) : merged;
      });
    };

    const open = () => {
      if (disposed) return;
      const es = new EventSource(STREAM_URL);
      source = es;

      es.onopen = () => {
        if (disposed) return;
        // 握手成功即重置重试额度：长连接跑很久后再断，仍允许自动重连一次
        retried = false;
        setState("open");
        setError(null);
      };

      es.addEventListener("overview", (e) => {
        if (disposed) return;
        touch();
        const next = asOverview(parse(e));
        if (next) setOverview(next);
      });

      es.addEventListener("sessions", (e) => {
        if (disposed) return;
        touch();
        setSessions(
          asItems(parse(e)).flatMap((item) => {
            const session = asSession(item);
            return session ? [session] : [];
          }),
        );
      });

      es.addEventListener("logs", (e) => {
        if (disposed) return;
        touch();
        applyLogs(parse(e));
      });

      es.onerror = () => {
        if (disposed) return;
        es.close();
        source = null;
        if (retried) {
          setState("closed");
          setError("实时连接已断开（已自动重连过一次）");
          return;
        }
        retried = true;
        setState("reconnecting");
        timer = setTimeout(open, RECONNECT_DELAY_MS);
      };
    };

    open();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      source?.close();
    };
  }, [attempt]);

  return {
    overview,
    sessions,
    logs,
    connection: { state, error, lastMessageAt, retry },
  };
}
