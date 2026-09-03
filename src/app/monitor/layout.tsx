"use client";

/**
 * 监控台外壳：深色控制台顶栏 + 五标签导航。
 *
 * 标签状态走**子路由**（不是 query），因此每个标签都是可直接分享的链接：
 * /monitor（总览）、/monitor/sessions、/monitor/trace、/monitor/logs、/monitor/health。
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const TABS: Array<{ href: string; label: string; hint: string }> = [
  { href: "/monitor", label: "总览", hint: "实时指标与 24 小时趋势" },
  { href: "/monitor/sessions", label: "实时会话", hint: "进行中的 Action 会话" },
  { href: "/monitor/trace", label: "Trace", hint: "单次运行的全链路追踪" },
  { href: "/monitor/logs", label: "日志检索", hint: "跨运行的事件检索" },
  { href: "/monitor/health", label: "系统健康", hint: "引擎与数据清理" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/monitor") return pathname === "/monitor";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function MonitorLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/monitor";
  const active = TABS.find((tab) => isActive(pathname, tab.href));

  return (
    <div className="flex min-h-full flex-col bg-zinc-950 text-zinc-200">
      <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-baseline gap-3 px-6 pt-4">
          <h1 className="text-base font-semibold tracking-tight text-white">监控台</h1>
          <span className="font-mono text-[11px] text-zinc-600">ontoflow://monitor</span>
          <span className="ml-auto text-[11px] text-zinc-500">{active?.hint}</span>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-4 pt-3 pb-2">
          {TABS.map((tab) => {
            const on = isActive(pathname, tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={on ? "page" : undefined}
                className={`rounded-md px-3 py-1.5 text-xs whitespace-nowrap transition-colors ${
                  on
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
