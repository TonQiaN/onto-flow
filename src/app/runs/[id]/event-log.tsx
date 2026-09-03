"use client";

import { useEffect, useRef } from "react";
import { compactionEventLine, formatClock, toMillis, type RunEventRow } from "../lib";

const SUMMARY_LIMIT = 200;

function payloadSummary(payload: Record<string, unknown> | null): string {
  if (payload == null) return "";
  let text: string;
  try {
    text = JSON.stringify(payload);
  } catch {
    text = String(payload);
  }
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}…` : text;
}

/** 事件日志面板：等宽小字号，时间戳 + type + payload 摘要，自动滚底 */
export function EventLog({
  events,
  nodeLabels,
  live,
}: {
  events: RunEventRow[];
  nodeLabels: Map<string, string>;
  live: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2.5">
        <h2 className="text-sm font-medium text-zinc-900">事件日志</h2>
        <span className="flex items-center gap-3 text-xs text-zinc-400">
          {live && (
            <span className="flex items-center gap-1 text-blue-600">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
              实时
            </span>
          )}
          共 {events.length} 条
        </span>
      </div>
      <div
        ref={boxRef}
        className="h-80 overflow-auto px-4 py-2 font-mono text-[11px] leading-5 text-zinc-600"
      >
        {events.length === 0 ? (
          <div className="py-6 text-center text-zinc-400">暂无事件</div>
        ) : (
          events.map((ev) => {
            const ts = toMillis(ev.ts);
            const label = ev.nodeId ? nodeLabels.get(ev.nodeId) : null;
            return (
              <div key={ev.id} className="break-all whitespace-pre-wrap">
                <span className="text-zinc-400">[{ts == null ? "--:--:--" : formatClock(ts)}]</span>{" "}
                {label && <span className="text-zinc-400">{label} · </span>}
                <span className="font-semibold text-zinc-700">{ev.type}</span>{" "}
                {ev.type === "compaction"
                  ? compactionEventLine(ev.payload)
                  : payloadSummary(ev.payload)}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
