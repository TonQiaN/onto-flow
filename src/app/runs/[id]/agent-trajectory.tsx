"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  formatClock,
  formatDuration,
  formatTokens,
  sumTokens,
  type AgentTrajectoryResponse,
  type NodeStatus,
  type TrajectoryDetail,
  type TrajectoryRecord,
  type TrajectorySession,
} from "../lib";

const KIND_LABEL: Record<TrajectoryRecord["kind"], string> = {
  system: "系统",
  user: "用户",
  context: "上下文",
  assistant: "模型",
  tool: "工具",
  error: "错误",
};

const KIND_BADGE: Record<TrajectoryRecord["kind"], string> = {
  system: "bg-zinc-100 text-zinc-600",
  user: "bg-blue-50 text-blue-700",
  context: "bg-emerald-50 text-emerald-700",
  assistant: "bg-violet-50 text-violet-700",
  tool: "bg-amber-50 text-amber-700",
  error: "bg-red-50 text-red-700",
};

const TIMELINE_COLOR: Record<TrajectoryRecord["kind"], string> = {
  system: "bg-zinc-400",
  user: "bg-blue-500",
  context: "bg-emerald-500",
  assistant: "bg-violet-500",
  tool: "bg-amber-500",
  error: "bg-red-500",
};

const SESSION_STATUS: Record<TrajectorySession["status"], string> = {
  running: "运行中",
  completed: "完成",
  error: "失败",
  aborted: "已取消",
  blocked: "被阻止",
  "max-tokens": "达到 token 上限",
  interrupted: "意外中断",
  unknown: "未知",
};

function recordSearchText(record: TrajectoryRecord): string {
  return [
    record.label,
    record.summary,
    record.toolName,
    ...record.details.map((detail) => detail.content),
  ]
    .filter(Boolean)
    .join("\n")
    .toLocaleLowerCase("zh-CN");
}

function recordDuration(record: TrajectoryRecord): string {
  if (record.finishedAt == null) {
    return record.state === "running" ? "进行中" : "—";
  }
  return formatDuration(record.finishedAt - record.startedAt);
}

function sessionTokens(session: TrajectorySession): number {
  return session.records.reduce((total, record) => total + sumTokens(record.usage), 0);
}

function TrajectoryTimeline({
  records,
  selectedId,
  onSelect,
}: {
  records: TrajectoryRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const timed = records.filter(
    (record) => Number.isFinite(record.startedAt) && record.kind !== "error",
  );
  if (timed.length === 0) return null;

  const start = Math.min(...timed.map((record) => record.startedAt));
  const rawEnd = Math.max(...timed.map((record) => record.finishedAt ?? record.startedAt));
  const end = rawEnd > start ? rawEnd : start + 1;
  const span = end - start;
  const lanes = [
    ["input", "输入"],
    ["model", "模型"],
    ["tools", "工具"],
  ] as const;

  return (
    <div
      aria-label="Agent 轨迹时间线"
      className="rounded-md border border-zinc-200 bg-white px-3 py-2"
    >
      <div className="mb-1 flex justify-between pl-12 font-mono text-[10px] text-zinc-400">
        <span>0</span>
        <span>{formatDuration(span)}</span>
      </div>
      <div className="space-y-1">
        {lanes.map(([lane, label]) => (
          <div key={lane} className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-2">
            <span className="font-mono text-[10px] text-zinc-400">{label}</span>
            <div className="relative h-3 overflow-hidden rounded-sm bg-zinc-100">
              {timed
                .filter((record) => record.lane === lane)
                .map((record) => {
                  const left = ((record.startedAt - start) / span) * 100;
                  const recordEnd = record.finishedAt ?? record.startedAt;
                  const width = Math.max(((recordEnd - record.startedAt) / span) * 100, 0.8);
                  return (
                    <button
                      key={record.id}
                      type="button"
                      aria-label={`${KIND_LABEL[record.kind]}：${record.summary || record.label}`}
                      title={`${record.label} · ${recordDuration(record)}`}
                      onClick={() => onSelect(record.id)}
                      className={`absolute top-0.5 h-2 rounded-sm transition-opacity ${TIMELINE_COLOR[record.kind]} ${
                        selectedId === record.id
                          ? "ring-1 ring-zinc-900 ring-offset-1"
                          : "opacity-75 hover:opacity-100"
                      }`}
                      style={{
                        left: `${Math.min(left, 99.2)}%`,
                        width: `${Math.min(width, 100 - Math.min(left, 99.2))}%`,
                      }}
                    />
                  );
                })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RecordBadge({ kind }: { kind: TrajectoryRecord["kind"] }) {
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${KIND_BADGE[kind]}`}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}

function DetailPane({ record }: { record: TrajectoryRecord | null }) {
  const [tab, setTab] = useState(0);

  useEffect(() => setTab(0), [record?.id]);

  if (!record) {
    return (
      <div className="flex min-h-56 items-center justify-center text-xs text-zinc-400">
        选择左侧记录查看详情
      </div>
    );
  }

  const details: TrajectoryDetail[] =
    record.details.length > 0
      ? record.details
      : [
          {
            label: "摘要",
            content: record.summary,
            format: "text",
            truncated: false,
          },
        ];
  const active = details[Math.min(tab, details.length - 1)]!;

  return (
    <div data-testid="trajectory-detail" className="min-w-0">
      <div className="border-b border-zinc-100 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <RecordBadge kind={record.kind} />
          <span className="min-w-0 truncate text-xs font-medium text-zinc-800">{record.label}</span>
          <span className="ml-auto font-mono text-[10px] text-zinc-400">
            {formatClock(record.startedAt)} · {recordDuration(record)}
          </span>
        </div>
        {(record.turn != null || record.step != null) && (
          <div className="mt-1 font-mono text-[10px] text-zinc-400">
            {record.turn == null ? "" : `Turn ${record.turn}`}
            {record.step == null ? "" : ` · Step ${record.step}`}
            {record.callId ? ` · ${record.callId}` : ""}
          </div>
        )}
      </div>
      <div className="flex gap-1 overflow-x-auto border-b border-zinc-100 px-3 pt-2">
        {details.map((detail, index) => (
          <button
            key={`${detail.label}-${index}`}
            type="button"
            aria-pressed={index === tab}
            onClick={() => setTab(index)}
            className={`shrink-0 border-b-2 px-2 py-1.5 text-[11px] transition-colors ${
              index === tab
                ? "border-blue-500 text-blue-700"
                : "border-transparent text-zinc-400 hover:text-zinc-700"
            }`}
          >
            {detail.label}
          </button>
        ))}
      </div>
      <div className="p-3">
        <pre
          className={`max-h-[30rem] overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs leading-5 text-zinc-700 ${
            active.format === "json" ? "font-mono" : "font-sans"
          }`}
        >
          {active.content || "（空）"}
        </pre>
        {active.truncated && (
          <p className="mt-1.5 text-[10px] text-amber-700">内容过长，当前仅显示前一部分。</p>
        )}
      </div>
    </div>
  );
}

function RecordLedger({
  records,
  selectedId,
  cursorId,
  onSelect,
}: {
  records: TrajectoryRecord[];
  selectedId: string | null;
  /** 光标所在的那条记录：高亮并滚进视野，但不过滤列表 */
  cursorId: string | null;
  onSelect: (id: string) => void;
}) {
  const cursorRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cursorRef.current?.scrollIntoView({ block: "nearest" });
  }, [cursorId]);

  let previousLocation = "";
  return (
    <div className="max-h-[34rem] overflow-auto p-2" aria-label="Agent 轨迹记录">
      {records.length === 0 ? (
        <div className="py-10 text-center text-xs text-zinc-400">没有匹配的轨迹记录</div>
      ) : (
        records.map((record) => {
          const location = `${record.turn ?? ""}/${record.step ?? ""}`;
          const showLocation = location !== previousLocation;
          previousLocation = location;
          const atCursor = record.id === cursorId;
          return (
            <div key={record.id}>
              {showLocation && (record.turn != null || record.step != null) && (
                <div className="px-2 pt-2 pb-1 font-mono text-[10px] text-zinc-400">
                  {record.turn == null ? "" : `Turn ${record.turn}`}
                  {record.step == null ? "" : ` · Step ${record.step}`}
                </div>
              )}
              <button
                type="button"
                ref={atCursor ? cursorRef : undefined}
                data-testid="trajectory-record"
                data-kind={record.kind}
                data-cursor={atCursor ? "true" : undefined}
                data-call-id={record.callId ?? undefined}
                aria-pressed={selectedId === record.id}
                onClick={() => onSelect(record.id)}
                className={`mb-1 flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors ${
                  selectedId === record.id
                    ? "border-blue-200 bg-blue-50/70"
                    : "border-transparent hover:border-zinc-200 hover:bg-zinc-50"
                } ${atCursor ? "ring-1 ring-blue-500" : ""}`}
              >
                <span className="mt-0.5 font-mono text-[10px] text-zinc-300">#{record.seq}</span>
                <RecordBadge kind={record.kind} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-zinc-700">
                    {record.summary || record.label}
                  </span>
                  <span className="mt-0.5 block font-mono text-[10px] text-zinc-400">
                    {recordDuration(record)}
                    {record.state === "error" ? " · 失败" : ""}
                  </span>
                </span>
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}

/**
 * Action 的会话轨迹：挂载即读一次（抽屉的轨迹页签按需挂载它），运行中每 1.5s 重读 JSONL
 * 投影，节点进入终态后停止。接口按节点读各轮会话，与轮次表无关——没有轮次行的历史运行
 * 一样能看整份轨迹。
 *
 * 光标只用来定位，不过滤：`sessionId` 把面板切到光标所在那一轮的会话，`cursorMs` 高亮并
 * 滚到那一刻的记录；点某条记录反过来把光标拨到它的开始时刻（onSeek）。
 */
export function AgentTrajectory({
  runId,
  nodeId,
  nodeLabel,
  status,
  active,
  sessionId,
  cursorMs,
  onSeek,
}: {
  runId: string;
  nodeId: string;
  nodeLabel: string;
  status: NodeStatus;
  active: boolean;
  /** 光标所在轮的会话 id；没有轮次行时为 null，面板就展示全部会话不做定位 */
  sessionId?: string | null;
  cursorMs?: number;
  onSeek?: (ms: number) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AgentTrajectoryResponse | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(sessionId ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const fetching = useRef(false);
  const reloadQueued = useRef(false);
  /** 光标所在会话放在 ref 里读：进 load 的依赖会让每次换轮都重新拉一遍轨迹 */
  const pinnedSessionRef = useRef<string | null>(sessionId ?? null);
  /**
   * 本组件刚刚 onSeek 过去的那条记录。点第 1 轮的记录会把光标带进第 1 轮，
   * sessionId 随之变化——换轮本该重挑记录，但这一次的换轮正是这条记录引起的，
   * 清掉它详情面板就退回第一条，等于点了个寂寞。
   */
  const seekTargetRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (fetching.current) {
      // 终态变更可能与上一轮轮询重叠；不能吞掉这次请求，否则最后一条
      // 模型消息、工具结果或 usage 会永远停留在旧快照。
      reloadQueued.current = true;
      return;
    }
    fetching.current = true;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/trajectory`,
        { cache: "no-store" },
      );
      const payload = (await response.json()) as AgentTrajectoryResponse & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "加载 Agent 轨迹失败");
      }
      setData(payload);
      setError(null);
      if (payload.available && payload.sessions.length > 0) {
        const pinned = pinnedSessionRef.current;
        setActiveSessionId((current) => {
          if (payload.sessions.some((session) => session.id === current)) return current;
          if (pinned && payload.sessions.some((session) => session.id === pinned)) return pinned;
          return payload.sessions.at(-1)!.id;
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载 Agent 轨迹失败");
    } finally {
      fetching.current = false;
      const shouldReload = reloadQueued.current;
      reloadQueued.current = false;
      if (shouldReload) {
        void load();
      } else {
        setLoading(false);
      }
    }
  }, [nodeId, runId]);

  // 光标换轮就换会话；面板已经打开，不重新拉数据
  useEffect(() => {
    pinnedSessionRef.current = sessionId ?? null;
    if (!sessionId) return;
    setActiveSessionId(sessionId);
    const seeked = seekTargetRef.current;
    seekTargetRef.current = null;
    setSelectedId((current) => (current && current === seeked ? current : null));
  }, [sessionId]);

  // status / active 必须是依赖：运行态切到终态时先补拉一次，避免轮询清除后
  // 漏掉最后一条模型消息、工具结果或 usage；run 已终态但 node 状态陈旧时也不再轮询。
  useEffect(() => {
    void load();
  }, [active, load, status]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [active, load]);

  const activeSession = useMemo(() => {
    if (!data?.available) return null;
    return (
      data.sessions.find((session) => session.id === activeSessionId) ??
      data.sessions.at(-1) ??
      null
    );
  }, [activeSessionId, data]);

  const records = useMemo(() => {
    if (!activeSession) return [];
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    return needle
      ? activeSession.records.filter((record) => recordSearchText(record).includes(needle))
      : activeSession.records;
  }, [activeSession, query]);

  const selected = useMemo(() => {
    return records.find((record) => record.id === selectedId) ?? records[0] ?? null;
  }, [records, selectedId]);

  useEffect(() => {
    if (selected?.id !== selectedId) setSelectedId(selected?.id ?? null);
  }, [selected?.id, selectedId]);

  /** 光标所在记录：该会话里开始时刻不晚于光标的最后一条 */
  const cursorRecordId = useMemo(() => {
    if (cursorMs == null || !activeSession) return null;
    let hit: TrajectoryRecord | null = null;
    for (const record of activeSession.records) {
      if (record.startedAt > cursorMs) continue;
      if (!hit || record.startedAt >= hit.startedAt) hit = record;
    }
    return hit?.id ?? null;
  }, [activeSession, cursorMs]);

  const selectRecord = (id: string) => {
    setSelectedId(id);
    const record = activeSession?.records.find((item) => item.id === id);
    if (!record || !onSeek) return;
    seekTargetRef.current = id;
    onSeek(record.startedAt);
  };

  return (
    <div
      data-testid="agent-trajectory-panel"
      aria-label={`${nodeLabel} Agent 轨迹`}
      className="overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50/60"
    >
      {loading && data === null ? (
        <div className="px-4 py-10 text-center text-xs text-zinc-400">正在读取会话轨迹…</div>
      ) : error ? (
        <div className="flex items-center justify-between gap-3 px-4 py-4 text-xs text-red-700">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded border border-red-200 bg-white px-2 py-1 hover:bg-red-50"
          >
            重试
          </button>
        </div>
      ) : data && !data.available ? (
        <div className="px-4 py-8 text-center text-xs text-zinc-400">
          {data.reason === "cleaned"
            ? "会话轨迹文件已清理，运行概要仍可查看。"
            : "这个节点没有留下可读取的会话轨迹。"}
        </div>
      ) : activeSession ? (
        <>
          <div className="border-b border-zinc-200 bg-white px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              {(data?.available ? data.sessions : []).map((session) => (
                <button
                  key={session.id}
                  type="button"
                  aria-pressed={session.id === activeSession.id}
                  onClick={() => {
                    setActiveSessionId(session.id);
                    setSelectedId(null);
                  }}
                  className={`rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
                    session.id === activeSession.id
                      ? "border-zinc-800 bg-zinc-900 text-white"
                      : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-400"
                  }`}
                >
                  第 {session.round} 轮
                </button>
              ))}
              {active && (
                <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-blue-600">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
                  实时
                </span>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-zinc-500">
              <span>{SESSION_STATUS[activeSession.status]}</span>
              <span>
                {activeSession.provider && activeSession.model
                  ? `${activeSession.provider}/${activeSession.model}`
                  : "模型未知"}
              </span>
              <span>
                耗时{" "}
                {activeSession.durationMs == null ? "—" : formatDuration(activeSession.durationMs)}
              </span>
              <span>回合 {activeSession.turns}</span>
              <span>步骤 {activeSession.steps}</span>
              <span>调用 {activeSession.calls}</span>
              <span>token {formatTokens(sessionTokens(activeSession))}</span>
            </div>
            <div className="mt-3">
              <TrajectoryTimeline
                records={records}
                selectedId={selected?.id ?? null}
                onSelect={selectRecord}
              />
            </div>
            <div className="mt-3 flex items-center gap-2">
              <input
                type="search"
                aria-label="搜索 Agent 轨迹"
                placeholder="搜索轨迹"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                className="min-w-0 flex-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-700 transition-colors outline-none placeholder:text-zinc-400 focus:border-blue-400"
              />
              <span className="shrink-0 text-[10px] text-zinc-400">
                {records.length} / {activeSession.records.length} 条
              </span>
            </div>
          </div>
          <div className="grid min-h-64 bg-white lg:grid-cols-[minmax(280px,1.15fr)_minmax(320px,1fr)] lg:divide-x lg:divide-zinc-200">
            <RecordLedger
              records={records}
              selectedId={selected?.id ?? null}
              cursorId={cursorRecordId}
              onSelect={selectRecord}
            />
            <DetailPane record={selected} />
          </div>
        </>
      ) : (
        <div className="px-4 py-8 text-center text-xs text-zinc-400">暂无会话轨迹</div>
      )}
    </div>
  );
}
