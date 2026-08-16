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

/** 监控台入口的实时状态点：轮询进行中的运行数（轻量，不占用 SSE 连接） */
const LIVE_POLL_MS = 8000;

function useLiveRunCount(): number | null {
  const [count, setCount] = useState<number | null>(null);

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
        setCount(Array.isArray(data) ? data.length : 0);
      } catch {
        if (!disposed) setCount(null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), LIVE_POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  return count;
}

export function Nav() {
  const pathname = usePathname();
  const liveRuns = useLiveRunCount();
  const monitorActive = pathname.startsWith("/monitor");
  const live = liveRuns != null && liveRuns > 0;

  return (
    <nav className="flex min-h-0 flex-1 flex-col gap-1 px-3 pb-4">
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

      {/* 监控台与主导航分区：底部独立一块 */}
      <div className="mt-auto pt-3">
        <div className="mb-3 border-t border-zinc-800" />
        <Link
          href="/monitor"
          title={
            liveRuns == null
              ? "监控台"
              : live
                ? `监控台 · ${liveRuns} 个运行进行中`
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
              {liveRuns}
            </span>
          )}
        </Link>
      </div>
    </nav>
  );
}
