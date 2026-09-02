"use client";

/**
 * 监控台 · 成本分析：token 与费用的归集。
 *
 * 数据来自 `/api/monitor/cost?days=`（CostPayload）。统计口径见服务层注释：
 * 按模型走 node_usage（逐条 assistant 消息的真实用量），按 Action / 工作流走
 * run_nodes 汇总，因此两处的「次数」含义不同（消息数 vs 节点/运行数）。
 * 时间范围写进 `?range=`，1 / 7 / 30 天。
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { formatCost, formatTokens } from "@/app/runs/lib";
import {
  CHART_COLORS,
  Legend,
  MetricCard,
  MonitorEmpty,
  MonitorErrorBar,
  Num,
  Panel,
  Sparkbars,
  Sparkline,
} from "../ui";
import type { CostPayload } from "@/server/monitor/types";

const RANGES: Array<{ days: number; label: string }> = [
  { days: 1, label: "近 1 天" },
  { days: 7, label: "近 7 天" },
  { days: 30, label: "近 30 天" },
];

type Metric = "cost" | "tokens";

interface RankRow {
  key: string;
  label: string;
  sub: string;
  count: number;
  tokens: number;
  cost: number;
}

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // 响应体不是 JSON
  }
  return `请求失败（HTTP ${res.status}）`;
}

export default function MonitorCostPage() {
  return (
    <Suspense fallback={<div className="px-6 py-5 text-sm text-zinc-500">加载中…</div>}>
      <CostConsole />
    </Suspense>
  );
}

function CostConsole() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawRange = Number(searchParams.get("range"));
  const days = RANGES.some((r) => r.days === rawRange) ? rawRange : 7;

  const [data, setData] = useState<CostPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>("cost");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/monitor/cost?days=${days}`, { cache: "no-store" });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setData((await res.json()) as CostPayload);
      setError(null);
    } catch {
      setError("网络错误，加载成本数据失败");
    }
  }, [days]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const totals = useMemo(() => {
    const models = data?.byModel ?? [];
    return {
      cost: models.reduce((sum, m) => sum + m.cost, 0),
      tokens: models.reduce((sum, m) => sum + m.tokens, 0),
      messages: models.reduce((sum, m) => sum + m.messages, 0),
    };
  }, [data]);

  const byModel: RankRow[] = (data?.byModel ?? []).map((m) => ({
    key: `${m.providerId}/${m.modelId}`,
    label: m.modelId || "（未知模型）",
    sub: m.providerId,
    count: m.messages,
    tokens: m.tokens,
    cost: m.cost,
  }));
  const byAction: RankRow[] = (data?.byAction ?? []).map((a) => ({
    key: a.actionName || "（未知 Action）",
    label: a.actionName || "（未知 Action）",
    sub: "",
    count: a.nodes,
    tokens: a.tokens,
    cost: a.cost,
  }));
  const byWorkflow: RankRow[] = (data?.byWorkflow ?? []).map((w) => ({
    key: w.workflowName,
    label: w.workflowName,
    sub: "",
    count: w.runs,
    tokens: w.tokens,
    cost: w.cost,
  }));

  const daily = data?.daily ?? [];
  const labelEvery = Math.max(1, Math.ceil(daily.length / 10));
  const loading = data === null && error === null;
  const empty = data !== null && totals.messages === 0 && byWorkflow.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border border-zinc-800 bg-zinc-900 p-0.5">
          {RANGES.map((r) => {
            const on = r.days === days;
            return (
              <button
                key={r.days}
                type="button"
                onClick={() =>
                  router.replace(`/monitor/cost?range=${r.days}`, { scroll: false })
                }
                aria-pressed={on}
                className={`rounded px-3 py-1 text-xs transition-colors ${
                  on ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-200"
                }`}
              >
                {r.label}
              </button>
            );
          })}
        </div>
        <span className="text-[11px] text-zinc-500">
          统计口径：node_usage 逐条 assistant 消息，token 含输入/输出/推理/缓存读写
        </span>
        <button
          type="button"
          onClick={() => void load()}
          className="ml-auto rounded-md border border-zinc-800 px-2.5 py-1.5 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800"
        >
          刷新
        </button>
      </div>

      {error && (
        <MonitorErrorBar
          message={error}
          onRetry={() => {
            setError(null);
            void load();
          }}
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="总费用"
          value={formatCost(totals.cost)}
          tone="emerald"
          loading={loading}
          hint={`${RANGES.find((r) => r.days === days)?.label ?? ""}合计`}
        />
        <MetricCard
          label="总 token"
          value={formatTokens(totals.tokens)}
          tone="sky"
          loading={loading}
          hint="input/output/cache 合计；推理已含在 output"
        />
        <MetricCard
          label="assistant 消息"
          value={formatTokens(totals.messages)}
          loading={loading}
          hint="node_usage 行数，不含压缩摘要那次调用（variant = compaction，钱算、消息不算）"
        />
        <MetricCard
          label="日均费用"
          value={formatCost(days > 0 ? totals.cost / days : 0)}
          tone="violet"
          loading={loading}
          hint={`按 ${days} 天平均`}
        />
      </div>

      {empty ? (
        <MonitorEmpty
          title="该时间范围内没有任何用量"
          description="成本只统计 node_usage（逐条 assistant 消息的真实用量）。换一个更长的时间范围，或先跑一次工作流。"
          action={
            <Link
              href="/workflows"
              className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              去工作流
            </Link>
          }
        />
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <Panel
              title="每日费用"
              subtitle={`${days} 天窗口（含今天），空白日补 0`}
              right={
                <Legend
                  items={[
                    {
                      color: CHART_COLORS.success,
                      label: "费用",
                      value: formatCost(totals.cost),
                    },
                  ]}
                />
              }
              bodyClassName="px-2 py-3"
            >
              {daily.length === 0 ? (
                <div className="py-10 text-center text-[11px] text-zinc-500">无数据</div>
              ) : (
                <Sparkbars
                  data={daily.map((d) => ({
                    label: d.dayISO.slice(5),
                    values: [d.cost],
                    title: `${d.dayISO} · ${formatCost(d.cost)} · ${formatTokens(
                      d.tokens,
                    )} token`,
                  }))}
                  colors={[CHART_COLORS.success]}
                  formatValue={formatCost}
                  labelEvery={labelEvery}
                />
              )}
            </Panel>

            <Panel
              title="每日 token"
              subtitle="与费用同窗口，看清是「量大」还是「单价贵」"
              right={
                <Legend
                  items={[
                    {
                      color: CHART_COLORS.tokens,
                      label: "token",
                      value: formatTokens(totals.tokens),
                    },
                  ]}
                />
              }
              bodyClassName="px-2 py-3"
            >
              {daily.length === 0 ? (
                <div className="py-10 text-center text-[11px] text-zinc-500">无数据</div>
              ) : (
                <Sparkline
                  data={daily.map((d) => ({
                    label: d.dayISO.slice(5),
                    value: d.tokens,
                    title: `${d.dayISO} · ${formatTokens(d.tokens)} token`,
                  }))}
                  formatValue={formatTokens}
                  labelEvery={labelEvery}
                  ariaLabel="每日 token 趋势"
                />
              )}
            </Panel>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11px] text-zinc-500">排行依据</span>
            {(["cost", "tokens"] as Metric[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMetric(m)}
                aria-pressed={metric === m}
                className={`rounded border px-2.5 py-1 text-[11px] transition-colors ${
                  metric === m
                    ? "border-zinc-600 bg-zinc-800 text-zinc-100"
                    : "border-zinc-800 text-zinc-500 hover:border-zinc-700"
                }`}
              >
                {m === "cost" ? "按费用" : "按 token"}
              </button>
            ))}
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <RankTable
              title="按模型"
              nameHead="模型"
              countHead="消息"
              rows={byModel}
              metric={metric}
              loading={loading}
            />
            <RankTable
              title="按 Action"
              nameHead="Action"
              countHead="节点"
              rows={byAction}
              metric={metric}
              loading={loading}
              note="来自 run_nodes.snapshot.actionName：Action 改名后历史仍按当时的名字归集"
            />
            <RankTable
              title="按工作流"
              nameHead="工作流"
              countHead="运行"
              rows={byWorkflow}
              metric={metric}
              loading={loading}
            />
          </div>
        </>
      )}
    </div>
  );
}

function RankTable({
  title,
  nameHead,
  countHead,
  rows,
  metric,
  loading,
  note,
}: {
  title: string;
  nameHead: string;
  countHead: string;
  rows: RankRow[];
  metric: Metric;
  loading: boolean;
  note?: string;
}) {
  const sorted = [...rows].sort((a, b) => b[metric] - a[metric] || b.cost - a.cost);
  const total = sorted.reduce((sum, r) => sum + r[metric], 0);

  return (
    <Panel
      title={title}
      subtitle={note}
      right={<span className="text-[11px] text-zinc-500">{sorted.length} 项</span>}
      bodyClassName="px-0 py-0"
    >
      {loading ? (
        <div className="px-4 py-10 text-center text-[11px] text-zinc-500">加载中…</div>
      ) : sorted.length === 0 ? (
        <div className="px-4 py-10 text-center text-[11px] text-zinc-500">
          该时间范围内无数据
        </div>
      ) : (
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-zinc-500">
              <th className="px-4 py-1.5 font-normal">{nameHead}</th>
              <th className="w-14 px-2 py-1.5 text-right font-normal">{countHead}</th>
              <th className="w-24 px-2 py-1.5 text-right font-normal">token</th>
              <th className="w-24 px-2 py-1.5 text-right font-normal">费用</th>
              <th className="w-32 px-4 py-1.5 font-normal">占比</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const share = total > 0 ? (row[metric] / total) * 100 : 0;
              return (
                <tr key={row.key} className="border-b border-zinc-800/60 last:border-b-0">
                  <td className="max-w-0 px-4 py-1.5">
                    <div className="truncate text-zinc-200" title={row.label}>
                      {row.label}
                    </div>
                    {row.sub && (
                      <div className="truncate font-mono text-[10px] text-zinc-600">
                        {row.sub}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Num className="text-zinc-400">{row.count}</Num>
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Num className="text-sky-300">{formatTokens(row.tokens)}</Num>
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Num className="text-emerald-300">{formatCost(row.cost)}</Num>
                  </td>
                  <td className="px-4 py-1.5">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-sm bg-zinc-950">
                        <div
                          className="h-full rounded-sm"
                          style={{
                            width: `${Math.max(share, 1)}%`,
                            backgroundColor:
                              metric === "cost"
                                ? CHART_COLORS.success
                                : CHART_COLORS.tokens,
                          }}
                        />
                      </div>
                      <Num className="w-9 text-right text-zinc-500">
                        {share.toFixed(0)}%
                      </Num>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
