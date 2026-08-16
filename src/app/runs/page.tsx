"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import {
  asStatusFilter,
  durationText,
  formatCost,
  formatDateTime,
  formatTokens,
  RUN_STATUS_FILTERS,
  toMillis,
  type RunListItem,
  type RunStatus,
} from "./lib";
import { StatusBadge } from "./status-badge";

export default function RunsPage() {
  return (
    <Suspense
      fallback={<div className="px-8 py-6 text-sm text-zinc-500">加载中…</div>}
    >
      <RunsList />
    </Suspense>
  );
}

function RunsList() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const workflowId = searchParams.get("workflowId");
  const status = asStatusFilter(searchParams.get("status"));

  const [rows, setRows] = useState<RunListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (isCurrent: () => boolean = () => true) => {
      try {
        const query = new URLSearchParams();
        if (workflowId) query.set("workflowId", workflowId);
        if (status) query.set("status", status);
        const qs = query.toString();
        const res = await fetch(`/api/runs${qs ? `?${qs}` : ""}`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (!isCurrent()) return; // 筛选已切换，丢弃过期响应
        if (!res.ok) {
          setError(
            typeof data?.error === "string" ? data.error : "加载运行列表失败",
          );
          return;
        }
        setError(null);
        setRows(data as RunListItem[]);
      } catch {
        if (isCurrent()) setError("网络错误，加载运行列表失败");
      }
    },
    [workflowId, status],
  );

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    void load(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  // 有进行中的运行时自动轮询刷新
  useEffect(() => {
    if (!rows?.some((r) => r.status === "running")) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [rows, load]);

  // 状态筛选写进 URL（保留 workflowId），不滚动页面
  const setStatus = (next: "" | RunStatus) => {
    const query = new URLSearchParams();
    if (workflowId) query.set("workflowId", workflowId);
    if (next) query.set("status", next);
    const qs = query.toString();
    router.replace(`/runs${qs ? `?${qs}` : ""}`, { scroll: false });
  };

  const filteredName =
    workflowId && rows && rows.length > 0 ? rows[0].workflowName : null;

  return (
    <div className="mx-auto max-w-5xl px-8 py-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">运行历史</h1>
          <p className="mt-1 text-sm text-zinc-500">
            工作流的执行记录，点击行查看详情
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-50"
        >
          刷新
        </button>
      </div>

      <div className="mb-4 inline-flex rounded-lg border border-zinc-200 bg-white p-1">
        {RUN_STATUS_FILTERS.map((f) => (
          <button
            key={f.value || "all"}
            type="button"
            onClick={() => setStatus(f.value)}
            aria-pressed={status === f.value}
            className={`rounded-md px-3 py-1 text-sm transition-colors ${
              status === f.value
                ? "bg-zinc-900 text-white"
                : "text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {workflowId && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-sm text-zinc-600">
          <span>
            仅显示
            {filteredName ? `工作流「${filteredName}」` : "指定工作流"}
            的运行
          </span>
          <Link
            href={status ? `/runs?status=${status}` : "/runs"}
            className="text-zinc-400 underline transition-colors hover:text-zinc-900"
          >
            清除筛选
          </Link>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {rows === null ? (
        !error && <div className="text-sm text-zinc-500">加载中…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-12 text-center text-sm text-zinc-500">
          {status
            ? `暂无${
                RUN_STATUS_FILTERS.find((f) => f.value === status)?.label ?? ""
              }的运行记录`
            : "暂无运行记录"}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-50 text-left text-xs text-zinc-500">
                <th className="px-4 py-2.5 font-medium">工作流</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="px-4 py-2.5 font-medium">开始时间</th>
                <th className="px-4 py-2.5 font-medium">耗时</th>
                <th className="px-4 py-2.5 text-right font-medium">总 token</th>
                <th className="px-4 py-2.5 text-right font-medium">总费用</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const started = toMillis(row.startedAt);
                return (
                  <tr
                    key={row.id}
                    onClick={() => router.push(`/runs/${row.id}`)}
                    className="cursor-pointer border-t border-zinc-100 transition-colors hover:bg-zinc-50"
                  >
                    <td className="px-4 py-3 font-medium text-zinc-900">
                      {row.workflowName}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="px-4 py-3 text-zinc-600">
                      {started == null ? "—" : formatDateTime(started)}
                    </td>
                    <td className="px-4 py-3 text-zinc-600">
                      {durationText(row.startedAt, row.finishedAt)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-zinc-600">
                      {formatTokens(row.totalTokens)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-zinc-600">
                      {formatCost(row.totalCost)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
