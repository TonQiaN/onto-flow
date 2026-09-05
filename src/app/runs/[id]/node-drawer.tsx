"use client";

/**
 * 节点抽屉：点画布节点或时间轴行名打开，错误置顶，三页签。
 *
 * 「输入输出」「快照」看**光标所在那一轮**——重载荷只存在轮次行上，回查最新节点状态会让
 * 光标停在第 1 轮时看到最后一轮的东西。轮次骨架随运行详情与 SSE 下发，这两个页签要的重载荷
 * 在打开或换轮时按轮单取 `/api/runs/[id]/nodes/[nodeId]/rounds/[round]`（快照含整份提示与技能
 * 正文，跟着每一帧 snapshot 走等于反复推送同一份大对象）。终态轮缓存；运行中定时读取，
 * 会话、终态与清理标记变化时失效，迟到请求不能覆盖当前轮。
 * 「轨迹」不依赖轮次表：接口按节点读各轮会话 JSONL，光标所在轮的会话 id 只用来定位与高亮。
 */
import { useState } from "react";
import {
  durationText,
  formatDateTime,
  toMillis,
  type NodeStatus,
  type RunStatus,
  type RunNodeRoundPayload,
  type RunNodeRoundRow,
} from "../lib";
import { StatusBadge } from "../status-badge";
import { AgentTrajectory } from "./agent-trajectory";
import { PortValueView } from "./port-value-view";
import { SnapshotView } from "./snapshot-view";
import { ArtifactValidationView } from "./artifact-validation-view";
import { useRoundPayload } from "./use-round-payload";

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
  refreshKey,
}: {
  title: string;
  entries: [string, unknown][];
  /** 文件值的正文预览要经 /api/runs/[id]/files，按运行收敛路径 */
  runId: string;
  refreshKey: string;
}) {
  if (entries.length === 0) return null;
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-zinc-400">{title}</div>
      <div className="space-y-2">
        {entries.map(([name, value]) => (
          <div key={name}>
            <div className="mb-1 font-mono text-xs text-zinc-500">{name}</div>
            <PortValueView value={value} runId={runId} refreshKey={refreshKey} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** 这一轮是否留下了端口值：清理标记由载荷门禁单独呈现 */
function hasPortValues(payload: RunNodeRoundPayload): boolean {
  return (
    payload.artifactValidation != null ||
    Object.keys(payload.inputs ?? {}).length > 0 ||
    Object.keys(payload.outputs ?? {}).length > 0
  );
}

function NoRound() {
  return (
    <p className="py-10 text-center text-xs text-zinc-400">
      光标所在时刻这个节点还没有执行记录；把光标拖到它的某一轮上再看。
    </p>
  );
}

/** 内容读取成功但不可展示时的具体原因，与轨迹面板的 unavailable 同一风格 */
function Gone({ children }: { children: React.ReactNode }) {
  return <p className="px-6 py-10 text-center text-xs leading-5 text-zinc-400">{children}</p>;
}

export function NodeDrawer({
  runId,
  runStatus,
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
  runStatus: RunStatus;
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
  const needsPayload = tab === "io" || tab === "snapshot";
  const { entry, refresh, refreshTick } = useRoundPayload({
    runId,
    nodeId,
    round,
    runStatus,
    enabled: needsPayload,
  });
  const refreshKey = `${runStatus}:${refreshTick}`;
  const noOutput =
    round?.status === "running"
      ? "这一轮尚未产出；完成后会自动更新。"
      : round?.status === "failed"
        ? "这一轮执行失败，未形成可交付的输出。"
        : round?.status === "cancelled"
          ? "这一轮已取消，没有可交付的输出。"
          : round?.status === "skipped"
            ? "这一轮已跳过，没有产出。"
            : "这一轮没有输出端口值。";

  /** 两个重载荷页签共用的取数中/取数失败呈现；返回 null 表示可以画正文了 */
  const payloadGate = (loadingText: string) => {
    if (!entry || entry.status === "loading") {
      return <p className="px-6 py-10 text-center text-xs text-zinc-400">{loadingText}</p>;
    }
    if (entry.status === "error") {
      return (
        <div className="flex items-center justify-between gap-3 px-4 py-6 text-xs text-red-700">
          <span>{entry.message}</span>
          <button
            type="button"
            onClick={refresh}
            className="rounded border border-red-200 bg-white px-2 py-1 hover:bg-red-50"
          >
            重试
          </button>
        </div>
      );
    }
    if (round?.payloadClearedAt || (entry.status === "ready" && entry.payload.payloadClearedAt))
      return <Gone>这一轮的输入输出、快照与验收记录已被清理；画布与时间轴的回放骨架仍在。</Gone>;
    return null;
  };

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
        {needsPayload && round && (
          <button
            type="button"
            onClick={refresh}
            disabled={entry?.refreshing}
            className="mb-1 ml-auto rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 disabled:opacity-50"
          >
            {entry?.refreshing ? "刷新中…" : "刷新结果"}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {needsPayload && round && entry?.status === "ready" && (
          <p role="status" className="mb-3 text-[11px] text-zinc-400">
            {entry.refreshing
              ? "正在更新本轮记录…"
              : live
                ? "执行中，每 2 秒自动更新"
                : "已读取本轮记录"}
          </p>
        )}
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
          ) : (
            (payloadGate("正在读取这一轮的输入输出…") ??
            (entry?.status === "ready" && hasPortValues(entry.payload) ? (
              // 换一轮就换一份产物：不重挂载的话，文件预览会留在上一轮那份内容上
              <div key={round.id} className="space-y-4">
                {entry.payload.artifactValidation && (
                  <ArtifactValidationView
                    validation={entry.payload.artifactValidation}
                    runId={runId}
                    refreshKey={refreshKey}
                  />
                )}
                <PortSection
                  title="输入"
                  entries={Object.entries(entry.payload.inputs ?? {})}
                  runId={runId}
                  refreshKey={refreshKey}
                />
                <PortSection
                  title="输出"
                  entries={Object.entries(entry.payload.outputs ?? {})}
                  runId={runId}
                  refreshKey={refreshKey}
                />
                {Object.keys(entry.payload.outputs ?? {}).length === 0 &&
                  !entry.payload.artifactValidation && <Gone>{noOutput}</Gone>}
              </div>
            ) : (
              <Gone>{noOutput}</Gone>
            )))
          ))}

        {tab === "snapshot" &&
          (!round ? (
            <NoRound />
          ) : (
            (payloadGate("正在读取这一轮的运行快照…") ??
            (entry?.status === "ready" && entry.payload.snapshot != null ? (
              <SnapshotView key={round.id} snapshot={entry.payload.snapshot} defaultOpen />
            ) : (
              <Gone>
                {round.status === "running"
                  ? "这一轮的快照尚未就绪，会自动更新。"
                  : "这一轮未生成运行快照；输入、输出与被跳过的节点通常没有快照。"}
              </Gone>
            )))
          ))}
      </div>
    </aside>
  );
}
