"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import {
  durationText,
  formatDateTime,
  toMillis,
  type RunListItem,
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

  const [rows, setRows] = useState<RunListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (isCurrent: () => boolean = () => true) => {
      try {
        const url = workflowId
          ? `/api/runs?workflowId=${encodeURIComponent(workflowId)}`
          : "/api/runs";
        const res = await fetch(url, { cache: "no-store" });
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
    [workflowId],
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

      {workflowId && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-sm text-zinc-600">
          <span>
            仅显示
            {filteredName ? `工作流「${filteredName}」` : "指定工作流"}
            的运行
          </span>
          <Link
            href="/runs"
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
          暂无运行记录
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-50 text-left text-xs text-zinc-500">
                <th className="px-4 py-2.5 font-medium">工作流</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="px-4 py-2.5 font-medium">开始时间</th>
                <th className="px-4 py-2.5 font-medium">耗时</th>
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
