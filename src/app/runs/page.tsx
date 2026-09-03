"use client";

/**
 * 运行列表 /runs（DESIGN-V3 第 2 批）：工作流 / 状态 / 来源 / 时间范围四个筛选 + 分页 +
 * 本次筛选集的用量汇总。数据只读 `GET /api/runs` 的信封
 * `{ items, total, page, pageSize, summary }`，汇总不受分页影响（服务端按同一组筛选聚合）。
 * 筛选与页码全部住 URL，刷新与分享链接都不丢；工作流卡片「历史」只是带 workflowId 的链接。
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { fetchAllPages } from "@/components/library/fetch-all-pages";
import {
  asStatusFilter,
  durationText,
  formatCost,
  formatDateTime,
  formatTokens,
  RUN_STATUS_FILTERS,
  type RunListEnvelope,
  toMillis,
  WORKFLOW_RUN_SOURCE,
  sourceLabel,
} from "./lib";
import { StatusBadge } from "./status-badge";
import {
  rangeEndInput,
  rangeEndMillis,
  rangeStartInput,
  rangeStartMillis,
  useRunsQuery,
} from "./use-runs-query";

interface WorkflowOption {
  id: string;
  name: string;
}

const SELECT_CLASS =
  "rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-800 focus:border-zinc-500 focus:outline-none";

export default function RunsPage() {
  return (
    <Suspense fallback={<div className="px-8 py-6 text-sm text-zinc-500">加载中…</div>}>
      <RunsList />
    </Suspense>
  );
}

function RunsList() {
  const router = useRouter();
  const { workflowId, status, source, from, to, page, filtered, setFilter, setPage, clearFilters } =
    useRunsQuery();

  const [data, setData] = useState<RunListEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  /**
   * 来源下拉的候选：按已加载运行里出现过的来源累积，不随当前筛选收缩——
   * 否则选中某个来源后，其余来源会被自己筛掉，下拉里再也切不回去。
   */
  const [seenSources, setSeenSources] = useState<string[]>([]);

  const queryString = useMemo(() => {
    const query = new URLSearchParams();
    if (workflowId) query.set("workflowId", workflowId);
    if (status) query.set("status", status);
    if (source) query.set("source", source);
    if (from !== null) query.set("from", String(from));
    if (to !== null) query.set("to", String(to));
    if (page > 1) query.set("page", String(page));
    return query.toString();
  }, [workflowId, status, source, from, to, page]);

  const load = useCallback(
    async (isCurrent: () => boolean = () => true) => {
      try {
        const res = await fetch(`/api/runs${queryString ? `?${queryString}` : ""}`, {
          cache: "no-store",
        });
        const payload = (await res.json()) as unknown;
        if (!isCurrent()) return; // 筛选已切换，丢弃过期响应
        if (!res.ok) {
          const message = (payload as { error?: unknown } | null)?.error;
          setError(typeof message === "string" ? message : "加载运行列表失败");
          return;
        }
        setError(null);
        const envelope = payload as RunListEnvelope;
        setData(envelope);
        setSeenSources((prev) => {
          const merged = new Set(prev);
          for (const item of envelope.items) merged.add(item.source);
          return merged.size === prev.length ? prev : [...merged].sort();
        });
      } catch {
        if (isCurrent()) setError("网络错误，加载运行列表失败");
      }
    },
    [queryString],
  );

  useEffect(() => {
    let cancelled = false;
    setData(null);
    void load(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  // 有进行中的运行时自动轮询刷新
  useEffect(() => {
    if (!data?.items.some((r) => r.status === "running")) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [data, load]);

  // 工作流下拉要全量：库超过一页时只取第一页会让后面的工作流在筛选里凭空消失
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchAllPages<WorkflowOption>("/api/workflows", {
        cache: "no-store",
      });
      if (cancelled || !result.ok) return; // 下拉是辅助功能，失败静默
      setWorkflows([...result.items].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 0;
  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;

  // 越界回夹：删到只剩一页却停在 page=3 时，页面自己跳回最后一页（hook 拿不到 total）
  useEffect(() => {
    if (data && data.items.length === 0 && total > 0 && page > totalPages) setPage(totalPages);
  }, [data, total, page, totalPages, setPage]);

  /** 已删除的工作流仍有运行历史：URL 里的 workflowId 不在库里时，用运行的冗余名兜底成一项 */
  const workflowOptions = useMemo(() => {
    if (!workflowId || workflows.some((w) => w.id === workflowId)) return workflows;
    const name = data?.items.find((r) => r.workflowId === workflowId)?.workflowName;
    return [{ id: workflowId, name: name || `工作流 ${workflowId.slice(0, 8)}` }, ...workflows];
  }, [workflows, workflowId, data]);

  const invocationSources = useMemo(() => {
    const values = new Set(seenSources.filter((s) => s !== WORKFLOW_RUN_SOURCE));
    if (source && source !== WORKFLOW_RUN_SOURCE) values.add(source);
    return [...values].sort();
  }, [seenSources, source]);

  const summary = data?.summary;
  const items = data?.items ?? [];

  return (
    <div className="mx-auto max-w-6xl px-8 py-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">运行历史</h1>
          <p className="mt-1 text-sm text-zinc-500">工作流的执行记录，点击行查看详情</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-50"
        >
          刷新
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3">
        <label className="flex items-center gap-2 text-sm text-zinc-500">
          工作流
          <select
            data-testid="runs-filter-workflow"
            value={workflowId}
            onChange={(e) => setFilter({ workflowId: e.target.value })}
            className={`${SELECT_CLASS} max-w-[220px]`}
          >
            <option value="">全部</option>
            {workflowOptions.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm text-zinc-500">
          状态
          <select
            data-testid="runs-filter-status"
            value={status}
            onChange={(e) => setFilter({ status: asStatusFilter(e.target.value) })}
            className={SELECT_CLASS}
          >
            {RUN_STATUS_FILTERS.map((f) => (
              <option key={f.value || "all"} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm text-zinc-500">
          来源
          <select
            data-testid="runs-filter-source"
            value={source}
            onChange={(e) => setFilter({ source: e.target.value })}
            className={SELECT_CLASS}
          >
            <option value="">全部</option>
            <option value={WORKFLOW_RUN_SOURCE}>{sourceLabel(WORKFLOW_RUN_SOURCE)}</option>
            {invocationSources.length > 0 && (
              <optgroup label="调用入口">
                {invocationSources.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>

        {/* 起止两个输入框成对换行：拆开时「止于」独自掉到下一行，读起来不像一个区间 */}
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <label className="flex items-center gap-2">
            开始时刻
            <input
              type="date"
              data-testid="runs-filter-from"
              value={rangeStartInput(from)}
              onChange={(e) => setFilter({ from: rangeStartMillis(e.target.value) })}
              className={SELECT_CLASS}
              aria-label="起始日期"
            />
          </label>
          <span aria-hidden="true">至</span>
          <input
            type="date"
            data-testid="runs-filter-to"
            value={rangeEndInput(to)}
            onChange={(e) => setFilter({ to: rangeEndMillis(e.target.value) })}
            className={SELECT_CLASS}
            aria-label="结束日期"
          />
        </div>

        {filtered && (
          <button
            type="button"
            onClick={clearFilters}
            className="text-sm text-zinc-400 underline transition-colors hover:text-zinc-900"
          >
            清除筛选
          </button>
        )}
      </div>

      <div
        data-testid="runs-summary"
        className="mb-3 flex flex-wrap items-center gap-6 rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-sm text-zinc-600"
      >
        <span>
          运行数{" "}
          <span className="font-medium tabular-nums text-zinc-900">{summary?.runs ?? 0}</span>
        </span>
        <span>
          总 token{" "}
          <span className="font-mono text-xs text-zinc-900">
            {formatTokens(summary?.tokens ?? 0)}
          </span>
        </span>
        <span>
          总费用{" "}
          <span className="font-mono text-xs text-zinc-900">{formatCost(summary?.cost ?? 0)}</span>
        </span>
      </div>

      <div
        data-testid="runs-summary-by-model"
        className="mb-4 rounded-lg border border-zinc-200 bg-white px-4 py-2.5"
      >
        <div className="mb-1.5 text-xs text-zinc-500">按模型</div>
        {!summary || summary.byModel.length === 0 ? (
          <div className="text-sm text-zinc-400">—</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-500">
                <th className="py-1 font-medium">提供方</th>
                <th className="py-1 font-medium">模型</th>
                <th className="py-1 text-right font-medium">token</th>
                <th className="py-1 text-right font-medium">费用</th>
              </tr>
            </thead>
            <tbody>
              {summary.byModel.map((m) => (
                <tr key={`${m.providerId}/${m.modelId}`} className="border-t border-zinc-100">
                  <td className="py-1 text-zinc-600">{m.providerId}</td>
                  <td className="py-1 font-mono text-xs text-zinc-700">{m.modelId}</td>
                  <td className="py-1 text-right font-mono text-xs text-zinc-600">
                    {formatTokens(m.tokens)}
                  </td>
                  <td className="py-1 text-right font-mono text-xs text-zinc-600">
                    {formatCost(m.cost)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {data === null ? (
        !error && <div className="text-sm text-zinc-500">加载中…</div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-12 text-center text-sm text-zinc-500">
          {filtered ? "没有符合筛选条件的运行记录" : "暂无运行记录"}
        </div>
      ) : (
        <>
          <div
            data-testid="runs-table"
            className="overflow-x-auto rounded-lg border border-zinc-200 bg-white"
          >
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-50 text-left text-xs text-zinc-500">
                  <th className="px-4 py-2.5 font-medium">运行</th>
                  <th className="px-4 py-2.5 font-medium">状态</th>
                  <th className="px-4 py-2.5 font-medium">开始时刻</th>
                  <th className="px-4 py-2.5 font-medium">耗时</th>
                  <th className="px-4 py-2.5 font-medium">节点</th>
                  <th className="px-4 py-2.5 text-right font-medium">token</th>
                  <th className="px-4 py-2.5 text-right font-medium">费用</th>
                  <th className="px-4 py-2.5 font-medium">来源</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => {
                  const started = toMillis(row.startedAt);
                  return (
                    <tr
                      key={row.id}
                      data-run-id={row.id}
                      onClick={() => router.push(`/runs/${row.id}`)}
                      className="cursor-pointer border-t border-zinc-100 transition-colors hover:bg-zinc-50"
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/runs/${row.id}`}
                          className="font-mono text-xs text-zinc-900 underline decoration-zinc-300 underline-offset-2"
                        >
                          {row.id.slice(0, 8)}
                        </Link>
                        <div className="mt-0.5 text-xs text-zinc-500">
                          {row.workflowName || "（未命名）"}
                        </div>
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
                      <td className="px-4 py-3 tabular-nums text-zinc-600">
                        {row.nodesDone}/{row.nodesTotal}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-zinc-600">
                        {formatTokens(row.totalTokens)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-zinc-600">
                        {formatCost(row.totalCost)}
                      </td>
                      <td className="px-4 py-3 text-zinc-600">{sourceLabel(row.source)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div
            data-testid="runs-pagination"
            className="mt-3 flex items-center justify-end gap-3 text-sm text-zinc-500"
          >
            <button
              type="button"
              onClick={() => setPage(page - 1)}
              disabled={page <= 1}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 disabled:hover:bg-white"
            >
              上一页
            </button>
            <span className="tabular-nums text-zinc-600">
              第 {page} 页 · 共 {total} 条
            </span>
            <button
              type="button"
              onClick={() => setPage(page + 1)}
              disabled={page >= totalPages}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 disabled:hover:bg-white"
            >
              下一页
            </button>
          </div>
        </>
      )}
    </div>
  );
}
