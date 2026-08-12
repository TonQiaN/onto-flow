"use client";

/**
 * Trace 甘特图：把 `/api/monitor/trace/[runId]` 的 span 列表按 parentId 还原成树，
 * 缩进渲染，每行一条时间条（left = startMs / 总时长，width = durMs / 总时长）。
 *
 * 时间口径：所有 startMs 都是相对 run.startedAt 的毫秒偏移（见 server/monitor/types.ts）。
 */

import { useMemo, useState } from "react";
import { formatCost, formatDateTime, formatDuration, formatTokens } from "@/app/runs/lib";
import { MonitorEmpty, Num } from "../ui";
import type { SpanStatus, TraceRunInfo, TraceSpan } from "@/server/monitor/types";

/** 状态配色：成功绿 / 失败红 / 取消琥珀 / 跳过灰 / 运行中蓝 / 等待暗灰 */
const STATUS_STYLE: Record<SpanStatus, { bar: string; dot: string; text: string; label: string }> = {
  success: {
    bar: "bg-emerald-500/80",
    dot: "bg-emerald-400",
    text: "text-emerald-300",
    label: "成功",
  },
  failed: {
    bar: "bg-red-500/80",
    dot: "bg-red-400",
    text: "text-red-300",
    label: "失败",
  },
  cancelled: {
    bar: "bg-amber-500/80",
    dot: "bg-amber-400",
    text: "text-amber-300",
    label: "已取消",
  },
  skipped: {
    bar: "bg-zinc-600/70",
    dot: "bg-zinc-500",
    text: "text-zinc-400",
    label: "已跳过",
  },
  running: {
    bar: "bg-sky-500/80",
    dot: "bg-sky-400",
    text: "text-sky-300",
    label: "运行中",
  },
  pending: {
    bar: "bg-zinc-700/70",
    dot: "bg-zinc-600",
    text: "text-zinc-500",
    label: "等待中",
  },
};

const KIND_TAG: Record<TraceSpan["kind"], string> = {
  run: "RUN",
  node: "NODE",
  session: "SESS",
  step: "STEP",
};

function styleOf(status: SpanStatus) {
  return STATUS_STYLE[status] ?? STATUS_STYLE.pending;
}

interface Laid {
  span: TraceSpan;
  depth: number;
}

/** 按 parentId 还原树并做前序展开；同级按 startMs 排序，孤儿挂到根后面 */
function layout(spans: TraceSpan[]): Laid[] {
  const childrenOf = new Map<string, TraceSpan[]>();
  const byId = new Map(spans.map((s) => [s.id, s]));
  const roots: TraceSpan[] = [];
  for (const span of spans) {
    if (span.parentId && byId.has(span.parentId)) {
      const list = childrenOf.get(span.parentId);
      if (list) list.push(span);
      else childrenOf.set(span.parentId, [span]);
    } else {
      roots.push(span);
    }
  }
  const sortFn = (a: TraceSpan, b: TraceSpan) =>
    a.startMs - b.startMs || a.id.localeCompare(b.id);
  const out: Laid[] = [];
  const walk = (span: TraceSpan, depth: number) => {
    out.push({ span, depth });
    const kids = (childrenOf.get(span.id) ?? []).sort(sortFn);
    for (const kid of kids) walk(kid, depth + 1);
  };
  for (const root of roots.sort(sortFn)) walk(root, 0);
  return out;
}

export function TraceGantt({
  run,
  spans,
}: {
  run: TraceRunInfo;
  spans: TraceSpan[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  const rows = useMemo(() => layout(spans), [spans]);
  const totalMs = useMemo(
    () =>
      Math.max(
        1,
        ...spans.map((s) => s.startMs + s.durMs),
        spans.find((s) => s.kind === "run")?.durMs ?? 1,
      ),
    [spans],
  );
  const slowest = useMemo(
    () =>
      spans
        .filter((s) => s.kind !== "run" && s.durMs > 0)
        .sort((a, b) => b.durMs - a.durMs)
        .slice(0, 5),
    [spans],
  );

  if (rows.length === 0) {
    return (
      <MonitorEmpty
        title="这次运行没有可展开的 span"
        description="运行刚建立、或节点尚未开始执行时会是这样。"
      />
    );
  }

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((r) => totalMs * r);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {slowest.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-zinc-500">耗时 TOP 5</span>
          {slowest.map((s) => (
            <button
              key={`top-${s.id}`}
              type="button"
              onClick={() => setOpenId(openId === s.id ? null : s.id)}
              className="inline-flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:border-zinc-600"
            >
              <span className={`h-1.5 w-1.5 rounded-full ${styleOf(s.status).dot}`} />
              <span className="max-w-[200px] truncate">{s.label}</span>
              <Num className="text-zinc-500">
                {formatDuration(s.durMs)} · {((s.durMs / totalMs) * 100).toFixed(0)}%
              </Num>
            </button>
          ))}
        </div>
      )}

      <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/60">
        {/* 时间轴刻度 */}
        <div className="flex items-center border-b border-zinc-800 px-3 py-2 text-[11px] text-zinc-500">
          <div className="w-[280px] shrink-0">span（{rows.length} 条）</div>
          <div className="relative h-4 flex-1">
            {ticks.map((t, i) => (
              <span
                key={i}
                className="absolute top-0 font-mono tabular-nums whitespace-nowrap"
                style={{
                  left: `${(t / totalMs) * 100}%`,
                  transform: i === ticks.length - 1 ? "translateX(-100%)" : undefined,
                }}
              >
                {t === 0 ? "0" : `+${formatDuration(t)}`}
              </span>
            ))}
          </div>
          <div className="w-[210px] shrink-0 text-right">耗时 / token / 费用</div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {rows.map(({ span, depth }) => {
            const style = styleOf(span.status);
            const open = openId === span.id;
            const left = Math.min((span.startMs / totalMs) * 100, 99.6);
            const width = Math.min(
              Math.max((span.durMs / totalMs) * 100, 0.4),
              100 - left,
            );
            const absStart = run.startedAt + span.startMs;
            return (
              <div key={span.id} className="border-b border-zinc-800/60 last:border-b-0">
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : span.id)}
                  aria-expanded={open}
                  title={`${span.label}\n起点 +${span.startMs} 毫秒（${formatDateTime(
                    absStart,
                  )}）\n耗时 ${span.durMs} 毫秒\n状态 ${style.label}`}
                  className={`flex w-full items-center px-3 py-1.5 text-left transition-colors hover:bg-zinc-800/50 ${
                    open ? "bg-zinc-800/60" : ""
                  }`}
                >
                  <div
                    className="flex w-[280px] shrink-0 items-center gap-1.5 pr-2"
                    style={{ paddingLeft: `${depth * 14}px` }}
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
                    <span className="shrink-0 rounded border border-zinc-800 px-1 font-mono text-[9px] text-zinc-500">
                      {KIND_TAG[span.kind]}
                    </span>
                    <span
                      className={`truncate text-[11px] ${
                        span.kind === "run" ? "text-zinc-100" : "text-zinc-300"
                      } ${span.kind === "session" || span.kind === "step" ? "font-mono" : ""}`}
                    >
                      {span.label}
                    </span>
                  </div>

                  <div className="relative h-4 flex-1 rounded-sm bg-zinc-950/70">
                    {span.durMs === 0 && span.status === "skipped" ? (
                      <span className="absolute inset-y-0 left-0 flex items-center pl-1 font-mono text-[10px] text-zinc-600">
                        未执行
                      </span>
                    ) : (
                      <div
                        className={`absolute inset-y-0.5 rounded-sm ${style.bar}`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                      />
                    )}
                  </div>

                  <div className="flex w-[210px] shrink-0 items-center justify-end gap-3 pl-2 text-[11px]">
                    <Num className={style.text}>{formatDuration(span.durMs)}</Num>
                    <Num className="w-16 text-right text-zinc-500">
                      {span.tokens > 0 ? formatTokens(span.tokens) : "—"}
                    </Num>
                    <Num className="w-16 text-right text-zinc-500">
                      {span.cost > 0 ? formatCost(span.cost) : "—"}
                    </Num>
                  </div>
                </button>

                {open && (
                  <div className="border-t border-zinc-800/60 bg-zinc-950/60 px-3 py-3">
                    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-zinc-500">
                      <span>{span.id}</span>
                      <span>{formatDateTime(absStart)}</span>
                      <Num>起点 +{span.startMs} ms</Num>
                      <Num>耗时 {span.durMs} ms</Num>
                      <span>状态 {style.label}</span>
                      {span.tokens > 0 && <Num>token {formatTokens(span.tokens)}</Num>}
                      {span.cost > 0 && <Num>{formatCost(span.cost)}</Num>}
                    </div>
                    <pre className="max-h-[360px] overflow-auto font-mono text-[11px] leading-5 whitespace-pre-wrap text-zinc-300">
                      {span.detail?.trim() || "（该 span 没有附加详情）"}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-[11px] text-zinc-500">
        {(Object.keys(STATUS_STYLE) as SpanStatus[]).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span className={`inline-block h-2 w-4 rounded-[2px] ${STATUS_STYLE[s].bar}`} />
            {STATUS_STYLE[s].label}
          </span>
        ))}
        <span>点击任意行展开详情</span>
      </div>
    </div>
  );
}
