"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  durationText,
  formatDateTime,
  toMillis,
  type RunEventRow,
  type RunNodeRow,
  type RunRow,
} from "../lib";
import { StatusBadge } from "../status-badge";
import { EventLog } from "./event-log";
import { NodeCard } from "./node-card";

export default function RunDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [run, setRun] = useState<RunRow | null>(null);
  const [nodes, setNodes] = useState<RunNodeRow[]>([]);
  const [events, setEvents] = useState<RunEventRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const seenEventIds = useRef(new Set<number>());

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let es: EventSource | null = null;
    seenEventIds.current = new Set();
    setRun(null);
    setNodes([]);
    setEvents([]);
    setLoadError(null);
    setLoading(true);

    // SSE：snapshot 更新概要与节点，log 去重后追加，end 断开。
    // 历史 run 同样连一次拿 snapshot + 回放 log 到 end（契约保证回放）。
    // EventSource 掉线自动重连会重发 snapshot 并回放全部 log，靠 seenEventIds 去重。
    const openStream = () => {
      es = new EventSource(`/api/runs/${id}/events`);
      es.onopen = () => {
        if (!cancelled) setConnected(true);
      };
      es.addEventListener("snapshot", (e) => {
        if (cancelled) return;
        try {
          const data = JSON.parse((e as MessageEvent).data) as {
            run: RunRow;
            nodes: RunNodeRow[];
          };
          setRun(data.run);
          setNodes(data.nodes ?? []);
        } catch {
          // 忽略坏帧
        }
      });
      es.addEventListener("log", (e) => {
        if (cancelled) return;
        try {
          const row = JSON.parse((e as MessageEvent).data) as RunEventRow;
          if (seenEventIds.current.has(row.id)) return;
          seenEventIds.current.add(row.id);
          setEvents((prev) => [...prev, row]);
        } catch {
          // 忽略坏帧
        }
      });
      es.addEventListener("end", () => {
        setConnected(false);
        es?.close();
      });
      es.onerror = () => {
        // 交给 EventSource 自动重连；重复回放已由 seenEventIds 去重
        if (!cancelled) setConnected(false);
      };
    };

    (async () => {
      try {
        const res = await fetch(`/api/runs/${id}`, { cache: "no-store" });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(
            typeof data?.error === "string" ? data.error : "加载运行详情失败",
          );
          return;
        }
        setRun(data.run as RunRow);
        setNodes((data.nodes ?? []) as RunNodeRow[]);
        openStream();
      } catch {
        if (!cancelled) setLoadError("网络错误，加载运行详情失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [id]);

  // 运行中每秒重渲染一次，让“已耗时”走动
  const [, setTick] = useState(0);
  useEffect(() => {
    if (run?.status !== "running") return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [run?.status]);

  const sortedNodes = useMemo(() => {
    return [...nodes].sort((a, b) => {
      const ta = toMillis(a.startedAt);
      const tb = toMillis(b.startedAt);
      if (ta == null && tb == null) return 0;
      if (ta == null) return 1;
      if (tb == null) return -1;
      return ta - tb;
    });
  }, [nodes]);

  const nodeLabels = useMemo(
    () => new Map(nodes.map((n) => [n.nodeId, n.label])),
    [nodes],
  );

  const started = run ? toMillis(run.startedAt) : null;
  const finished = run ? toMillis(run.finishedAt) : null;

  return (
    <div className="mx-auto max-w-5xl px-8 py-6">
      <div className="mb-6">
        <Link
          href="/runs"
          className="text-sm text-zinc-500 transition-colors hover:text-zinc-900"
        >
          ← 返回运行历史
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-zinc-900">运行详情</h1>
      </div>

      {loadError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError}
        </div>
      ) : loading && !run ? (
        <div className="text-sm text-zinc-500">加载中…</div>
      ) : run ? (
        <div className="space-y-6">
          {/* 概要 */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5">
            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge status={run.status} />
              <span className="font-mono text-xs text-zinc-400">{run.id}</span>
              <Link
                href={`/runs?workflowId=${encodeURIComponent(run.workflowId)}`}
                className="ml-auto text-sm text-zinc-500 underline transition-colors hover:text-zinc-900"
              >
                查看该工作流的全部运行
              </Link>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-zinc-400">开始时间</dt>
                <dd className="mt-0.5 text-zinc-700">
                  {started == null ? "—" : formatDateTime(started)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-400">结束时间</dt>
                <dd className="mt-0.5 text-zinc-700">
                  {finished == null ? "—" : formatDateTime(finished)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-400">耗时</dt>
                <dd className="mt-0.5 text-zinc-700">
                  {durationText(run.startedAt, run.finishedAt)}
                </dd>
              </div>
            </dl>
            {run.error && (
              <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm break-words whitespace-pre-wrap text-red-700">
                {run.error}
              </div>
            )}
          </div>

          {/* 节点时间线 */}
          <section>
            <h2 className="mb-3 text-sm font-medium text-zinc-900">
              节点时间线
            </h2>
            {sortedNodes.length === 0 ? (
              <div className="rounded-lg border border-zinc-200 bg-white px-4 py-8 text-center text-sm text-zinc-500">
                暂无节点记录
              </div>
            ) : (
              <div className="relative">
                <div className="absolute top-2 bottom-2 left-[4px] w-px bg-zinc-200" />
                <div className="space-y-4">
                  {sortedNodes.map((node) => (
                    <NodeCard key={node.id} node={node} />
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* 事件日志 */}
          <section>
            <EventLog
              events={events}
              nodeLabels={nodeLabels}
              live={connected && run.status === "running"}
            />
          </section>
        </div>
      ) : null}
    </div>
  );
}
