"use client";

/**
 * 运行页的唯一数据源：GET /api/runs/[id] 取初值，随后订阅 SSE
 * /api/runs/[id]/events（snapshot 全量覆盖 run/nodes/rounds，log 增量追加事件）。
 *
 * 关键约定：
 * - `log` 按 run_events.id 去重：重连时服务端从 id=0 全量回放，不去重会把事件重复计入活动。
 * - 断线只自动重连一次（原生 EventSource 的无限重连被显式 close 掉），再失败就把连接状态
 *   置为 error 交给页面提示。历史运行同样连一次：SSE 会回放全部事件再 end。
 * - 只有一处 1Hz 计时器（`now`），运行中的「跟随现在」与已耗时都从它派生。
 * - 帧解析在 setState 之外完成：更新器是在下一次 render 里跑的，在里面抛异常不会被事件
 *   处理器的 try/catch 接住，一个坏帧会整页崩。
 * - 只管取数与归一，光标（跟随 / 暂停 / 倍速）在页面层。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_RUN_GRAPH, parseRunGraph } from "@/lib/run-graph";
import type { RunEventRow, RunNodeRoundRow, RunNodeRow, RunRow } from "../lib";

/**
 * 详情接口给的是 runs 原始行：比 RunRow 多一份受理元数据 `imports`，
 * 概要栏的「来源」从 `imports.invocation.source` 读时推导（与运行列表同一口径）。
 */
export type RunDetail = RunRow & { imports?: { invocation?: { source?: string } } | null };

export type ConnectionState = "idle" | "connecting" | "open" | "closed" | "error";

export interface RunStream {
  run: RunDetail | null;
  nodes: RunNodeRow[];
  rounds: RunNodeRoundRow[];
  events: RunEventRow[];
  loading: boolean;
  /** 加载失败（404 / 网络错误）；有值时页面只显示这条 */
  error: string | null;
  /** 冻结图读不出形状：画布空着，但要说出来，不静默当成空图 */
  graphError: string | null;
  connection: ConnectionState;
  /** 1Hz 心跳：运行中每秒变化，结束后冻结 */
  now: number;
  /** 取消成功后立刻拉一次，不等 SSE 下一轮轮询 */
  reload: () => void;
}

interface Payload {
  run: RunDetail | null;
  nodes: RunNodeRow[];
  rounds: RunNodeRoundRow[];
  graphError: string | null;
}

const EMPTY_PAYLOAD: Payload = { run: null, nodes: [], rounds: [], graphError: null };

/**
 * { run, nodes, rounds } → 页面形状；图在这里校验一次，坏图不冒充空图。
 * 图在受理时冻结（ADR-0018），同一条运行不会再变：命中同一个 run 就沿用已解析的那份，
 * 免得每帧 snapshot 都重建一张等价的图，把画布的选中态与视口一起冲掉。
 */
function parsePayload(value: unknown, prev: Payload): Payload {
  const data = (value ?? {}) as {
    run?: (RunDetail & { graph?: unknown }) | null;
    nodes?: RunNodeRow[];
    rounds?: RunNodeRoundRow[];
  };
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const rounds = Array.isArray(data.rounds) ? data.rounds : [];
  if (!data.run) return { ...EMPTY_PAYLOAD, nodes, rounds };
  if (prev.run && prev.run.id === data.run.id) {
    return {
      run: { ...data.run, graph: prev.run.graph },
      nodes,
      rounds,
      graphError: prev.graphError,
    };
  }
  try {
    return {
      run: { ...data.run, graph: parseRunGraph(data.run.graph) },
      nodes,
      rounds,
      graphError: null,
    };
  } catch (cause) {
    return {
      run: { ...data.run, graph: EMPTY_RUN_GRAPH },
      nodes,
      rounds,
      graphError: cause instanceof Error ? cause.message : "运行图无法解析",
    };
  }
}

const RECONNECT_LIMIT = 1;
const RECONNECT_DELAY_MS = 1000;

export function useRunStream(runId: string | undefined): RunStream {
  const [payload, setPayload] = useState<Payload>(EMPTY_PAYLOAD);
  const [events, setEvents] = useState<RunEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [now, setNow] = useState(() => Date.now());

  const esRef = useRef<EventSource | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retriesRef = useRef(0);
  const endedRef = useRef(false);
  const seenEventIdRef = useRef(0);

  const reload = useCallback(() => {
    if (!runId) return;
    void (async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) return;
        setPayload((prev) => parsePayload(data, prev));
      } catch {
        // 忽略：SSE 仍会推最新 snapshot
      }
    })();
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    endedRef.current = false;
    retriesRef.current = 0;
    seenEventIdRef.current = 0;
    setPayload(EMPTY_PAYLOAD);
    setEvents([]);
    setError(null);
    setLoading(true);
    setConnection("idle");

    const closeStream = () => {
      esRef.current?.close();
      esRef.current = null;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };

    const open = () => {
      const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
      esRef.current = es;

      es.onopen = () => {
        retriesRef.current = 0;
        if (!cancelled) setConnection("open");
      };

      es.addEventListener("snapshot", (ev) => {
        if (cancelled) return;
        let frame: unknown;
        try {
          frame = JSON.parse((ev as MessageEvent<string>).data);
        } catch {
          return; // 坏帧忽略，下一轮 500ms 轮询还会再发
        }
        setPayload((prev) => parsePayload(frame, prev));
      });

      es.addEventListener("log", (ev) => {
        if (cancelled) return;
        let row: RunEventRow;
        try {
          row = JSON.parse((ev as MessageEvent<string>).data) as RunEventRow;
        } catch {
          return;
        }
        // 重连后服务端从 id=0 全量回放，已消费过的不能再累加
        if (typeof row.id !== "number" || row.id <= seenEventIdRef.current) return;
        seenEventIdRef.current = row.id;
        setEvents((prev) => [...prev, row]);
      });

      es.addEventListener("end", () => {
        endedRef.current = true;
        closeStream();
        if (!cancelled) setConnection("closed");
      });

      es.onerror = () => {
        if (endedRef.current || cancelled) return;
        // 关掉原生的无限重连，改由我们自己重连一次
        es.close();
        if (esRef.current === es) esRef.current = null;
        if (retriesRef.current >= RECONNECT_LIMIT) {
          setConnection("error");
          return;
        }
        retriesRef.current += 1;
        setConnection("connecting");
        retryTimerRef.current = setTimeout(open, RECONNECT_DELAY_MS);
      };
    };

    void (async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(typeof data?.error === "string" ? data.error : "加载运行详情失败");
          return;
        }
        setPayload((prev) => parsePayload(data, prev));
        setConnection("connecting");
        open();
      } catch {
        if (!cancelled) setError("网络错误，加载运行详情失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      closeStream();
    };
  }, [runId]);

  // 1Hz 心跳只在运行中跑：结束后光标不再需要「现在」
  const running = payload.run?.status === "running";
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  return {
    run: payload.run,
    nodes: payload.nodes,
    rounds: payload.rounds,
    events,
    loading,
    error,
    graphError: payload.graphError,
    connection,
    now,
    reload,
  };
}
