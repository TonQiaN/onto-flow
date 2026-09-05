"use client";

/**
 * 节点抽屉：点画布节点或时间轴行名打开，错误置顶，三页签。
 *
 * 「输入输出」「快照」看**光标所在那一轮**——重入会覆盖 `run_nodes` 上的这三列，读它会让
 * 光标停在第 1 轮时看到最后一轮的东西。轮次骨架随运行详情与 SSE 下发，这两个页签要的重载荷
 * 在打开或换轮时按轮单取 `/api/runs/[id]/nodes/[nodeId]/rounds/[round]`（快照含整份提示与技能
 * 正文，跟着每一帧 snapshot 走等于反复推送同一份大对象），取过的轮缓存在组件里。
 * 「轨迹」不依赖轮次表：接口按节点读各轮会话 JSONL，光标所在轮的会话 id 只用来定位与高亮。
 */
import { useEffect, useRef, useState } from "react";
import {
  durationText,
  formatDateTime,
  toMillis,
  type NodeStatus,
  type RunNodeRoundPayload,
  type RunNodeRoundRow,
} from "../lib";
import { StatusBadge } from "../status-badge";
import { AgentTrajectory } from "./agent-trajectory";
import { PortValueView } from "./port-value-view";
import { SnapshotView } from "./snapshot-view";
import { ArtifactValidationView } from "./artifact-validation-view";

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

/** 这一轮是否留下了端口值：被清理置空与「本就没有」都落在同一句文案上 */
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

/** 内容已不在（被清理，或这一轮本就没有）时的说明，与轨迹面板的 unavailable 同一风格 */
function Gone({ children }: { children: React.ReactNode }) {
  return <p className="px-6 py-10 text-center text-xs leading-5 text-zinc-400">{children}</p>;
}

/** 一轮重载荷的取数状态；键是轮次号，组件按节点重挂载（page.tsx 的 key），不会串节点 */
type PayloadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; payload: RunNodeRoundPayload };

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
  const [payloads, setPayloads] = useState<Record<number, PayloadState>>({});
  const [retryTick, setRetryTick] = useState(0);
  /** 已发过请求的轮次：放 ref 不放 state，否则写入缓存会让取数 effect 自己重跑一遍 */
  const requested = useRef(new Set<number>());

  const started = round ? toMillis(round.startedAt) : null;
  const roundNo = round?.round ?? null;
  /** 只有这两个页签要重载荷；停在轨迹页签就一条请求都不发 */
  const needsPayload = (tab === "io" || tab === "snapshot") && roundNo != null;
  const entry = roundNo == null ? undefined : payloads[roundNo];

  useEffect(() => {
    if (!needsPayload || roundNo == null) return;
    if (requested.current.has(roundNo)) return;
    requested.current.add(roundNo);
    setPayloads((prev) => ({ ...prev, [roundNo]: { status: "loading" } }));
    void (async () => {
      const fail = (message: string) =>
        setPayloads((prev) => ({ ...prev, [roundNo]: { status: "error", message } }));
      try {
        const res = await fetch(
          `/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/rounds/${roundNo}`,
          { cache: "no-store" },
        );
        const data = await res.json();
        if (!res.ok) {
          fail(typeof data?.error === "string" ? data.error : "读取这一轮的记录失败");
          return;
        }
        setPayloads((prev) => ({
          ...prev,
          [roundNo]: { status: "ready", payload: data as RunNodeRoundPayload },
        }));
      } catch {
        fail("网络错误，读取这一轮的记录失败");
      }
    })();
  }, [needsPayload, roundNo, runId, nodeId, retryTick]);

  const retry = () => {
    if (roundNo != null) requested.current.delete(roundNo);
    setRetryTick((n) => n + 1);
  };

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
            onClick={retry}
            className="rounded border border-red-200 bg-white px-2 py-1 hover:bg-red-50"
          >
            重试
          </button>
        </div>
      );
    }
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
          ) : (
            (payloadGate("正在读取这一轮的输入输出…") ??
            (entry?.status === "ready" && hasPortValues(entry.payload) ? (
              // 换一轮就换一份产物：不重挂载的话，文件预览会留在上一轮那份内容上
              <div key={round.id} className="space-y-4">
                {entry.payload.artifactValidation && (
                  <ArtifactValidationView
                    validation={entry.payload.artifactValidation}
                    runId={runId}
                  />
                )}
                <PortSection
                  title="输入"
                  entries={Object.entries(entry.payload.inputs ?? {})}
                  runId={runId}
                />
                <PortSection
                  title="输出"
                  entries={Object.entries(entry.payload.outputs ?? {})}
                  runId={runId}
                />
              </div>
            ) : (
              <Gone>
                这一轮没有端口值：事件清理会把它们连同快照一起清空，被跳过的轮次本就没有。
                画布与时间轴的回放骨架仍在。
              </Gone>
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
                这一轮没有运行快照：事件清理会把它清空，输入 / 输出与被跳过的节点也本就没有快照。
              </Gone>
            )))
          ))}
      </div>
    </aside>
  );
}
