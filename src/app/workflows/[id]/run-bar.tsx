"use client";

/**
 * 画布顶部的运行条（模块 C）。
 *
 * 运行中：第 N/M 个节点 · 已用时 · 总 token · 总费用 · [自动跟随] · [取消运行] · [查看运行详情]
 * 结束后：变成结果条（成功绿 / 失败红 / 取消琥珀），可一键关闭。
 *
 * 数据全部来自 useRunVisuals()（SSE 驱动），本组件不发请求，
 * 唯一的写操作是「取消运行」——经 visuals.cancel() 打到 POST /api/runs/<id>/cancel，
 * 且必须二次确认（取消是不可逆的人为终态）。
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  formatCost,
  formatDuration,
  formatTokens,
  type RunVisualRunStatus,
  type RunVisuals,
} from "./use-run-visuals";

const THEME: Record<
  RunVisualRunStatus,
  { bar: string; text: string; dot: string; label: string; progress: string }
> = {
  running: {
    bar: "border-blue-200 bg-blue-50",
    text: "text-blue-800",
    dot: "animate-pulse bg-blue-500",
    label: "运行中",
    progress: "bg-blue-500",
  },
  success: {
    bar: "border-emerald-200 bg-emerald-50",
    text: "text-emerald-800",
    dot: "bg-emerald-500",
    label: "运行成功",
    progress: "bg-emerald-500",
  },
  failed: {
    bar: "border-red-200 bg-red-50",
    text: "text-red-800",
    dot: "bg-red-500",
    label: "运行失败",
    progress: "bg-red-500",
  },
  cancelled: {
    bar: "border-amber-200 bg-amber-50",
    text: "text-amber-800",
    dot: "bg-amber-500",
    label: "已取消",
    progress: "bg-amber-500",
  },
};

function Divider() {
  return <span className="text-zinc-300">·</span>;
}

export function RunBar({
  visuals,
  runsInFlight = [],
  onSwitch,
}: {
  visuals: RunVisuals;
  /** 本工作流当前进行中的全部运行（editor 轮询喂入），用于并行切换 */
  runsInFlight?: Array<{ id: string; startedAt: string | number }>;
  onSwitch?: (runId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  const {
    runId,
    runStatus,
    runError,
    connection,
    totals,
    elapsedMs,
    followMode,
    followPaused,
    setFollowMode,
    resumeFollow,
    cancelling,
    cancelError,
    cancel,
    visible,
    dismiss,
  } = visuals;

  const running = runStatus === "running";

  // 运行一结束，取消确认态自动收起
  useEffect(() => {
    if (!running) setConfirming(false);
  }, [running]);

  if (!visible || !runId || !runStatus) return null;

  const theme = THEME[runStatus];
  const percent = totals.total > 0 ? Math.round((totals.done / totals.total) * 100) : 0;

  // 并行切换器：本工作流同时有多路运行，或正跟着的这路已结束而别的还在跑时出现。
  const followedInFlight = runsInFlight.some((run) => run.id === runId);
  const showSwitcher =
    onSwitch !== undefined &&
    (runsInFlight.length > 1 || (runsInFlight.length === 1 && !followedInFlight));

  return (
    <div className={`ff-fade-in relative border-b ${theme.bar}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs">
        <span className={`flex items-center gap-1.5 font-medium ${theme.text}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${theme.dot}`} />
          {theme.label}
        </span>

        {showSwitcher && (
          <>
            <Divider />
            <label className="flex items-center gap-1.5 text-zinc-600">
              <span>并行 {runsInFlight.length} 路</span>
              <select
                data-testid="run-switcher"
                value={followedInFlight ? runId : ""}
                onChange={(e) => {
                  if (e.target.value) onSwitch(e.target.value);
                }}
                className="rounded-md border border-zinc-300 bg-white px-1.5 py-0.5 font-mono text-[11px] text-zinc-700"
              >
                {!followedInFlight && <option value="">{runId.slice(0, 8)}（已结束）</option>}
                {runsInFlight.map((run, index) => (
                  <option key={run.id} value={run.id}>
                    第 {index + 1} 路 · {run.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        <Divider />
        <span className="tabular-nums text-zinc-600">
          {running
            ? `第 ${totals.currentIndex}/${totals.total} 个节点`
            : `${totals.total} 个节点 · 成功 ${totals.success}${
                totals.failed > 0 ? ` · 失败 ${totals.failed}` : ""
              }${totals.cancelled > 0 ? ` · 取消 ${totals.cancelled}` : ""}${
                totals.skipped > 0 ? ` · 跳过 ${totals.skipped}` : ""
              }`}
        </span>

        <Divider />
        <span className="tabular-nums text-zinc-600">已用时 {formatDuration(elapsedMs)}</span>

        <Divider />
        <span className="tabular-nums text-zinc-600">
          {formatTokens(totals.totalTokens)} tokens
        </span>

        <Divider />
        <span className="tabular-nums text-zinc-600">{formatCost(totals.cost)}</span>

        {connection === "error" && (
          <>
            <Divider />
            <span className="text-amber-700">
              事件流已断开（已重连一次仍失败），状态可能不再更新
            </span>
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          {running && (
            <button
              type="button"
              onClick={() => {
                if (followPaused) resumeFollow();
                else setFollowMode(!followMode);
              }}
              title={followPaused ? "你手动平移过画布，跟随已暂停" : "自动把正在执行的节点带入视野"}
              className={`rounded-md border px-2 py-1 transition-colors ${
                followMode && !followPaused
                  ? "border-blue-300 bg-blue-100 text-blue-800"
                  : "border-zinc-300 bg-white text-zinc-500 hover:bg-zinc-50"
              }`}
            >
              {followMode
                ? followPaused
                  ? "跟随已暂停 · 点击恢复"
                  : "自动跟随 · 开"
                : "自动跟随 · 关"}
            </button>
          )}

          {running &&
            (confirming ? (
              <span className="flex items-center gap-1.5">
                <span className="text-zinc-600">确定取消这次运行？</span>
                <button
                  type="button"
                  disabled={cancelling}
                  onClick={() => {
                    setConfirming(false);
                    void cancel();
                  }}
                  className="rounded-md bg-amber-600 px-2 py-1 text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  {cancelling ? "取消中…" : "确认取消"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-zinc-600 hover:bg-zinc-50"
                >
                  再等等
                </button>
              </span>
            ) : (
              <button
                type="button"
                disabled={cancelling}
                onClick={() => setConfirming(true)}
                className="rounded-md border border-amber-300 bg-white px-2 py-1 text-amber-700 hover:bg-amber-50 disabled:opacity-50"
              >
                取消运行
              </button>
            ))}

          <Link
            href={`/runs/${runId}`}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-zinc-600 hover:bg-zinc-50"
          >
            查看运行详情
          </Link>

          {!running && (
            <button
              type="button"
              onClick={dismiss}
              title="关闭结果条"
              className="rounded-md px-1.5 py-1 text-zinc-400 hover:bg-white hover:text-zinc-700"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {(runError || cancelError) && (
        <p className="px-4 pb-1.5 text-[11px] text-red-700">{cancelError ?? runError}</p>
      )}

      {/* 进度细条：已结束节点占比 */}
      <div className="absolute inset-x-0 bottom-0 h-0.5 bg-black/5">
        <div
          className={`h-full transition-[width] duration-500 ease-out ${theme.progress}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
