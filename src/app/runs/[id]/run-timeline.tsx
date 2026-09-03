"use client";

/**
 * 运行时间轴：每个节点一行（行来自 run_nodes，按 startedAt 排序），一轮一段
 * （段来自 run_node_rounds），事件按 session_id 落在所属段上作刻度。
 *
 * 它同时是回放的操纵杆：拖动或点击某段设光标，播放 / 暂停 / 倍速由页面持有状态、这里只发指令。
 * 行名可点击打开该节点的抽屉——这也是早于 ADR-0018、画布为空的运行进入抽屉的唯一入口。
 */
import { useMemo, useRef } from "react";
import {
  formatDuration,
  toMillis,
  type RunEventRow,
  type RunNodeRoundRow,
  type RunNodeRow,
} from "../lib";

/**
 * 轨道几何写成常量：行首标签列 + 列间距，光标覆盖层的偏移与指针换算都按它算，
 * 与行栅格同一组数字，改一处必须改另一处。
 */
const LABEL_PX = 144;
const COL_GAP_PX = 8;
/** 轨道左边缘相对行容器左边缘的偏移 */
const TRACK_LEFT_PX = LABEL_PX + COL_GAP_PX;
const ROW_GRID = `${LABEL_PX}px minmax(0,1fr)`;

export const PLAYBACK_SPEEDS = [1, 10, 60] as const;

const SEGMENT_STYLE: Record<RunNodeRoundRow["status"], string> = {
  running: "bg-blue-400/80 animate-pulse",
  success: "bg-emerald-400/80",
  failed: "bg-red-400/80",
  cancelled: "bg-amber-400/80",
  skipped: "border border-dashed border-zinc-300 bg-zinc-200/60",
};

/** 一行最多画多少条事件刻度：事件成千上万时按间隔抽样，密到看不清也没有意义 */
const MAX_TICKS_PER_ROW = 240;

interface Segment {
  round: number;
  status: RunNodeRoundRow["status"];
  startedAt: number;
  finishedAt: number | null;
}

interface Row {
  nodeId: string;
  label: string;
  segments: Segment[];
  ticks: Array<{ id: number; at: number; error: boolean }>;
}

function buildRows(nodes: RunNodeRow[], rounds: RunNodeRoundRow[], events: RunEventRow[]): Row[] {
  const sessionOwner = new Map<string, string>();
  for (const round of rounds) {
    if (round.sessionId) sessionOwner.set(round.sessionId, round.nodeId);
  }
  const ticksByNode = new Map<string, Row["ticks"]>();
  for (const event of events) {
    const nodeId = event.sessionId ? sessionOwner.get(event.sessionId) : undefined;
    const at = toMillis(event.ts);
    if (!nodeId || at == null) continue;
    const list = ticksByNode.get(nodeId) ?? [];
    list.push({ id: event.id, at, error: event.type === "session.error" });
    ticksByNode.set(nodeId, list);
  }

  const ordered = [...nodes].sort((a, b) => {
    const ta = toMillis(a.startedAt);
    const tb = toMillis(b.startedAt);
    if (ta == null && tb == null) return 0;
    if (ta == null) return 1;
    if (tb == null) return -1;
    return ta - tb;
  });

  return ordered.map((node) => {
    const segments = rounds
      .filter((round) => round.nodeId === node.nodeId)
      .flatMap((round) => {
        const startedAt = toMillis(round.startedAt);
        if (startedAt == null) return [];
        return [
          {
            round: round.round,
            status: round.status,
            startedAt,
            finishedAt: toMillis(round.finishedAt),
          },
        ];
      })
      .sort((a, b) => a.startedAt - b.startedAt);
    const all = ticksByNode.get(node.nodeId) ?? [];
    const step = Math.ceil(all.length / MAX_TICKS_PER_ROW);
    return {
      nodeId: node.nodeId,
      label: node.label,
      segments,
      ticks: step > 1 ? all.filter((_, index) => index % step === 0) : all,
    };
  });
}

export function RunTimeline({
  nodes,
  rounds,
  events,
  windowStart,
  windowEnd,
  t,
  playing,
  speed,
  following,
  canFollow,
  selectedNodeId,
  onSeek,
  onTogglePlay,
  onSpeed,
  onFollow,
  onSelectNode,
}: {
  nodes: RunNodeRow[];
  rounds: RunNodeRoundRow[];
  events: RunEventRow[];
  /** 时间窗：运行开始 → 结束（进行中为「现在」） */
  windowStart: number;
  windowEnd: number;
  t: number;
  playing: boolean;
  speed: number;
  following: boolean;
  /** 只有进行中的运行才谈得上「跟随现在」 */
  canFollow: boolean;
  selectedNodeId: string | null;
  onSeek: (t: number) => void;
  onTogglePlay: () => void;
  onSpeed: (speed: number) => void;
  onFollow: () => void;
  onSelectNode: (nodeId: string) => void;
}) {
  const rows = useMemo(() => buildRows(nodes, rounds, events), [nodes, rounds, events]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const span = Math.max(1, windowEnd - windowStart);
  const ratio = Math.min(1, Math.max(0, (t - windowStart) / span));

  const percent = (at: number): number =>
    Math.min(100, Math.max(0, ((at - windowStart) / span) * 100));

  const seekFromPointer = (clientX: number) => {
    const rect = bodyRef.current?.getBoundingClientRect();
    if (!rect) return;
    const trackWidth = rect.width - TRACK_LEFT_PX;
    if (trackWidth <= 0) return;
    const next = (clientX - rect.left - TRACK_LEFT_PX) / trackWidth;
    onSeek(windowStart + Math.min(1, Math.max(0, next)) * span);
  };

  return (
    <section
      data-testid="run-timeline"
      className="rounded-lg border border-zinc-200 bg-white"
      aria-label="运行时间轴"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-3 py-2">
        <button
          type="button"
          onClick={onTogglePlay}
          className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 transition-colors hover:border-zinc-400"
        >
          {playing ? "暂停" : "播放"}
        </button>
        <div className="flex items-center gap-1">
          {PLAYBACK_SPEEDS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={speed === option}
              onClick={() => onSpeed(option)}
              className={`rounded-md border px-2 py-1 font-mono text-xs transition-colors ${
                speed === option
                  ? "border-zinc-800 bg-zinc-900 text-white"
                  : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-400"
              }`}
            >
              {option}×
            </button>
          ))}
        </div>
        {canFollow && (
          <button
            type="button"
            data-testid="run-follow"
            aria-pressed={following}
            onClick={onFollow}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
              following
                ? "border-blue-300 bg-blue-50 text-blue-700"
                : "border-zinc-300 bg-white text-zinc-700 hover:border-zinc-400"
            }`}
          >
            {following ? "跟随中" : "跟随"}
          </button>
        )}
        <span className="ml-auto font-mono text-xs text-zinc-500">
          {formatDuration(t - windowStart)} / {formatDuration(span)}
        </span>
      </div>

      <div className="px-3 py-2 select-none">
        {/* 光标滑杆：与轨道同宽，拖它就是拖时间；量程是整条运行的时间窗 */}
        <div className="grid items-center gap-2 pb-1" style={{ gridTemplateColumns: ROW_GRID }}>
          <span className="px-1.5 text-[10px] text-zinc-400">时间光标</span>
          <input
            type="range"
            data-testid="run-cursor"
            data-t={t}
            aria-label="时间光标"
            min={windowStart}
            max={windowEnd}
            step={1}
            value={Math.round(Math.min(Math.max(t, windowStart), windowEnd))}
            onChange={(event) => onSeek(Number(event.currentTarget.value))}
            className="h-1.5 w-full accent-blue-600"
          />
        </div>

        <div
          ref={bodyRef}
          className="relative"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            seekFromPointer(event.clientX);
          }}
          onPointerMove={(event) => {
            if (event.buttons !== 1) return;
            seekFromPointer(event.clientX);
          }}
        >
          {rows.map((row) => (
            <div
              key={row.nodeId}
              data-testid="run-timeline-row"
              data-node-id={row.nodeId}
              className="grid items-center gap-2 py-0.5"
              style={{ gridTemplateColumns: ROW_GRID }}
            >
              <button
                type="button"
                title={row.label}
                onClick={(event) => {
                  // 行名是抽屉入口，不参与拖动光标
                  event.stopPropagation();
                  onSelectNode(row.nodeId);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                className={`truncate rounded px-1.5 py-1 text-left text-xs transition-colors ${
                  selectedNodeId === row.nodeId
                    ? "bg-zinc-900 text-white"
                    : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
                }`}
              >
                {row.label}
              </button>
              <div className="relative h-5 rounded bg-zinc-50">
                {row.segments.map((segment) => {
                  const left = percent(segment.startedAt);
                  const end = percent(segment.finishedAt ?? windowEnd);
                  return (
                    <button
                      key={segment.round}
                      type="button"
                      data-testid="run-timeline-segment"
                      data-round={segment.round}
                      data-status={segment.status}
                      title={`第 ${segment.round + 1} 轮 · ${formatDuration(
                        (segment.finishedAt ?? windowEnd) - segment.startedAt,
                      )}`}
                      // 点段落到这一轮的开头：按指针 x 换算会在极窄的段上差出一轮
                      onClick={(event) => {
                        event.stopPropagation();
                        onSeek(segment.startedAt);
                      }}
                      className={`absolute inset-y-0.5 rounded-sm ${SEGMENT_STYLE[segment.status]}`}
                      style={{ left: `${left}%`, width: `${Math.max(end - left, 0.4)}%` }}
                    />
                  );
                })}
                {row.ticks.map((tick) => (
                  <span
                    key={tick.id}
                    className={`pointer-events-none absolute inset-y-1 w-px ${
                      tick.error ? "bg-red-600/80" : "bg-zinc-900/25"
                    }`}
                    style={{ left: `${percent(tick.at)}%` }}
                  />
                ))}
              </div>
            </div>
          ))}

          {/* 光标线：只是视觉参照，拖动交给上面的滑杆与轨道上的指针 */}
          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-blue-600"
            style={{ left: `calc(${TRACK_LEFT_PX}px + (100% - ${TRACK_LEFT_PX}px) * ${ratio})` }}
          />
        </div>
      </div>
    </section>
  );
}
