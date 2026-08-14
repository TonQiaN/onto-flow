"use client";

/**
 * 监控台 · 日志检索：跨运行检索 run_events。
 *
 * 数据来自 `/api/monitor/logs`（游标分页，cursor = 上一页最小 id）。多选事件类型时
 * 把类型用逗号拼给接口（服务端走单条 SQL 的 in 过滤 + 单一游标）——**不要**退回成
 * 「每类各开一条流再前端归并」：那样每条流各自分页、深度不一致，「已加载 N 条」与
 * 翻页深度都会失真，让人误判某类事件不存在。
 *
 * 全部筛选条件写进 URL（?runId=&nodeId=&types=&q=&errors=1），检索结果可分享、可后退。
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  formatClock,
  formatDateTime,
  toMillis,
  type RunListItem,
  type RunNodeRow,
} from "@/app/runs/lib";
import { MonitorEmpty, MonitorErrorBar, Num } from "../ui";
import type { LogItem, LogsPayload } from "@/server/monitor/types";

const PAGE_SIZE = 50;

/** run_events.type 全集（引擎侧唯一出处：src/server/opencode/server.ts） */
const EVENT_TYPES: Array<{ value: string; label: string }> = [
  { value: "text", label: "文本增量" },
  { value: "tool", label: "工具调用" },
  { value: "session.error", label: "会话错误" },
  { value: "session.idle", label: "会话结束" },
];

const TYPE_CHIP: Record<string, string> = {
  text: "border-zinc-700 text-zinc-300",
  tool: "border-sky-500/40 text-sky-300",
  "session.error": "border-red-500/40 text-red-300",
  "session.idle": "border-emerald-500/40 text-emerald-300",
};

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // 响应体不是 JSON
  }
  return `请求失败（HTTP ${res.status}）`;
}

const text = (value: unknown): string =>
  typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);

/** 一行摘要：按事件类型挑最有信息量的字段 */
function summarize(row: LogItem, limit = 200): string {
  const p = row.payload ?? {};
  let out: string;
  switch (row.type) {
    case "text":
      out = text(p.text);
      break;
    case "tool":
      out = [text(p.tool), text(p.status), text(p.title), text(p.error) || text(p.output) || text(p.input)]
        .filter(Boolean)
        .join(" · ");
      break;
    case "session.error":
      out = text(p.error) || "会话错误";
      break;
    case "session.idle":
      out = "会话结束（session.idle）";
      break;
    default:
      out = text(p);
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > limit ? `${out.slice(0, limit)}…` : out;
}

function isErrorRow(row: LogItem): boolean {
  if (row.type === "session.error") return true;
  return row.type === "tool" && row.payload?.status === "error";
}

function pretty(payload: Record<string, unknown> | null): string {
  if (payload == null) return "（无 payload）";
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

/** 归并去重：按 id 倒序（id 自增，等价于时间倒序） */
function mergeRows(prev: LogItem[], incoming: LogItem[]): LogItem[] {
  const byId = new Map(prev.map((r) => [r.id, r]));
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

function fileStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`;
}

export default function MonitorLogsPage() {
  return (
    <Suspense fallback={<div className="px-6 py-5 text-sm text-zinc-500">加载中…</div>}>
      <LogsConsole />
    </Suspense>
  );
}

function LogsConsole() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const runId = searchParams.get("runId") ?? "";
  const nodeId = searchParams.get("nodeId") ?? "";
  const q = searchParams.get("q") ?? "";
  const onlyErrors = searchParams.get("errors") === "1";
  const typesParam = searchParams.get("types") ?? "";
  const types = useMemo(
    () =>
      typesParam
        .split(",")
        .map((t) => t.trim())
        .filter((t) => EVENT_TYPES.some((e) => e.value === t)),
    [typesParam],
  );
  const typesKey = types.join(",");

  const [rows, setRows] = useState<LogItem[] | null>(null);
  /** 单一游标：null = 已到底 */
  const [cursor, setCursor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [draftQ, setDraftQ] = useState(q);
  const [runOptions, setRunOptions] = useState<RunListItem[]>([]);
  const [nodeOptions, setNodeOptions] = useState<RunNodeRow[]>([]);
  const reqId = useRef(0);

  /** 用当前筛选条件拉一页；append=false 时重置结果 */
  const fetchPage = useCallback(
    async (nextCursor: number | null, append: boolean) => {
      const token = ++reqId.current;
      setLoading(true);
      try {
        const query = new URLSearchParams();
        if (runId) query.set("runId", runId);
        if (nodeId) query.set("nodeId", nodeId);
        // 多选类型交给服务端：单条 SQL in 过滤 + 单一游标
        if (typesKey) query.set("type", typesKey);
        if (q) query.set("q", q);
        if (onlyErrors) query.set("onlyErrors", "true");
        query.set("limit", String(PAGE_SIZE));
        if (nextCursor != null) query.set("cursor", String(nextCursor));
        const res = await fetch(`/api/monitor/logs?${query.toString()}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(await readError(res));
        const payload = (await res.json()) as LogsPayload;
        if (token !== reqId.current) return; // 筛选已切换，丢弃过期响应
        setRows((prev) =>
          mergeRows(append ? (prev ?? []) : [], payload.items),
        );
        setCursor(payload.nextCursor);
        setError(null);
      } catch (err) {
        if (token !== reqId.current) return;
        setError(err instanceof Error ? err.message : "加载日志失败");
        if (!append) setRows([]);
      } finally {
        if (token === reqId.current) setLoading(false);
      }
    },
    [runId, nodeId, typesKey, q, onlyErrors],
  );

  // 筛选变化 → 从头拉第一页
  useEffect(() => {
    setRows(null);
    setOpenId(null);
    void fetchPage(null, false);
  }, [fetchPage]);

  // 运行下拉
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/runs", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as RunListItem[];
        if (!cancelled) setRunOptions(data);
      } catch {
        // 下拉是辅助功能，失败静默
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 节点下拉：nodeId 是工作流内的节点 id，只在选中运行后才有意义
  useEffect(() => {
    if (!runId) {
      setNodeOptions([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/runs/${runId}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { nodes: RunNodeRow[] };
        if (!cancelled) setNodeOptions(data.nodes ?? []);
      } catch {
        // 同上
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // URL 里的关键词变了（后退/清除筛选）→ 同步输入框
  useEffect(() => setDraftQ(q), [q]);

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value == null || value === "") next.delete(key);
        else next.set(key, value);
      }
      const qs = next.toString();
      router.replace(`/monitor/logs${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [router, searchParams],
  );

  // 关键词 400ms 防抖写进 URL
  useEffect(() => {
    if (draftQ === q) return;
    const timer = setTimeout(() => setParams({ q: draftQ.trim() || null }), 400);
    return () => clearTimeout(timer);
  }, [draftQ, q, setParams]);

  const hasMore = cursor != null;
  const list = rows ?? [];
  const filtered = Boolean(runId || nodeId || q || onlyErrors || typesKey);

  const toggleType = (value: string) => {
    const next = types.includes(value)
      ? types.filter((t) => t !== value)
      : [...types, value];
    setParams({ types: next.join(",") || null });
  };

  const loadMore = () => {
    if (cursor == null || loading) return;
    void fetchPage(cursor, true);
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(list, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ontoflow-logs-${fileStamp()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyPayload = async (row: LogItem) => {
    try {
      await navigator.clipboard.writeText(pretty(row.payload));
      setCopied(row.id);
      setTimeout(() => setCopied((c) => (c === row.id ? null : c)), 1500);
    } catch {
      setError("复制失败：浏览器拒绝了剪贴板访问");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-5">
      {/* 筛选栏 */}
      <div className="flex flex-col gap-2.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={runId}
            onChange={(e) => setParams({ runId: e.target.value || null, nodeId: null })}
            className="max-w-[400px] rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 font-mono text-[11px] text-zinc-200 outline-none transition-colors hover:border-zinc-700 focus:border-zinc-600"
          >
            <option value="">全部运行</option>
            {runOptions.map((r) => {
              const started = toMillis(r.startedAt);
              return (
                <option key={r.id} value={r.id}>
                  {`${started == null ? "—" : formatDateTime(started)} · ${
                    r.workflowName || "（未命名）"
                  } · ${r.id.slice(0, 8)}`}
                </option>
              );
            })}
          </select>

          <select
            value={nodeId}
            disabled={!runId}
            onChange={(e) => setParams({ nodeId: e.target.value || null })}
            title={runId ? "按节点过滤" : "先选一次运行，才能按节点过滤"}
            className="max-w-[220px] rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 font-mono text-[11px] text-zinc-200 outline-none transition-colors hover:border-zinc-700 focus:border-zinc-600 disabled:cursor-not-allowed disabled:text-zinc-600"
          >
            <option value="">{runId ? "全部节点" : "全部节点（先选运行）"}</option>
            {nodeOptions.map((n) => (
              <option key={n.nodeId} value={n.nodeId}>
                {n.label || n.nodeId.slice(0, 8)}
              </option>
            ))}
          </select>

          <input
            value={draftQ}
            onChange={(e) => setDraftQ(e.target.value)}
            placeholder="关键词：匹配 payload 全文"
            className="w-60 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 font-mono text-[11px] text-zinc-200 outline-none transition-colors placeholder:text-zinc-600 hover:border-zinc-700 focus:border-zinc-600"
          />

          <label className="inline-flex items-center gap-1.5 text-[11px] text-zinc-300">
            <input
              type="checkbox"
              checked={onlyErrors}
              onChange={(e) => setParams({ errors: e.target.checked ? "1" : null })}
              className="accent-red-500"
            />
            只看错误
          </label>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={exportJson}
              disabled={list.length === 0}
              className="rounded-md border border-zinc-800 px-2.5 py-1.5 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-600"
            >
              导出当前结果 JSON（{list.length}）
            </button>
            <button
              type="button"
              onClick={() => {
                void fetchPage(null, false);
              }}
              className="rounded-md border border-zinc-800 px-2.5 py-1.5 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              刷新
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-zinc-500">事件类型</span>
          {EVENT_TYPES.map((t) => {
            const on = types.includes(t.value);
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => toggleType(t.value)}
                aria-pressed={on}
                className={`rounded border px-2 py-1 text-[11px] transition-colors ${
                  on
                    ? "border-zinc-600 bg-zinc-800 text-zinc-100"
                    : "border-zinc-800 text-zinc-500 hover:border-zinc-700"
                }`}
              >
                {t.label}
                <span className="ml-1.5 font-mono text-[10px] text-zinc-600">
                  {t.value}
                </span>
              </button>
            );
          })}
          {filtered && (
            <button
              type="button"
              onClick={() => router.replace("/monitor/logs", { scroll: false })}
              className="ml-2 text-[11px] text-zinc-500 underline underline-offset-2 transition-colors hover:text-zinc-300"
            >
              清除全部筛选
            </button>
          )}
        </div>
      </div>

      {error && (
        <MonitorErrorBar
          message={error}
          onRetry={() => {
            setError(null);
            void fetchPage(null, false);
          }}
        />
      )}

      {/* 结果表 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/60">
        <div className="flex items-center border-b border-zinc-800 px-3 py-2 text-[11px] text-zinc-500">
          <span className="w-[110px] shrink-0">时间</span>
          <span className="w-[180px] shrink-0">运行</span>
          <span className="w-[150px] shrink-0">节点</span>
          <span className="w-[110px] shrink-0">类型</span>
          <span className="flex-1">摘要</span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {rows === null ? (
            <div className="px-3 py-10 text-center text-[11px] text-zinc-500">
              检索中…
            </div>
          ) : list.length === 0 ? (
            <div className="px-3 py-8">
              <MonitorEmpty
                title={filtered ? "没有匹配的事件" : "还没有任何运行事件"}
                description={
                  filtered
                    ? "试试放宽条件：去掉关键词、取消「只看错误」，或换一次运行。"
                    : "跑一次工作流，引擎会把文本增量、工具调用、会话错误都写进 run_events。"
                }
              />
            </div>
          ) : (
            list.map((row) => {
              const open = openId === row.id;
              const bad = isErrorRow(row);
              return (
                <div key={row.id} className="border-b border-zinc-800/60">
                  <button
                    type="button"
                    data-testid="log-row"
                    onClick={() => setOpenId(open ? null : row.id)}
                    aria-expanded={open}
                    className={`flex w-full items-start text-left text-[11px] transition-colors hover:bg-zinc-800/50 ${
                      open ? "bg-zinc-800/60" : ""
                    }`}
                  >
                    <Num className="w-[110px] shrink-0 px-3 py-2 text-zinc-400">
                      {formatClock(row.ts)}
                    </Num>
                    <span className="w-[180px] shrink-0 truncate px-3 py-2 text-zinc-300">
                      {row.workflowName || row.runId.slice(0, 8)}
                    </span>
                    <span className="w-[150px] shrink-0 truncate px-3 py-2 text-zinc-400">
                      {row.nodeLabel || row.nodeId?.slice(0, 8) || "—"}
                    </span>
                    <span className="w-[110px] shrink-0 px-3 py-2">
                      <span
                        className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                          TYPE_CHIP[row.type] ?? "border-zinc-700 text-zinc-400"
                        }`}
                      >
                        {row.type}
                      </span>
                    </span>
                    <span
                      className={`min-w-0 flex-1 truncate px-3 py-2 ${
                        bad ? "text-red-300" : "text-zinc-400"
                      }`}
                    >
                      {summarize(row)}
                    </span>
                  </button>

                  {open && (
                    <div
                      data-testid="log-row-detail"
                      className="border-t border-zinc-800/60 bg-zinc-950/60 px-3 py-3"
                    >
                      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-zinc-500">
                        <Num>#{row.id}</Num>
                        <Num>{formatDateTime(row.ts)}</Num>
                        <span>run {row.runId}</span>
                        {row.nodeId && <span>node {row.nodeId}</span>}
                        <Link
                          href={`/runs/${row.runId}`}
                          className="text-zinc-400 underline underline-offset-2 transition-colors hover:text-zinc-100"
                        >
                          运行详情
                        </Link>
                        <Link
                          href={`/monitor/trace?runId=${row.runId}`}
                          className="text-zinc-400 underline underline-offset-2 transition-colors hover:text-zinc-100"
                        >
                          在 Trace 中查看
                        </Link>
                        <button
                          type="button"
                          onClick={() => void copyPayload(row)}
                          className="rounded border border-zinc-800 px-1.5 py-0.5 text-zinc-300 transition-colors hover:bg-zinc-800"
                        >
                          {copied === row.id ? "已复制" : "复制 payload"}
                        </button>
                      </div>
                      <pre className="max-h-[360px] overflow-auto font-mono text-[11px] leading-5 whitespace-pre-wrap text-zinc-300">
                        {pretty(row.payload)}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="flex items-center justify-between text-[11px] text-zinc-500">
        <span>
          已加载 <Num className="text-zinc-300">{list.length}</Num> 条
          {types.length > 1 && `（${types.length} 类并行检索）`}
        </span>
        {hasMore ? (
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="rounded-md border border-zinc-800 px-3 py-1.5 text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-600"
          >
            {loading ? "加载中…" : `加载更多（每次 ${PAGE_SIZE} 条）`}
          </button>
        ) : (
          list.length > 0 && <span>已到底</span>
        )}
      </div>
    </div>
  );
}
