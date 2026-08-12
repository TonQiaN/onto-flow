"use client";

import type { ReactNode } from "react";

/**
 * 五个库列表页统一骨架：左侧 240px 固定标签树 + 右侧自适应内容，
 * 含标题/副标题、错误横幅（带重试）、加载态与空态。
 */
export function LibraryLayout({
  title,
  subtitle,
  tree,
  children,
  toolbar,
  loading = false,
  error = null,
  onRetry,
  empty,
}: {
  title: string;
  subtitle?: string;
  /** 左栏内容，通常是 <TagTree /> */
  tree?: ReactNode;
  children?: ReactNode;
  /** 始终显示在内容区顶部的状态条，通常是 <LibraryToolbar /> */
  toolbar?: ReactNode;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** 传入后在「非加载、非错误、无数据」时替代 children 显示 */
  empty?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col p-8">
      <header className="mb-6 shrink-0">
        <h1 className="text-xl font-semibold text-zinc-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>}
      </header>

      <div className="flex min-h-0 flex-1 gap-6">
        {tree && (
          <aside className="w-60 shrink-0 overflow-hidden">{tree}</aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          {error && (
            <div className="mb-4 shrink-0 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="ml-3 underline hover:text-red-900"
                >
                  重试
                </button>
              )}
            </div>
          )}

          {toolbar && <div className="shrink-0">{toolbar}</div>}

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {loading ? (
              <p className="py-16 text-center text-sm text-zinc-400">加载中…</p>
            ) : empty ? (
              <div className="rounded-lg border border-dashed border-zinc-300 bg-white py-16 text-center text-sm text-zinc-400">
                {empty}
              </div>
            ) : (
              children
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
