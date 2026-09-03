"use client";

/**
 * 监控台 · Trace：选一次运行，看它的全链路甘特图。
 *
 * 数据来自 `/api/monitor/trace/[runId]`（span 树）与 `/api/runs`（运行下拉）。
 * 选中的运行写进 `?runId=`，因此每条 trace 都是可分享的直达链接；
 * 运行进行中时每 3 秒自动刷新一次。
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import {
  durationText,
  formatCost,
  formatDateTime,
  formatTokens,
  toMillis,
  type RunListItem,
} from "@/app/runs/lib";
import { MonitorEmpty, MonitorErrorBar, Num, StatusChip } from "../ui";
import type { TracePayload } from "@/server/monitor/types";
import { TraceGantt } from "./gantt";

const REFRESH_MS = 3000;

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // 响应体不是 JSON
  }
  return `请求失败（HTTP ${res.status}）`;
}

export default function MonitorTracePage() {
  return (
    <Suspense fallback={<div className="px-6 py-5 text-sm text-zinc-500">加载中…</div>}>
      <TraceConsole />
    </Suspense>
  );
}

function TraceConsole() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const wantedId = searchParams.get("runId") ?? "";

  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [trace, setTrace] = useState<TracePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [auto, setAuto] = useState(true);

  // 运行下拉（默认最近一次）
  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/runs", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : "加载运行列表失败");
        setRuns([]);
        return;
      }
      setRuns(data as RunListItem[]);
    } catch {
      setError("网络错误，加载运行列表失败");
      setRuns([]);
    }
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const runId = wantedId || runs?.[0]?.id || "";

  const loadTrace = useCallback(async (id: string, silent: boolean) => {
    if (!id) {
      setTrace(null);
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`/api/monitor/trace/${id}`, { cache: "no-store" });
      if (!res.ok) {
        setError(await readError(res));
        if (!silent) setTrace(null);
        return;
      }
      setTrace((await res.json()) as TracePayload);
      setError(null);
    } catch {
      setError("网络错误，加载 Trace 失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTrace(runId, false);
  }, [runId, loadTrace]);

  // 运行进行中时自动刷新
  const live = trace?.run.status === "running";
  useEffect(() => {
    if (!live || !auto || !runId) return;
    const timer = setInterval(() => void loadTrace(runId, true), REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, auto, runId, loadTrace]);

  const selectRun = (id: string) => {
    router.replace(id ? `/monitor/trace?runId=${encodeURIComponent(id)}` : "/monitor/trace", {
      scroll: false,
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-5">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={runId}
          onChange={(e) => selectRun(e.target.value)}
          disabled={!runs || runs.length === 0}
          className="max-w-[460px] rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 font-mono text-[11px] text-zinc-200 outline-none transition-colors hover:border-zinc-700 focus:border-zinc-600 disabled:text-zinc-600"
        >
          {(runs === null || runs.length === 0) && (
            <option value="">{runs === null ? "加载中…" : "暂无运行"}</option>
          )}
          {/* 直达链接指向的运行可能不在最近 50 条里，补一条选项免得下拉显示空白 */}
          {trace && !(runs ?? []).some((r) => r.id === trace.run.id) && (
            <option value={trace.run.id}>
              {`${formatDateTime(trace.run.startedAt)} · ${
                trace.run.workflowName || "（未命名）"
              } · ${trace.run.status} · ${trace.run.id.slice(0, 8)}`}
            </option>
          )}
          {(runs ?? []).map((r) => {
            const started = toMillis(r.startedAt);
            return (
              <option key={r.id} value={r.id}>
                {`${started == null ? "—" : formatDateTime(started)} · ${
                  r.workflowName || "（未命名）"
                } · ${r.status} · ${r.id.slice(0, 8)}`}
              </option>
            );
          })}
        </select>

        <button
          type="button"
          onClick={() => void loadTrace(runId, false)}
          disabled={!runId}
          className="rounded-md border border-zinc-800 px-2.5 py-1.5 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-900 disabled:text-zinc-600"
        >
          刷新
        </button>

        {live && (
          <label className="inline-flex items-center gap-1.5 text-[11px] text-sky-300">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
              className="accent-sky-500"
            />
            自动刷新 3s
          </label>
        )}

        {trace && (
          <Link
            href={`/runs/${trace.run.id}`}
            className="ml-auto text-[11px] text-zinc-400 underline underline-offset-2 transition-colors hover:text-zinc-100"
          >
            打开运行详情 →
          </Link>
        )}
      </div>

      {error && (
        <MonitorErrorBar
          message={error}
          onRetry={() => {
            setError(null);
            void loadRuns();
            void loadTrace(runId, false);
          }}
        />
      )}

      {trace && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-2.5 text-[11px]">
          <span className="inline-flex items-center gap-2">
            <StatusChip status={trace.run.status} />
            <span className="text-zinc-300">{trace.run.workflowName || "（未命名工作流）"}</span>
          </span>
          <Field label="开始">{formatDateTime(trace.run.startedAt)}</Field>
          <Field label="总耗时">{durationText(trace.run.startedAt, trace.run.finishedAt)}</Field>
          <Field label="span">{trace.spans.length}</Field>
          <Field label="节点">{trace.spans.filter((s) => s.kind === "node").length}</Field>
          <Field label="工具/步骤">{trace.spans.filter((s) => s.kind === "step").length}</Field>
          <Field label="token">{formatTokens(trace.run.tokens)}</Field>
          <Field label="费用">{formatCost(trace.run.cost)}</Field>
        </div>
      )}

      {trace?.run.error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2.5 font-mono text-[11px] whitespace-pre-wrap text-red-300">
          {trace.run.error}
        </div>
      )}

      {loading && !trace ? (
        <div className="text-sm text-zinc-500">加载中…</div>
      ) : !runId ? (
        <MonitorEmpty
          title="还没有任何运行"
          description="先在工作流画布上跑一次，Trace 会把每个节点、每次工具调用的耗时摊平成时间线。"
          action={
            <Link
              href="/workflows"
              className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              去工作流
            </Link>
          }
        />
      ) : trace ? (
        <TraceGantt run={trace.run} spans={trace.spans} />
      ) : (
        !error && <MonitorEmpty title="没有取到这次运行的 Trace" />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-zinc-500">{label}</span>
      <Num className="text-zinc-200">{children}</Num>
    </span>
  );
}
