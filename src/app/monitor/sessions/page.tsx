"use client";

/**
 * 监控台 · 实时会话：列出进行中的 opencode 会话，点开右侧抽屉看该会话的
 * tail -f 事件流，并可二次确认后中止其所属运行。
 *
 * 会话列表来自 /api/monitor/stream；抽屉里的事件流复用既有的
 * /api/runs/[id]/events（该 SSE 会回放历史事件再跟增量），按 nodeId 过滤出本会话。
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  formatClock,
  formatCost,
  formatDuration,
  formatTokens,
  toMillis,
  type RunEventRow,
  type RunNodeRow,
  type RunRow,
} from "@/app/runs/lib";
import { ConnectionBadge, Dot, MonitorEmpty, MonitorErrorBar, Num } from "../ui";
import { useMonitorStream, type LiveSession } from "../use-monitor-stream";

const EVENT_LIMIT = 600;

/** 秒表：有活跃会话时每秒重渲染一次 */
function useTicker(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
}

/** 秒表文案：从 startedAt 现算（服务端的 elapsedMs 只在推送那一刻准） */
function elapsedText(session: LiveSession): string {
  if (session.startedAt > 0) {
    return formatDuration(Date.now() - session.startedAt);
  }
  return session.elapsedMs > 0 ? formatDuration(session.elapsedMs) : "—";
}

export default function MonitorSessionsPage() {
  const { sessions, connection } = useMonitorStream({ logLimit: 1 });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const list = sessions ?? [];
    return [...list].sort((a, b) => a.startedAt - b.startedAt);
  }, [sessions]);

  useTicker(rows.length > 0);

  // 选中的会话结束（从列表消失）后自动关抽屉
  useEffect(() => {
    if (selectedId && !rows.some((r) => r.sessionId === selectedId)) {
      setSelectedId(null);
    }
  }, [rows, selectedId]);

  const selected = rows.find((r) => r.sessionId === selectedId) ?? null;
  const loading = sessions === null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-5">
      {connection.state === "closed" && (
        <MonitorErrorBar
          message={connection.error ?? "实时连接已断开"}
          onRetry={connection.retry}
        />
      )}

      <div className="flex min-h-0 flex-1 gap-4">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/60">
          <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-medium text-zinc-200">进行中的会话</h2>
              <Num className="text-[11px] text-zinc-500">{loading ? "—" : rows.length}</Num>
            </div>
            <ConnectionBadge
              state={connection.state}
              lastMessageAt={connection.lastMessageAt}
              onRetry={connection.retry}
            />
          </header>

          <div className="min-h-0 flex-1 overflow-auto">
            {loading ? (
              <p className="px-4 py-10 text-center text-xs text-zinc-600">等待实时数据…</p>
            ) : rows.length === 0 ? (
              <div className="p-4">
                <MonitorEmpty
                  title="当前没有进行中的会话"
                  description={
                    <>
                      这是正常状态——只有 Action 节点执行时才会占用一个 opencode
                      会话，运行结束会话即释放。去
                      <Link
                        href="/workflows"
                        className="mx-1 text-sky-400 underline hover:text-sky-300"
                      >
                        工作流
                      </Link>
                      发起一次运行，这里会立刻出现。
                    </>
                  }
                />
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-zinc-900 text-[11px] text-zinc-500">
                  <tr className="text-left">
                    <th className="px-4 py-2 font-medium">会话</th>
                    <th className="px-3 py-2 font-medium">运行 · 节点</th>
                    <th className="px-3 py-2 font-medium">Action</th>
                    <th className="px-3 py-2 font-medium">模型 · 强度</th>
                    <th className="px-3 py-2 text-right font-medium">已用时</th>
                    <th className="px-3 py-2 text-right font-medium">token</th>
                    <th className="px-3 py-2 text-right font-medium">费用</th>
                    <th className="px-4 py-2 font-medium">最近活动</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((session) => {
                    const on = session.sessionId === selectedId;
                    return (
                      <tr
                        key={session.sessionId}
                        onClick={() => setSelectedId(on ? null : session.sessionId)}
                        className={`cursor-pointer border-t border-zinc-800/70 transition-colors ${
                          on ? "bg-zinc-800/60" : "hover:bg-zinc-800/30"
                        }`}
                      >
                        <td className="px-4 py-2.5">
                          <span className="inline-flex items-center gap-1.5">
                            <Dot tone="sky" pulse />
                            <Num className="text-zinc-300">{session.sessionId.slice(0, 8)}</Num>
                          </span>
                        </td>
                        <td className="max-w-[16rem] px-3 py-2.5">
                          <span className="block truncate text-zinc-300">
                            {session.workflowName}
                          </span>
                          <span className="block truncate text-[11px] text-zinc-500">
                            {session.nodeLabel}
                          </span>
                        </td>
                        <td className="max-w-[10rem] truncate px-3 py-2.5 text-zinc-400">
                          {session.actionName || "—"}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="block truncate font-mono text-[11px] text-zinc-400">
                            {session.model || "—"}
                          </span>
                          <span className="text-[11px] text-zinc-600">
                            {session.variant || "—"}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <Num className="text-zinc-300">{elapsedText(session)}</Num>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <Num className="text-zinc-300">{formatTokens(session.tokens)}</Num>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <Num className="text-zinc-300">{formatCost(session.cost)}</Num>
                        </td>
                        <td className="max-w-[18rem] px-4 py-2.5">
                          {session.lastActivity ? (
                            <span className="block truncate text-zinc-500">
                              <span className="text-zinc-400">{session.lastActivity.type}</span>{" "}
                              {session.lastActivity.text}
                            </span>
                          ) : (
                            <span className="text-zinc-600">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {selected && (
          <SessionDrawer
            key={selected.sessionId}
            session={selected}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  );
}

/* -------------------------------- 抽屉 ----------------------------------- */

function eventSummary(row: RunEventRow): string {
  const payload = row.payload;
  if (!payload) return "";
  if ((row.type === "text" || row.type === "reasoning") && typeof payload.text === "string") {
    return payload.text;
  }
  if (row.type === "tool") {
    const parts = [
      typeof payload.tool === "string" ? payload.tool : "",
      typeof payload.status === "string" ? `[${payload.status}]` : "",
      typeof payload.title === "string" ? payload.title : "",
    ].filter(Boolean);
    return parts.join(" ");
  }
  try {
    return JSON.stringify(payload);
  } catch {
    // 走到这里说明 payload 有环或含 BigInt；String() 只会给出 [object Object]，不如直说
    return "（payload 无法序列化）";
  }
}

const EVENT_TONE: Record<string, string> = {
  text: "text-zinc-300",
  reasoning: "text-zinc-500",
  tool: "text-violet-300",
  "session.error": "text-red-300",
  "session.idle": "text-emerald-300",
};

function SessionDrawer({ session, onClose }: { session: LiveSession; onClose: () => void }) {
  const [events, setEvents] = useState<RunEventRow[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 事件流：复用运行详情的 SSE，按本会话所属节点过滤
  useEffect(() => {
    let disposed = false;
    const seen = new Set<number>();
    const es = new EventSource(`/api/runs/${session.runId}/events`);
    setEvents([]);
    setStreamError(null);

    es.addEventListener("log", (e) => {
      if (disposed) return;
      try {
        const row = JSON.parse((e as MessageEvent<string>).data) as RunEventRow;
        if (row.nodeId !== session.nodeId) return;
        if (seen.has(row.id)) return;
        seen.add(row.id);
        setEvents((prev) => {
          const next = [...prev, row];
          return next.length > EVENT_LIMIT ? next.slice(next.length - EVENT_LIMIT) : next;
        });
      } catch {
        // 忽略坏帧
      }
    });
    es.addEventListener("end", () => {
      es.close();
    });
    es.onerror = () => {
      if (!disposed) setStreamError("事件流连接中断");
    };

    return () => {
      disposed = true;
      es.close();
    };
  }, [session.runId, session.nodeId]);

  // 自动滚底（暂停时不动）
  useEffect(() => {
    if (paused) return;
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, paused]);

  return (
    <aside className="ff-slide-in-right flex w-[26rem] shrink-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
      <header className="flex items-start justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Dot tone="sky" pulse />
            <Num className="text-sm text-zinc-200">{session.sessionId}</Num>
          </div>
          <p className="mt-1 truncate text-[11px] text-zinc-500">
            {session.workflowName} · {session.nodeLabel}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded border border-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
        >
          关闭
        </button>
      </header>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-b border-zinc-800 px-4 py-3 text-[11px]">
        <div>
          <dt className="text-zinc-600">Action</dt>
          <dd className="truncate text-zinc-300">{session.actionName || "—"}</dd>
        </div>
        <div>
          <dt className="text-zinc-600">模型 · 强度</dt>
          <dd className="truncate font-mono text-zinc-300">
            {session.model || "—"}
            {session.variant ? ` · ${session.variant}` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-600">已用时</dt>
          <dd>
            <Num className="text-zinc-300">{elapsedText(session)}</Num>
          </dd>
        </div>
        <div>
          <dt className="text-zinc-600">用量</dt>
          <dd>
            <Num className="text-zinc-300">{formatTokens(session.tokens)}</Num>
            <span className="mx-1 text-zinc-700">·</span>
            <Num className="text-zinc-300">{formatCost(session.cost)}</Num>
          </dd>
        </div>
      </dl>

      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2 text-[11px] text-zinc-500">
        <span>
          事件流 <Num className="text-zinc-400">{events.length}</Num>
        </span>
        <div className="flex items-center gap-2">
          <Link
            href={`/runs/${session.runId}`}
            className="text-zinc-500 underline transition-colors hover:text-zinc-300"
          >
            运行详情
          </Link>
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className={`rounded border px-2 py-0.5 transition-colors ${
              paused
                ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                : "border-zinc-800 text-zinc-400 hover:bg-zinc-800"
            }`}
          >
            {paused ? "已暂停滚动" : "自动滚底"}
          </button>
        </div>
      </div>

      <div
        ref={boxRef}
        className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11px] leading-5"
      >
        {streamError && <p className="mb-2 text-red-400">{streamError}</p>}
        {events.length === 0 ? (
          <p className="py-8 text-center text-zinc-600">等待该会话产生事件…</p>
        ) : (
          events.map((row) => {
            const ts = toMillis(row.ts);
            return (
              <div key={row.id} className="break-all whitespace-pre-wrap text-zinc-400">
                <span className="text-zinc-600">[{ts == null ? "--:--:--" : formatClock(ts)}]</span>{" "}
                <span className={`font-semibold ${EVENT_TONE[row.type] ?? "text-zinc-300"}`}>
                  {row.type}
                </span>{" "}
                {eventSummary(row)}
              </div>
            );
          })
        )}
      </div>

      <CancelRunPanel session={session} />
    </aside>
  );
}

/* ---------------------- 中止运行（二次确认 + 影响面） ---------------------- */

interface RunDetail {
  run: RunRow;
  nodes: RunNodeRow[];
}

function CancelRunPanel({ session }: { session: LiveSession }) {
  const [confirming, setConfirming] = useState(false);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // 展开确认时拉一次运行详情，算出「谁会被中止、谁会被跳过」
  useEffect(() => {
    if (!confirming) return;
    let disposed = false;
    void (async () => {
      try {
        const res = await fetch(`/api/runs/${session.runId}`, {
          cache: "no-store",
        });
        const data = (await res.json()) as unknown;
        if (disposed || !res.ok || typeof data !== "object" || data === null) {
          return;
        }
        setDetail(data as RunDetail);
      } catch {
        // 影响面预览拿不到不阻断操作，只是少一块信息
      }
    })();
    return () => {
      disposed = true;
    };
  }, [confirming, session.runId]);

  const impact = useMemo(() => {
    const nodes = detail?.nodes ?? [];
    return {
      running: nodes.filter((n) => n.status === "running"),
      pending: nodes.filter((n) => n.status === "pending"),
      success: nodes.filter((n) => n.status === "success").length,
    };
  }, [detail]);

  const doCancel = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${session.runId}/cancel`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
      } | null;
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : "中止运行失败");
        return;
      }
      setDone(true);
      setConfirming(false);
    } catch {
      setError("网络错误，中止运行失败");
    } finally {
      setPending(false);
    }
  }, [session.runId]);

  if (done) {
    return (
      <div className="border-t border-zinc-800 px-4 py-3 text-[11px] text-zinc-500">
        已发出中止请求，会话释放后本行将从列表消失。
      </div>
    );
  }

  if (!confirming) {
    return (
      <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-3">
        <span className="text-[11px] text-zinc-600">中止会终结整次运行，不可恢复</span>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
          className="rounded border border-red-500/40 bg-red-500/10 px-3 py-1 text-xs text-red-300 transition-colors hover:bg-red-500/20"
        >
          中止该运行
        </button>
      </div>
    );
  }

  return (
    <div className="ff-fade-in space-y-2 border-t border-red-500/30 bg-red-500/5 px-4 py-3 text-[11px]">
      <p className="text-sm text-red-200">确认中止这次运行？</p>
      <div className="space-y-1 text-zinc-400">
        <p>
          运行 <Num className="text-zinc-300">{session.runId.slice(0, 8)}</Num> ·{" "}
          {session.workflowName}
        </p>
        {detail ? (
          <>
            <p>
              <span className="text-red-300">{impact.running.length} 个节点</span>
              正在执行，其 opencode 会话将被 abort 并标记为「已取消」
              {impact.running.length > 0 && (
                <span className="text-zinc-500">
                  （{impact.running.map((n) => n.label).join("、")}）
                </span>
              )}
            </p>
            <p>
              <span className="text-amber-300">{impact.pending.length} 个节点</span>
              尚未开始，将标记为「已跳过」
            </p>
            <p className="text-zinc-500">
              已完成的 {impact.success} 个节点及其产出保留，运行终态为「已取消」 （不计为失败）。
            </p>
          </>
        ) : (
          <p className="text-zinc-500">正在读取影响面…</p>
        )}
      </div>
      {error && <p className="text-red-300">{error}</p>}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          disabled={pending}
          onClick={() => void doCancel()}
          className="rounded border border-red-500/50 bg-red-500/15 px-3 py-1 text-xs text-red-200 transition-colors hover:bg-red-500/25 disabled:opacity-50"
        >
          {pending ? "中止中…" : "确认中止"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirming(false)}
          className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 disabled:opacity-50"
        >
          再想想
        </button>
      </div>
    </div>
  );
}
