"use client";

/**
 * 监控台 · 总览：6 个实时指标卡 + 近 24 小时两张手写 SVG 图 + 最近失败。
 *
 * 指标与曲线全部来自 /api/monitor/stream（SSE，2 秒一轮，载荷不变就不推）；
 * 「最近失败」不在流里，走既有的 /api/runs?status=，仅在流里的失败/取消计数
 * 或活跃运行数变化时重新拉一次，不做无谓轮询。
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  durationText,
  formatCost,
  formatDateTime,
  formatTokens,
  toMillis,
  type RunListItem,
} from "@/app/runs/lib";
import {
  CHART_COLORS,
  ConnectionBadge,
  Legend,
  MetricCard,
  MonitorEmpty,
  MonitorErrorBar,
  Num,
  Panel,
  Sparkbars,
  Sparkline,
  StatusChip,
} from "./ui";
import { useMonitorStream, type OverviewPoint } from "./use-monitor-stream";

const HOUR_MS = 3_600_000;
const HOURS = 24;
const FAILURE_LIMIT = 5;

/** 大数紧凑表示（坐标轴用） */
function compact(n: number): string {
  const v = Math.round(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}m`;
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 服务端保证 24 个对齐的桶；万一没拿到就自己补一条零基线，图形不塌 */
function fallbackSeries(): OverviewPoint[] {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const base = now.getTime() - (HOURS - 1) * HOUR_MS;
  return Array.from({ length: HOURS }, (_, i) => ({
    hourISO: "",
    hourMs: base + i * HOUR_MS,
    runs: 0,
    failed: 0,
    tokens: 0,
    cost: 0,
  }));
}

/** 运行终态里区分失败/取消两条线的最近记录（列表 API 没有 error 文本，故只列元信息） */
async function fetchRecentFailures(): Promise<RunListItem[]> {
  const [failed, cancelled] = await Promise.all(
    (["failed", "cancelled"] as const).map(async (status) => {
      const res = await fetch(`/api/runs?status=${status}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("加载失败运行列表失败");
      const data = (await res.json()) as unknown;
      return Array.isArray(data) ? (data as RunListItem[]) : [];
    }),
  );
  const endedAt = (row: RunListItem) =>
    toMillis(row.finishedAt) ?? toMillis(row.startedAt) ?? 0;
  return [...failed, ...cancelled]
    .sort((a, b) => endedAt(b) - endedAt(a))
    .slice(0, FAILURE_LIMIT);
}

export default function MonitorOverviewPage() {
  const { overview, connection } = useMonitorStream({ logLimit: 1 });

  const series = useMemo(
    () =>
      overview && overview.series.length > 0
        ? overview.series
        : fallbackSeries(),
    [overview],
  );

  const totals = useMemo(
    () =>
      series.reduce(
        (acc, p) => ({
          runs: acc.runs + p.runs,
          failed: acc.failed + p.failed,
          tokens: acc.tokens + p.tokens,
          cost: acc.cost + p.cost,
        }),
        { runs: 0, failed: 0, tokens: 0, cost: 0 },
      ),
    [series],
  );

  const today = overview?.today;
  const finished = today ? today.success + today.failed + today.cancelled : 0;
  const successRate =
    today && finished > 0 ? (today.success / finished) * 100 : null;
  const loading = overview === null;

  // 最近失败：只在「失败/取消计数」或「活跃运行数」变化时重拉
  const failureKey = today
    ? `${today.failed}/${today.cancelled}/${overview?.live.activeRuns ?? 0}`
    : "init";
  const [failures, setFailures] = useState<RunListItem[] | null>(null);
  const [failureError, setFailureError] = useState<string | null>(null);

  const loadFailures = useCallback(async (alive: () => boolean) => {
    try {
      const rows = await fetchRecentFailures();
      if (!alive()) return;
      setFailures(rows);
      setFailureError(null);
    } catch {
      if (alive()) setFailureError("最近失败列表加载失败");
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    void loadFailures(() => !disposed);
    return () => {
      disposed = true;
    };
  }, [failureKey, loadFailures]);

  return (
    <div className="space-y-4 px-6 py-5">
      {connection.state === "closed" && (
        <MonitorErrorBar
          message={connection.error ?? "实时连接已断开"}
          onRetry={connection.retry}
        />
      )}

      {/* 指标卡 */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard
          label="活跃运行"
          value={String(overview?.live.activeRuns ?? 0)}
          tone={overview && overview.live.activeRuns > 0 ? "sky" : "zinc"}
          hint={
            overview && overview.live.activeRuns > 0
              ? `${overview.live.runningNodes} 个节点执行中`
              : "引擎空闲"
          }
          loading={loading}
        />
        <MetricCard
          label="活跃会话"
          value={String(overview?.live.activeSessions ?? 0)}
          tone={overview && overview.live.activeSessions > 0 ? "sky" : "zinc"}
          hint={
            <Link
              href="/monitor/sessions"
              className="underline transition-colors hover:text-zinc-300"
            >
              查看实时会话
            </Link>
          }
          loading={loading}
        />
        <MetricCard
          label="今日运行"
          value={String(today?.runs ?? 0)}
          tone="violet"
          hint={
            successRate == null ? (
              "尚无已结束的运行"
            ) : (
              <>
                成功率{" "}
                <Num className="text-zinc-300">{successRate.toFixed(0)}%</Num>
                <span className="ml-2 text-zinc-600">
                  {today?.success ?? 0}/{finished}
                </span>
              </>
            )
          }
          loading={loading}
        />
        <MetricCard
          label="今日 token"
          value={formatTokens(today?.tokens ?? 0)}
          tone="sky"
          hint="input/output/cache 合计；推理已含在 output"
          loading={loading}
        />
        <MetricCard
          label="今日费用"
          value={formatCost(today?.cost ?? 0)}
          tone="emerald"
          hint={
            <Link
              href="/monitor/cost"
              className="underline transition-colors hover:text-zinc-300"
            >
              成本分析
            </Link>
          }
          loading={loading}
        />
        <MetricCard
          label="近 1 小时错误"
          value={String(overview?.lastHourErrors ?? 0)}
          tone={overview && overview.lastHourErrors > 0 ? "red" : "zinc"}
          hint={
            overview && overview.lastHourErrors > 0 ? (
              <Link
                href="/monitor/logs"
                className="underline transition-colors hover:text-zinc-300"
              >
                去日志检索
              </Link>
            ) : (
              "无错误事件"
            )
          }
          loading={loading}
        />
      </div>

      {/* 两张图 */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title="近 24 小时运行量"
          subtitle="按运行开始时间归入整点桶"
          right={
            <ConnectionBadge
              state={connection.state}
              lastMessageAt={connection.lastMessageAt}
              onRetry={connection.retry}
            />
          }
        >
          <Sparkbars
            data={series.map((p) => ({
              label: pad2(new Date(p.hourMs).getHours()),
              values: [Math.max(0, p.runs - p.failed), p.failed],
              title: `${formatDateTime(p.hourMs).slice(5, 16)} · 发起 ${p.runs} · 失败 ${p.failed}`,
            }))}
            colors={[CHART_COLORS.success, CHART_COLORS.failed]}
            formatValue={(n) => compact(n)}
          />
          <div className="mt-2">
            <Legend
              items={[
                {
                  color: CHART_COLORS.success,
                  label: "非失败（成功/取消/进行中）",
                  value: String(Math.max(0, totals.runs - totals.failed)),
                },
                {
                  color: CHART_COLORS.failed,
                  label: "失败",
                  value: String(totals.failed),
                },
              ]}
            />
          </div>
        </Panel>

        <Panel
          title="近 24 小时 token 消耗"
          subtitle="按 node_usage 的消息时间归集"
          right={
            <span className="text-[11px] text-zinc-500">
              合计{" "}
              <Num className="text-zinc-300">{formatTokens(totals.tokens)}</Num>
              <span className="mx-1.5 text-zinc-700">·</span>
              <Num className="text-zinc-300">{formatCost(totals.cost)}</Num>
            </span>
          }
        >
          <Sparkline
            data={series.map((p) => ({
              label: pad2(new Date(p.hourMs).getHours()),
              value: p.tokens,
              title: `${formatDateTime(p.hourMs).slice(5, 16)} · ${formatTokens(p.tokens)} token / ${formatCost(p.cost)}`,
            }))}
            formatValue={(n) => compact(n)}
            ariaLabel="近 24 小时 token 消耗"
          />
        </Panel>
      </div>

      {/* 最近失败 */}
      <Panel
        title="最近失败"
        subtitle={`最近 ${FAILURE_LIMIT} 条失败或被取消的运行`}
        bodyClassName=""
        right={
          <Link
            href="/runs?status=failed"
            className="text-[11px] text-zinc-500 underline transition-colors hover:text-zinc-300"
          >
            全部失败运行
          </Link>
        }
      >
        {failureError ? (
          <div className="p-4">
            <MonitorErrorBar
              message={failureError}
              onRetry={() => void loadFailures(() => true)}
            />
          </div>
        ) : failures === null ? (
          <p className="px-4 py-10 text-center text-xs text-zinc-600">加载中…</p>
        ) : failures.length === 0 ? (
          <MonitorEmpty
            title="没有失败或被取消的运行"
            description="这一栏空着是好事：所有已结束的运行都成功了。"
          />
        ) : (
          <ul className="divide-y divide-zinc-800">
            {failures.map((run) => {
              const endedAt = toMillis(run.finishedAt);
              return (
                <li
                  key={run.id}
                  className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-zinc-900"
                >
                  <StatusChip status={run.status} />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-zinc-200">
                      {run.workflowName || "（未命名工作流）"}
                    </span>
                    <span className="text-[11px] text-zinc-600">
                      <Num>{run.id.slice(0, 8)}</Num>
                      <span className="mx-1.5 text-zinc-700">·</span>
                      <Num>{formatTokens(run.totalTokens)}</Num> token
                      <span className="mx-1.5 text-zinc-700">·</span>
                      <Num>{formatCost(run.totalCost)}</Num>
                    </span>
                  </div>
                  <div className="shrink-0 text-right">
                    <Num className="block text-[11px] text-zinc-500">
                      {endedAt == null ? "—" : formatDateTime(endedAt)}
                    </Num>
                    <Num className="block text-[11px] text-zinc-600">
                      {durationText(run.startedAt, run.finishedAt)}
                    </Num>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-0.5 text-[11px]">
                    <Link
                      href={`/monitor/trace?runId=${encodeURIComponent(run.id)}`}
                      className="text-sky-400 underline transition-colors hover:text-sky-300"
                    >
                      Trace
                    </Link>
                    <Link
                      href={`/runs/${run.id}`}
                      className="text-zinc-500 underline transition-colors hover:text-zinc-300"
                    >
                      运行详情
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
