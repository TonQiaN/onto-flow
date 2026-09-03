"use client";

/**
 * 运行页：看一次运行的唯一地方（ADR-0018）。三段式——概要栏、只读画布、时间轴，
 * 点节点或时间轴行名开右侧抽屉。
 *
 * 单一时间光标 `t` 串起全部视觉：`visualsAt(t)` 推出每个节点处于哪一轮、什么状态、
 * 哪些连线已激活，抽屉的三个页签读光标所在那一轮。进行中的运行把光标钉在「现在」跟着
 * SSE 走（cursor === null），往回拖即暂停跟随，「跟随」按钮回到现在；已结束的运行光标
 * 默认停在 finishedAt，沿时间轴拖动回放。
 */
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  WORKFLOW_RUN_SOURCE,
  durationText,
  formatCost,
  formatDateTime,
  formatTokens,
  toMillis,
  type NodeStatus,
  sourceLabel,
} from "../lib";
import { StatusBadge } from "../status-badge";
import { CancelButton } from "./cancel-button";
import { NodeDrawer } from "./node-drawer";
import { RunCanvas } from "./run-canvas";
import { RunTimeline } from "./run-timeline";
import { SettingsSnapshotView } from "./settings-snapshot-view";
import { useRunStream, type RunDetail } from "./use-run-stream";
import { currentRoundOf, visualsAt } from "./visuals-at";

/** 节点状态计数的展示顺序与文案 */
const NODE_STATUS_LABELS: Array<[NodeStatus, string]> = [
  ["success", "成功"],
  ["running", "运行中"],
  ["pending", "等待中"],
  ["failed", "失败"],
  ["cancelled", "已取消"],
  ["skipped", "已跳过"],
];

/** 回放推进的节拍：每 100ms 推进 100ms × 倍速 */
const PLAYBACK_TICK_MS = 100;

/** 受理来源是 `imports.invocation.source` 的读时投影；没有 invocation 的运行只能是画布发起 */
function runSource(run: RunDetail): string {
  return run.imports?.invocation?.source ?? WORKFLOW_RUN_SOURCE;
}

/** 相对项目根目录的工作区路径；受理前还没有运行目录 */
function workspacePath(runDir: string | null): string {
  if (!runDir) return "尚未生成";
  return `${runDir.replaceAll("\\", "/").replace(/\/+$/, "")}/workspace`;
}

export default function RunDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const { run, nodes, rounds, events, loading, error, graphError, connection, now, reload } =
    useRunStream(id);

  /** null = 跟着时间窗右端走：进行中就是「现在」，已结束就是收束时刻 */
  const [cursor, setCursor] = useState<{ t: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  useEffect(() => {
    setCursor(null);
    setPlaying(false);
    setSelectedNodeId(null);
  }, [id]);

  const windowStart = run ? (toMillis(run.startedAt) ?? 0) : 0;
  const finishedAt = run ? toMillis(run.finishedAt) : null;
  const windowEnd = Math.max(finishedAt ?? now, windowStart);
  const t = cursor?.t ?? windowEnd;
  const running = run?.status === "running";
  const following = cursor === null && running === true;

  const visuals = useMemo(
    () => visualsAt({ run, nodes, rounds, events, t }),
    [run, nodes, rounds, events, t],
  );

  const seek = useCallback(
    (next: number) => {
      setCursor({ t: Math.min(Math.max(next, windowStart), windowEnd) });
    },
    [windowStart, windowEnd],
  );

  const follow = useCallback(() => {
    setCursor(null);
    setPlaying(false);
  }, []);

  const togglePlay = useCallback(() => {
    setPlaying((prev) => {
      if (prev) return false;
      // 从头播：光标本来钉在右端时，先把它放到起点，否则第一拍就到头
      setCursor((current) => current ?? { t: windowStart });
      return true;
    });
  }, [windowStart]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setCursor((prev) => {
        const next = (prev?.t ?? windowStart) + PLAYBACK_TICK_MS * speed;
        // 播到时间窗右端就把光标还给「跟随」，进行中的运行随即接上直播
        return next >= windowEnd ? null : { t: next };
      });
    }, PLAYBACK_TICK_MS);
    return () => clearInterval(timer);
  }, [playing, speed, windowStart, windowEnd]);

  // 光标回到右端即停止播放（上面的 setCursor(null) 是唯一入口）
  useEffect(() => {
    if (playing && cursor === null) setPlaying(false);
  }, [playing, cursor]);

  const selectedRound = useMemo(
    () => (selectedNodeId ? currentRoundOf(rounds, selectedNodeId, t) : null),
    [rounds, selectedNodeId, t],
  );

  const selectedLabel = useMemo(() => {
    if (!selectedNodeId) return "";
    const row = nodes.find((node) => node.nodeId === selectedNodeId);
    if (row) return row.label;
    const graphNode = run?.graph.nodes.find((node) => node.id === selectedNodeId);
    return graphNode?.label ?? selectedNodeId;
  }, [nodes, run, selectedNodeId]);

  const statusCounts = NODE_STATUS_LABELS.filter(
    ([status]) => visuals.totals.byStatus[status] > 0,
  ).map(([status, label]) => ({ status, label, count: visuals.totals.byStatus[status] }));

  return (
    // 抽屉是右侧浮层：宽屏时给正文让出等宽的右内边距，时间轴与画布在抽屉开着时仍可操作
    <div className={`mx-auto max-w-[1600px] px-6 py-5 ${selectedNodeId ? "xl:pr-[35rem]" : ""}`}>
      <div className="mb-4">
        <Link href="/runs" className="text-sm text-zinc-500 transition-colors hover:text-zinc-900">
          ← 返回运行历史
        </Link>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : loading && !run ? (
        <div className="text-sm text-zinc-500">加载中…</div>
      ) : run ? (
        <div className="space-y-4">
          <div data-testid="run-summary-bar" className="rounded-lg border border-zinc-200 bg-white">
            <div className="flex flex-wrap items-center gap-3 px-5 py-4">
              <StatusBadge status={run.status} />
              {run.workflowName && (
                <span className="font-medium text-zinc-900">{run.workflowName}</span>
              )}
              <span className="font-mono text-xs text-zinc-400">{run.id}</span>
              {running && connection === "error" && (
                <span className="text-xs text-amber-700">实时连接已断开，刷新页面重连</span>
              )}
              <div className="ml-auto flex items-center gap-4">
                {running && id && <CancelButton runId={id} onCancelled={reload} />}
                <Link
                  href={`/runs?workflowId=${encodeURIComponent(run.workflowId)}`}
                  className="text-sm text-zinc-500 underline transition-colors hover:text-zinc-900"
                >
                  查看该工作流的全部运行
                </Link>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-3 px-5 pb-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
              <div>
                <dt className="text-xs text-zinc-400">开始时间</dt>
                <dd className="mt-0.5 text-zinc-700">
                  {windowStart === 0 ? "—" : formatDateTime(windowStart)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-400">耗时</dt>
                <dd className="mt-0.5 text-zinc-700">
                  {durationText(run.startedAt, run.finishedAt)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-400">总 token</dt>
                <dd className="mt-0.5 font-mono text-zinc-700">
                  {formatTokens(visuals.totals.tokens)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-400">总费用</dt>
                <dd className="mt-0.5 font-mono text-zinc-700">
                  {formatCost(visuals.totals.cost)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-400">来源</dt>
                <dd className="mt-0.5 text-zinc-700">{sourceLabel(runSource(run))}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-zinc-400">工作区</dt>
                <dd
                  data-testid="run-workspace-path"
                  title="相对 OntoFlow 项目根目录"
                  className="mt-0.5 font-mono text-xs break-all text-zinc-500"
                >
                  {workspacePath(run.runDir)}
                </dd>
              </div>
              <div className="col-span-2 sm:col-span-3 lg:col-span-6">
                <dt className="text-xs text-zinc-400">
                  节点（共 {visuals.totals.nodes}，按光标时刻）
                </dt>
                <dd className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-zinc-700">
                  {statusCounts.length === 0
                    ? "—"
                    : statusCounts.map((item) => (
                        <span key={item.status} className="whitespace-nowrap">
                          {item.label}
                          <span className="ml-1 font-mono">{item.count}</span>
                        </span>
                      ))}
                </dd>
              </div>
            </dl>
            {run.error && (
              <div className="mx-5 mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm break-words whitespace-pre-wrap text-red-700">
                {run.error}
              </div>
            )}
          </div>

          {/* 设置快照：受理时冻结的三层设置（ADR-0016） */}
          <SettingsSnapshotView snapshot={run.settingsSnapshot} />

          {graphError && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
              这次运行的冻结图读不出形状（{graphError}），画布留空；时间轴与抽屉不受影响。
            </div>
          )}

          <div
            data-testid="run-canvas"
            className="h-[56vh] min-h-80 overflow-hidden rounded-lg border border-zinc-200"
          >
            <RunCanvas
              graph={run.graph}
              visuals={visuals}
              onSelectNode={setSelectedNodeId}
              onClearSelection={() => setSelectedNodeId(null)}
            />
          </div>

          <RunTimeline
            nodes={nodes}
            rounds={rounds}
            events={events}
            windowStart={windowStart}
            windowEnd={windowEnd}
            t={t}
            playing={playing}
            speed={speed}
            following={following}
            canFollow={running === true}
            selectedNodeId={selectedNodeId}
            onSeek={seek}
            onTogglePlay={togglePlay}
            onSpeed={setSpeed}
            onFollow={follow}
            onSelectNode={setSelectedNodeId}
          />

          {selectedNodeId && (
            <NodeDrawer
              key={selectedNodeId}
              runId={run.id}
              nodeId={selectedNodeId}
              label={selectedLabel}
              status={visuals.nodes[selectedNodeId]?.status ?? "pending"}
              error={visuals.nodes[selectedNodeId]?.error ?? null}
              round={selectedRound}
              live={running === true && selectedRound?.status === "running"}
              cursorMs={t}
              onSeek={seek}
              onClose={() => setSelectedNodeId(null)}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
