"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const items = [
  { href: "/workflows", label: "工作流" },
  { href: "/actions", label: "Action 库" },
  { href: "/skills", label: "Skill 库" },
  { href: "/tools", label: "Tool 库" },
  { href: "/object-types", label: "对象类型" },
  { href: "/runs", label: "运行历史" },
  { href: "/documents", label: "归档文档" },
];

/** 设置与监控台一样属于开发者面，与主导航分区放在底部。 */
const SETTINGS_HREF = "/settings";

/** 「运行中」面板与监控台状态点共用一次轮询（轻量，不占用 SSE 连接） */
const LIVE_POLL_MS = 5000;

/** 面板逐条列出的上限；超出的经「全部 N 路」跳运行历史 */
const LIVE_LIST_MAX = 6;

interface LiveRun {
  id: string;
  workflowId: string;
  workflowName: string;
  startedAt: string | number;
  nodesTotal: number;
  nodesDone: number;
}

/**
 * 进行中的运行清单。运行彼此并行独立，看过程必须能各跳各的，
 * 一个总数徽章不够——这里把每一路都列出来，点击深链到对应画布。
 */
function useLiveRuns(): LiveRun[] | null {
  const [runs, setRuns] = useState<LiveRun[] | null>(null);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const res = await fetch("/api/runs?status=running", {
          cache: "no-store",
        });
        if (!res.ok) throw new Error("failed");
        const data = (await res.json()) as unknown;
        if (disposed) return;
        setRuns(Array.isArray(data) ? (data as LiveRun[]) : []);
      } catch {
        if (!disposed) setRuns(null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), LIVE_POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  return runs;
}

function elapsedText(startedAt: string | number): string {
  const started = typeof startedAt === "number" ? startedAt : new Date(startedAt).getTime();
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

export function Nav() {
  const pathname = usePathname();
  const liveRuns = useLiveRuns();
  const monitorActive = pathname.startsWith("/monitor");
  const live = liveRuns != null && liveRuns.length > 0;

  return (
    <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-4">
      {items.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`rounded-md px-3 py-2 text-sm transition-colors ${
              active
                ? "bg-zinc-700 text-white"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            }`}
          >
            {item.label}
          </Link>
        );
      })}

      {live && (
        <div data-testid="nav-running-runs" className="mt-2">
          <div className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[11px] font-medium tracking-wide text-zinc-500">
            <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            运行中 · {liveRuns.length} 路
          </div>
          {liveRuns.slice(0, LIVE_LIST_MAX).map((run) => (
            <Link
              key={run.id}
              data-testid="nav-running-run"
              href={`/workflows/${encodeURIComponent(run.workflowId)}?runId=${encodeURIComponent(run.id)}`}
              title={`${run.workflowName} · ${run.id}`}
              className="block rounded-md px-3 py-1.5 transition-colors hover:bg-zinc-800"
            >
              <span className="block truncate text-xs text-zinc-200">
                {run.workflowName || "（未命名工作流）"}
              </span>
              <span className="block font-mono text-[10px] tabular-nums text-zinc-500">
                {run.id.slice(0, 8)} · 节点 {run.nodesDone}/{run.nodesTotal} ·{" "}
                {elapsedText(run.startedAt)}
              </span>
            </Link>
          ))}
          {liveRuns.length > LIVE_LIST_MAX && (
            <Link
              href="/runs?status=running"
              className="block rounded-md px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
            >
              全部 {liveRuns.length} 路 →
            </Link>
          )}
        </div>
      )}

      {/* 设置与监控台属于开发者面，与主导航分区：底部独立一块 */}
      <div className="mt-auto pt-3">
        <div className="mb-3 border-t border-zinc-800" />
        <Link
          href={SETTINGS_HREF}
          className={`mb-1 flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
            pathname.startsWith(SETTINGS_HREF)
              ? "bg-zinc-700 text-white"
              : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          }`}
        >
          全局设置
        </Link>
        <Link
          href="/monitor"
          title={
            liveRuns == null
              ? "监控台"
              : live
                ? `监控台 · ${liveRuns.length} 个运行进行中`
                : "监控台 · 引擎空闲"
          }
          className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
            monitorActive
              ? "bg-zinc-700 text-white"
              : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          }`}
        >
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              live
                ? "animate-pulse bg-emerald-400"
                : liveRuns == null
                  ? "bg-zinc-600"
                  : "bg-zinc-500"
            }`}
          />
          监控台
          {live && (
            <span className="ml-auto font-mono text-[11px] text-emerald-400">
              {liveRuns.length}
            </span>
          )}
        </Link>
      </div>
    </nav>
  );
}
