"use client";

/**
 * 运行时可视化的唯一数据源（模块 C）。
 *
 * 职责：订阅 SSE `/api/runs/<runId>/events` → 解析 `snapshot`（run + run_nodes 全量）
 * 与 `log`（run_events 增量）→ 归一成画布要用的视觉状态，再经 React Context 下发给
 * flow-node / flow-edge / run-bar。
 *
 * 关键约定：
 * - 状态不再写进 node.data（避免与保存序列化纠缠），一律走 Context 读取。
 * - `log` 事件按 run_events.id 去重：SSE 重连时服务端会从 id=0 全量回放，
 *   不去重会把「已输出 N 字」重复累加。
 * - 断线只自动重连一次（原生 EventSource 的无限重连被显式 close 掉），
 *   再失败就把连接状态置为 error 交给运行条提示。
 * - 只有一处 1Hz 计时器（`now`），节点计时器与运行条已用时都从它派生。
 */

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useReactFlow, type Edge } from "@xyflow/react";
import { formatDuration, sumTokens, toMillis } from "@/app/runs/lib";
import type { FlowNode, RunNodeStatus } from "./types";

/** run_nodes.status 的全集（含阶段一新增的 cancelled）。与 types.ts 同一套，避免两处漂移 */
export type RunVisualStatus = RunNodeStatus;

/** runs.status 的全集 */
export type RunVisualRunStatus = "running" | "success" | "failed" | "cancelled";

export type ConnectionState = "idle" | "connecting" | "open" | "closed" | "error";

const NODE_STATUSES: readonly RunVisualStatus[] = [
  "pending",
  "running",
  "success",
  "failed",
  "skipped",
  "cancelled",
];

const RUN_STATUSES: readonly RunVisualRunStatus[] = ["running", "success", "failed", "cancelled"];

/** 某个画布节点在本次运行中的视觉数据（来自 SSE snapshot 的 run_nodes 行） */
export interface NodeVisual {
  nodeId: string;
  label: string;
  status: RunVisualStatus;
  startedAt: number | null;
  finishedAt: number | null;
  /** 已结束则为总耗时；进行中为 null（由 now - startedAt 现算） */
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  error: string | null;
}

export type ActivityKind = "tool" | "text" | "reasoning" | "idle" | "error";

/** 节点的实时活动（来自 SSE log 事件，只在运行中有意义） */
export interface NodeActivity {
  /** 累计输出字数（type=text 的 payload.text 长度合计） */
  chars: number;
  /** 累计思考字数（type=reasoning 的 payload.text 长度合计） */
  reasoningChars: number;
  /** 最近一次工具调用的名字与状态（type=tool） */
  tool: string | null;
  toolStatus: string | null;
  lastKind: ActivityKind | null;
  updatedAt: number;
}

export interface RunTotals {
  total: number;
  done: number;
  running: number;
  success: number;
  failed: number;
  skipped: number;
  cancelled: number;
  /** 「第 N 个」里的 N：已结束数 + 是否有正在跑的 */
  currentIndex: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
}

/** 下发给画布与运行条的完整视觉状态 */
export interface RunVisuals {
  runId: string | null;
  runStatus: RunVisualRunStatus | null;
  runError: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  connection: ConnectionState;
  /** 画布节点 id → 视觉数据 */
  nodes: Record<string, NodeVisual>;
  /** 画布节点 id → 状态（flow-edge 只需要这个） */
  statusByNode: Record<string, RunVisualStatus>;
  /** 画布节点 id → 实时活动 */
  activityByNode: Record<string, NodeActivity>;
  totals: RunTotals;
  /** 当前正在执行的节点（多个则取最后开始的那个） */
  currentNodeId: string | null;
  /** 1Hz 心跳：运行中每秒变化，结束后冻结。节点计时器从它派生 */
  now: number;
  /** 已用时（运行中为实时值，结束后为总耗时） */
  elapsedMs: number;

  // ---- 自动跟随 ----
  followMode: boolean;
  setFollowMode: (on: boolean) => void;
  /** 用户手动平移/缩放后跟随被暂停（followMode 仍为 true） */
  followPaused: boolean;
  /** 恢复跟随并立刻把当前节点带入视野 */
  resumeFollow: () => void;
  /** 把指定节点平滑带入视野（保持当前缩放） */
  fitNodeIntoView: (nodeId: string, durationMs?: number) => void;

  // ---- 取消 ----
  cancelling: boolean;
  cancelError: string | null;
  cancel: () => Promise<void>;

  /** 运行条是否可见（结束后可一键关闭） */
  visible: boolean;
  dismiss: () => void;
}

/** useRunVisuals 的返回值：视觉状态 + 给模块 B 的订阅入口 */
export interface RunVisualsController {
  visuals: RunVisuals;
  /** 模块 B 在 POST /api/workflows/<id>/run 拿到 runId 后调用 */
  subscribe: (runId: string) => void;
  /** 断开订阅并清空（切换工作流等场景） */
  reset: () => void;
}

// ---------------------------------------------------------------- 内部状态

interface RunState {
  runId: string | null;
  runStatus: RunVisualRunStatus | null;
  runError: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  connection: ConnectionState;
  nodes: Record<string, NodeVisual>;
  activity: Record<string, NodeActivity>;
}

const EMPTY_STATE: RunState = {
  runId: null,
  runStatus: null,
  runError: null,
  startedAt: null,
  finishedAt: null,
  connection: "idle",
  nodes: {},
  activity: {},
};

const EMPTY_TOTALS: RunTotals = {
  total: 0,
  done: 0,
  running: 0,
  success: 0,
  failed: 0,
  skipped: 0,
  cancelled: 0,
  currentIndex: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cost: 0,
};

function isTerminal(status: RunVisualStatus): boolean {
  return status !== "pending" && status !== "running";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNodeStatus(value: unknown): RunVisualStatus {
  return NODE_STATUSES.find((s) => s === value) ?? "pending";
}

function asRunStatus(value: unknown): RunVisualRunStatus | null {
  return RUN_STATUSES.find((s) => s === value) ?? null;
}

/** snapshot 帧解析出的增量补丁（只覆盖 run/nodes，activity 不动） */
type SnapshotPatch = Partial<
  Pick<RunState, "runStatus" | "runError" | "startedAt" | "finishedAt">
> &
  Pick<RunState, "nodes">;

/**
 * SSE snapshot 帧 → 补丁。
 * 解析必须在 setState 之外完成：useState 的更新器是在下一次 render 里跑的，
 * 在里面抛异常不会被事件处理器的 try/catch 接住，坏帧会整页崩。
 */
function parseSnapshot(raw: string): SnapshotPatch {
  const parsed = JSON.parse(raw) as {
    run?: Record<string, unknown> | null;
    nodes?: unknown;
  };
  const run = parsed.run ?? null;
  const rows = Array.isArray(parsed.nodes) ? parsed.nodes : [];

  const nodes: Record<string, NodeVisual> = {};
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const nodeId = str(r.nodeId);
    if (!nodeId) continue;
    const startedAt = toMillis(r.startedAt);
    const finishedAt = toMillis(r.finishedAt);
    const inputTokens = num(r.inputTokens);
    const outputTokens = num(r.outputTokens);
    nodes[nodeId] = {
      nodeId,
      label: str(r.label) ?? nodeId,
      status: asNodeStatus(r.status),
      startedAt,
      finishedAt,
      durationMs:
        startedAt != null && finishedAt != null ? Math.max(0, finishedAt - startedAt) : null,
      inputTokens,
      outputTokens,
      totalTokens: sumTokens({
        inputTokens,
        outputTokens,
        reasoningTokens: num(r.reasoningTokens),
        cacheReadTokens: num(r.cacheReadTokens),
        cacheWriteTokens: num(r.cacheWriteTokens),
      }),
      cost: num(r.cost),
      error: str(r.error),
    };
  }

  const patch: SnapshotPatch = { nodes };
  if (!run) return patch;
  const runStatus = asRunStatus(run.status);
  if (runStatus) patch.runStatus = runStatus;
  patch.runError = str(run.error);
  patch.startedAt = toMillis(run.startedAt);
  patch.finishedAt = toMillis(run.finishedAt);
  return patch;
}

const EMPTY_ACTIVITY: NodeActivity = {
  chars: 0,
  reasoningChars: 0,
  tool: null,
  toolStatus: null,
  lastKind: null,
  updatedAt: 0,
};

/**
 * SSE log 帧（run_events 行）→ activity。
 * 事件类型由 src/server/engine/events.ts 产出：
 * text / reasoning / tool / session.idle / session.error。
 * 纯函数：去重（按 run_events.id）在调用处完成，避免在 setState 更新器里写副作用。
 */
function applyLogRow(prev: RunState, row: Record<string, unknown>): RunState {
  const nodeId = str(row.nodeId);
  const type = str(row.type);
  if (!nodeId || !type) return prev;

  const payload =
    row.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>) : {};
  const at = toMillis(row.ts) ?? Date.now();
  const base = prev.activity[nodeId] ?? EMPTY_ACTIVITY;
  let next: NodeActivity | null = null;

  if (type === "text") {
    const text = typeof payload.text === "string" ? payload.text : "";
    next = { ...base, chars: base.chars + text.length, lastKind: "text", updatedAt: at };
  } else if (type === "reasoning") {
    const text = typeof payload.text === "string" ? payload.text : "";
    next = {
      ...base,
      reasoningChars: base.reasoningChars + text.length,
      lastKind: "reasoning",
      updatedAt: at,
    };
  } else if (type === "tool") {
    next = {
      ...base,
      tool: str(payload.tool) ?? base.tool,
      toolStatus: str(payload.status),
      lastKind: "tool",
      updatedAt: at,
    };
  } else if (type === "session.idle") {
    next = { ...base, lastKind: "idle", updatedAt: at };
  } else if (type === "session.error") {
    next = { ...base, lastKind: "error", updatedAt: at };
  }

  if (!next) return prev;
  return { ...prev, activity: { ...prev.activity, [nodeId]: next } };
}

/** 节点内联的「最近活动」摘要文案 */
export function activitySummary(activity: NodeActivity | undefined): string | null {
  if (!activity || activity.lastKind === null) return null;
  if (activity.lastKind === "tool" && activity.tool) {
    if (activity.toolStatus === "completed") return `工具 ${activity.tool} 已完成`;
    if (activity.toolStatus === "error") return `工具 ${activity.tool} 出错`;
    return `正在调用工具 ${activity.tool}`;
  }
  if (activity.lastKind === "error") return "会话报错，处理中…";
  if (activity.lastKind === "idle") return "本轮已收尾";
  if (activity.lastKind === "reasoning") {
    return `思考中…（已思考 ${activity.reasoningChars} 字）`;
  }
  if (activity.chars > 0) return `已输出 ${activity.chars} 字`;
  return "思考中…";
}

/** token 数紧凑展示：1234 → 1.2k */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** 人民币费用展示：0 → “¥0”；极小值不塌成 0 */
export function formatCost(cost: number): string {
  if (cost <= 0) return "¥0";
  if (cost < 0.0001) return "<¥0.0001";
  return `¥${cost.toFixed(4)}`;
}

export { formatDuration };

// ---------------------------------------------------------------- 主 hook

const RECONNECT_LIMIT = 1;
const RECONNECT_DELAY_MS = 1000;
const FOLLOW_DURATION_MS = 600;

/**
 * 必须在 ReactFlowProvider 内部调用（用到 useReactFlow 做自动跟随）。
 */
export function useRunVisuals(): RunVisualsController {
  const [state, setState] = useState<RunState>(EMPTY_STATE);
  const [followMode, setFollowModeState] = useState(true);
  const [followPaused, setFollowPaused] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const esRef = useRef<EventSource | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retriesRef = useRef(0);
  const endedRef = useRef(false);
  const seenEventIdRef = useRef(0);

  const { setCenter, getNode, getZoom } = useReactFlow<FlowNode, Edge>();

  const closeStream = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const open = useCallback(
    (runId: string) => {
      const es = new EventSource(`/api/runs/${runId}/events`);
      esRef.current = es;

      es.onopen = () => {
        retriesRef.current = 0;
        setState((s) => (s.runId === runId ? { ...s, connection: "open" } : s));
      };

      es.addEventListener("snapshot", (ev) => {
        let patch: SnapshotPatch;
        try {
          patch = parseSnapshot((ev as MessageEvent<string>).data);
        } catch {
          return; // 坏帧忽略，下一轮 500ms 轮询还会再发
        }
        setState((s) => (s.runId === runId ? { ...s, ...patch } : s));
      });

      es.addEventListener("log", (ev) => {
        try {
          const row = JSON.parse((ev as MessageEvent<string>).data) as Record<string, unknown>;
          const eventId = num(row.id);
          // 重连后服务端从 id=0 全量回放，已消费过的不能再累加字数
          if (eventId !== 0 && eventId <= seenEventIdRef.current) return;
          if (eventId > seenEventIdRef.current) seenEventIdRef.current = eventId;
          setState((s) => (s.runId === runId ? applyLogRow(s, row) : s));
        } catch {
          // 坏帧忽略（JSON.parse 失败）
        }
      });

      es.addEventListener("end", () => {
        endedRef.current = true;
        closeStream();
        setState((s) => (s.runId === runId ? { ...s, connection: "closed" } : s));
      });

      es.onerror = () => {
        if (endedRef.current) return;
        // 关掉原生的无限重连，改由我们自己重连一次
        es.close();
        if (esRef.current === es) esRef.current = null;
        if (retriesRef.current >= RECONNECT_LIMIT) {
          setState((s) => (s.runId === runId ? { ...s, connection: "error" } : s));
          return;
        }
        retriesRef.current += 1;
        setState((s) => (s.runId === runId ? { ...s, connection: "connecting" } : s));
        retryTimerRef.current = setTimeout(() => open(runId), RECONNECT_DELAY_MS);
      };
    },
    [closeStream],
  );

  const subscribe = useCallback(
    (runId: string) => {
      closeStream();
      endedRef.current = false;
      retriesRef.current = 0;
      seenEventIdRef.current = 0;
      setCancelError(null);
      setCancelling(false);
      setDismissed(false);
      setFollowPaused(false);
      setNow(Date.now());
      setState({
        ...EMPTY_STATE,
        runId,
        runStatus: "running",
        connection: "connecting",
      });
      open(runId);
    },
    [closeStream, open],
  );

  const reset = useCallback(() => {
    closeStream();
    endedRef.current = true;
    seenEventIdRef.current = 0;
    setState(EMPTY_STATE);
  }, [closeStream]);

  // 卸载必关流
  useEffect(() => {
    return () => {
      esRef.current?.close();
      esRef.current = null;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  // ---------- 派生 ----------
  const running = state.runStatus === "running";

  const { totals, currentNodeId, statusByNode } = useMemo(() => {
    const list = Object.values(state.nodes);
    if (list.length === 0) {
      return {
        totals: EMPTY_TOTALS,
        currentNodeId: null as string | null,
        statusByNode: {} as Record<string, RunVisualStatus>,
      };
    }
    const acc: RunTotals = { ...EMPTY_TOTALS, total: list.length };
    const byNode: Record<string, RunVisualStatus> = {};
    let current: NodeVisual | null = null;
    for (const n of list) {
      byNode[n.nodeId] = n.status;
      if (n.status === "running") {
        acc.running += 1;
        if (!current || (n.startedAt ?? 0) >= (current.startedAt ?? 0)) current = n;
      } else if (n.status === "success") acc.success += 1;
      else if (n.status === "failed") acc.failed += 1;
      else if (n.status === "skipped") acc.skipped += 1;
      else if (n.status === "cancelled") acc.cancelled += 1;
      if (isTerminal(n.status)) acc.done += 1;
      acc.inputTokens += n.inputTokens;
      acc.outputTokens += n.outputTokens;
      acc.totalTokens += n.totalTokens;
      acc.cost += n.cost;
    }
    acc.currentIndex = Math.min(acc.done + (acc.running > 0 ? 1 : 0), acc.total);
    return { totals: acc, currentNodeId: current?.nodeId ?? null, statusByNode: byNode };
  }, [state.nodes]);

  // ---------- 1Hz 心跳（只在运行中跑） ----------
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const elapsedMs = useMemo(() => {
    if (state.startedAt == null) return 0;
    const end = state.finishedAt ?? (running ? now : state.startedAt);
    return Math.max(0, end - state.startedAt);
  }, [state.startedAt, state.finishedAt, running, now]);

  // ---------- 自动跟随 ----------
  const fitNodeIntoView = useCallback(
    (nodeId: string, durationMs: number = FOLLOW_DURATION_MS) => {
      const node = getNode(nodeId);
      if (!node) return;
      const width = node.measured?.width ?? node.width ?? 240;
      const height = node.measured?.height ?? node.height ?? 120;
      void setCenter(node.position.x + width / 2, node.position.y + height / 2, {
        zoom: getZoom(),
        duration: durationMs,
      });
    },
    [getNode, getZoom, setCenter],
  );

  useEffect(() => {
    if (!followMode || followPaused || !currentNodeId) return;
    // 等一帧，保证新节点已量到尺寸
    const raf = requestAnimationFrame(() => fitNodeIntoView(currentNodeId));
    return () => cancelAnimationFrame(raf);
  }, [followMode, followPaused, currentNodeId, fitNodeIntoView]);

  /**
   * 用户手动平移/缩放 → 暂停跟随。
   * 只认真实指针/滚轮事件（setCenter 是程序化的，不会产生这些事件），
   * 因此不需要「程序化窗口」这类时间戳判定。
   */
  useEffect(() => {
    if (!followMode || followPaused) return;
    const onPointerDown = (e: Event) => {
      const target = e.target as HTMLElement | null;
      // 只有按在 pane **本身**才算「开始手动平移」。
      // .react-flow__pane 是 viewport 的父元素，覆盖整块画布，用 closest 会把
      // 点节点/连线/控件都误判成平移，运行中点一下节点就静默停掉自动跟随。
      if (target?.classList?.contains("react-flow__pane")) setFollowPaused(true);
    };
    const onWheel = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.(".react-flow")) setFollowPaused(true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("wheel", onWheel, { capture: true, passive: true });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("wheel", onWheel, true);
    };
  }, [followMode, followPaused]);

  const setFollowMode = useCallback((on: boolean) => {
    setFollowModeState(on);
    setFollowPaused(false);
  }, []);

  const resumeFollow = useCallback(() => {
    setFollowModeState(true);
    setFollowPaused(false);
  }, []);

  // ---------- 取消运行 ----------
  const runId = state.runId;
  const cancel = useCallback(async () => {
    if (!runId) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/cancel`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setCancelError(body?.error ?? "取消失败");
      }
    } catch {
      setCancelError("网络错误，取消失败");
    } finally {
      setCancelling(false);
    }
  }, [runId]);

  const dismiss = useCallback(() => {
    closeStream();
    setDismissed(true);
  }, [closeStream]);

  const visuals = useMemo<RunVisuals>(
    () => ({
      runId: state.runId,
      runStatus: state.runStatus,
      runError: state.runError,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      connection: state.connection,
      nodes: state.nodes,
      statusByNode,
      activityByNode: state.activity,
      totals,
      currentNodeId,
      now,
      elapsedMs,
      followMode,
      setFollowMode,
      followPaused,
      resumeFollow,
      fitNodeIntoView,
      cancelling,
      cancelError,
      cancel,
      visible: state.runId !== null && !dismissed,
      dismiss,
    }),
    [
      state,
      statusByNode,
      totals,
      currentNodeId,
      now,
      elapsedMs,
      followMode,
      setFollowMode,
      followPaused,
      resumeFollow,
      fitNodeIntoView,
      cancelling,
      cancelError,
      cancel,
      dismissed,
      dismiss,
    ],
  );

  return { visuals, subscribe, reset };
}

// ---------------------------------------------------------------- Context

const RunVisualsContext = createContext<RunVisuals | null>(null);

/**
 * 模块 B 用它把 useRunVisuals() 的 visuals 包在 <ReactFlow> 外层，
 * flow-node / flow-edge 才能读到运行状态。
 */
export function RunVisualsProvider({
  value,
  children,
}: {
  value: RunVisuals | null;
  children: ReactNode;
}): ReactElement {
  return createElement(RunVisualsContext.Provider, { value }, children);
}

/** 画布组件读取运行视觉；没有运行时返回 null */
export function useRunVisualsContext(): RunVisuals | null {
  return useContext(RunVisualsContext);
}
