"use client";

/**
 * 节点抽屉：点画布节点或时间轴行名打开，错误置顶，三页签。
 *
 * 「输入输出」「快照」读**光标所在那一轮**的 run_node_rounds 行——重入会覆盖 run_nodes
 * 上的这三列，读它会让光标停在第 1 轮时看到最后一轮的东西。
 * 「轨迹」不依赖轮次表：接口按节点读各轮会话 JSONL，光标所在轮的会话 id 只用来定位与高亮。
 */
import { useState } from "react";
import {
  durationText,
  formatDateTime,
  toMillis,
  type NodeStatus,
  type RunNodeRoundRow,
} from "../lib";
import { StatusBadge } from "../status-badge";
import { AgentTrajectory } from "./agent-trajectory";
import { PortValueView } from "./port-value-view";
import { SnapshotView } from "./snapshot-view";

type Tab = "trajectory" | "io" | "snapshot";

const TABS: Array<{ key: Tab; label: string; testId: string }> = [
  { key: "trajectory", label: "轨迹", testId: "run-drawer-tab-trajectory" },
  { key: "io", label: "输入输出", testId: "run-drawer-tab-io" },
  { key: "snapshot", label: "快照", testId: "run-drawer-tab-snapshot" },
];

function PortSection({
  title,
  entries,
  runId,
}: {
  title: string;
  entries: [string, unknown][];
  /** 文件值的正文预览要经 /api/runs/[id]/files，按运行收敛路径 */
  runId: string;
}) {
  if (entries.length === 0) return null;
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-zinc-400">{title}</div>
      <div className="space-y-2">
        {entries.map(([name, value]) => (
          <div key={name}>
            <div className="mb-1 font-mono text-xs text-zinc-500">{name}</div>
            <PortValueView value={value} runId={runId} />
          </div>
        ))}
      </div>
    </div>
  );
}

function NoRound() {
  return (
    <p className="py-10 text-center text-xs text-zinc-400">
      光标所在时刻这个节点还没有执行记录；把光标拖到它的某一轮上再看。
    </p>
  );
}

/** 内容已不在（被清理，或这一轮本就没有）时的说明，与轨迹面板的 unavailable 同一风格 */
function Gone({ children }: { children: React.ReactNode }) {
  return <p className="px-6 py-10 text-center text-xs leading-5 text-zinc-400">{children}</p>;
}

export function NodeDrawer({
  runId,
  nodeId,
  label,
  status,
  error,
  round,
  live,
  cursorMs,
  onSeek,
  onClose,
}: {
  runId: string;
  nodeId: string;
  label: string;
  /** 光标时刻的节点状态（visualsAt 推出，含终态覆盖） */
  status: NodeStatus;
  error: string | null;
  /** 光标所在那一轮；没有轮次行时为 null */
  round: RunNodeRoundRow | null;
  /** 这一轮正在跑：轨迹面板据此定时重读 */
  live: boolean;
  cursorMs: number;
  onSeek: (t: number) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("trajectory");
  const started = round ? toMillis(round.startedAt) : null;
  const hasPortValues =
    Object.keys(round?.inputs ?? {}).length > 0 || Object.keys(round?.outputs ?? {}).length > 0;

  return (
    <aside
      data-testid="run-drawer"
      data-node-id={nodeId}
      aria-label={`${label} 详情`}
      className="fixed inset-y-0 right-0 z-40 flex w-[min(34rem,94vw)] flex-col border-l border-zinc-200 bg-white shadow-2xl"
    >
      <div className="flex items-start gap-3 border-b border-zinc-200 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium text-zinc-900">{label}</span>
            <StatusBadge status={status} />
            {round && (
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-[10px] text-zinc-500">
                第 {round.round + 1} 轮
              </span>
            )}
          </div>
          <div className="mt-1 font-mono text-[10px] text-zinc-400">
            {started == null ? "尚未开始" : `开始 ${formatDateTime(started)}`}
            {round && ` · 耗时 ${durationText(round.startedAt, round.finishedAt)}`}
            {round?.exitName && ` · 出口 ${round.exitName}`}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭抽屉"
          className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-600 transition-colors hover:border-zinc-400"
        >
          关闭
        </button>
      </div>

      {error && (
        <div className="border-b border-red-100 bg-red-50 px-4 py-3 text-sm break-words whitespace-pre-wrap text-red-700">
          {error}
        </div>
      )}

      <div className="flex gap-1 border-b border-zinc-200 px-4 pt-2">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            data-testid={item.testId}
            aria-pressed={tab === item.key}
            onClick={() => setTab(item.key)}
            className={`border-b-2 px-3 py-2 text-xs transition-colors ${
              tab === item.key
                ? "border-blue-500 text-blue-700"
                : "border-transparent text-zinc-500 hover:text-zinc-900"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {tab === "trajectory" && (
          <AgentTrajectory
            runId={runId}
            nodeId={nodeId}
            nodeLabel={label}
            status={status}
            active={live}
            sessionId={round?.sessionId ?? null}
            cursorMs={cursorMs}
            onSeek={onSeek}
          />
        )}

        {tab === "io" &&
          (!round ? (
            <NoRound />
          ) : hasPortValues ? (
            // 换一轮就换一份产物：不重挂载的话，文件预览会留在上一轮那份内容上
            <div key={round.id} className="space-y-4">
              <PortSection
                title="输入"
                entries={Object.entries(round.inputs ?? {})}
                runId={runId}
              />
              <PortSection
                title="输出"
                entries={Object.entries(round.outputs ?? {})}
                runId={runId}
              />
            </div>
          ) : (
            <Gone>
              这一轮没有端口值：事件清理会把它们连同快照一起清空，被跳过的轮次本就没有。
              画布与时间轴的回放骨架仍在。
            </Gone>
          ))}

        {tab === "snapshot" &&
          (!round ? (
            <NoRound />
          ) : round.snapshot == null ? (
            <Gone>
              这一轮没有运行快照：事件清理会把它清空，输入 / 输出与被跳过的节点也本就没有快照。
            </Gone>
          ) : (
            <SnapshotView key={round.id} snapshot={round.snapshot} defaultOpen />
          ))}
      </div>
    </aside>
  );
}
