"use client";

import { useCallback, useEffect, useState } from "react";

interface PlanRow {
  id: number;
  planNo: string;
  planTitle: string;
  planType: string | null;
  planYear: string | null;
  orgUnits: string | null;
  categorySummary: string | null;
  itemCount: number | null;
  totalBudget: number | null;
  budgetNote: string | null;
  scheduleSummary: string | null;
  reviewConclusion: string | null;
  reviewFeedback: string | null;
  planContent: string;
  pendingIssues: string | null;
  backupPath: string | null;
  createdAt: string;
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

function fmtTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function fmtBudget(value: number | null): string {
  if (value == null) return "—";
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 元`;
}

function conclusionStyle(conclusion: string | null): string {
  if (!conclusion) return "border-zinc-200 bg-zinc-50 text-zinc-500";
  if (conclusion.includes("退回"))
    return "border-red-200 bg-red-50 text-red-700";
  if (conclusion.includes("保留"))
    return "border-amber-200 bg-amber-50 text-amber-700";
  if (conclusion.includes("通过"))
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  return "border-zinc-200 bg-zinc-50 text-zinc-600";
}

function prettyFeedback(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export default function DocumentsPage() {
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/documents", { cache: "no-store" });
      if (!res.ok) {
        setLoadError(await readError(res));
        setPlans(null);
        return;
      }
      setPlans((await res.json()) as PlanRow[]);
    } catch {
      setLoadError("网络错误，无法加载归档文档");
      setPlans(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="p-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6">
          <h1 className="text-xl font-semibold text-zinc-900">归档文档</h1>
          <p className="mt-1 text-sm text-zinc-500">
            工作流归档产出的集采计划（purchase_plans），点击行展开查看全文与审核评价。
          </p>
        </header>

        {loadError && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {loadError}
            <button
              onClick={() => void load()}
              className="ml-3 underline hover:text-red-900"
            >
              重试
            </button>
          </div>
        )}

        {loading ? (
          <p className="py-16 text-center text-sm text-zinc-400">加载中…</p>
        ) : plans && plans.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 bg-white py-16 text-center text-sm text-zinc-400">
            暂无归档文档。工作流的归档节点执行成功后，集采计划会出现在这里。
          </div>
        ) : plans ? (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
            <table className="w-full min-w-[880px] text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-xs text-zinc-500">
                  <th className="px-4 py-3 font-medium">计划编号</th>
                  <th className="px-4 py-3 font-medium">标题</th>
                  <th className="px-4 py-3 font-medium">年度</th>
                  <th className="px-4 py-3 font-medium">部门</th>
                  <th className="px-4 py-3 font-medium">预算总额</th>
                  <th className="px-4 py-3 font-medium">审核结论</th>
                  <th className="px-4 py-3 font-medium">归档时间</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => {
                  const expanded = expandedId === plan.id;
                  const feedback = expanded
                    ? prettyFeedback(plan.reviewFeedback)
                    : null;
                  return (
                    <PlanRows
                      key={plan.id}
                      plan={plan}
                      expanded={expanded}
                      feedback={feedback}
                      onToggle={() =>
                        setExpandedId(expanded ? null : plan.id)
                      }
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PlanRows({
  plan,
  expanded,
  feedback,
  onToggle,
}: {
  plan: PlanRow;
  expanded: boolean;
  feedback: string | null;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className={`cursor-pointer border-b border-zinc-100 transition-colors hover:bg-zinc-50 ${
          expanded ? "bg-zinc-50" : ""
        }`}
      >
        <td className="px-4 py-3 font-mono text-xs text-zinc-700">
          {plan.planNo}
        </td>
        <td className="max-w-64 truncate px-4 py-3 text-zinc-900">
          {plan.planTitle}
        </td>
        <td className="px-4 py-3 text-zinc-600">{plan.planYear ?? "—"}</td>
        <td className="max-w-48 truncate px-4 py-3 text-zinc-600">
          {plan.orgUnits ?? "—"}
        </td>
        <td className="px-4 py-3 text-zinc-600">
          {fmtBudget(plan.totalBudget)}
        </td>
        <td className="px-4 py-3">
          <span
            className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs ${conclusionStyle(plan.reviewConclusion)}`}
          >
            {plan.reviewConclusion || "—"}
          </span>
        </td>
        <td className="px-4 py-3 text-xs text-zinc-500">
          {fmtTime(plan.createdAt)}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-zinc-100 bg-zinc-50/60">
          <td colSpan={7} className="px-4 py-4">
            <div className="space-y-4">
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-500">
                {plan.planType && <span>集采分类：{plan.planType}</span>}
                {plan.itemCount != null && (
                  <span>条目数：{plan.itemCount}</span>
                )}
                {plan.budgetNote && <span>预算口径：{plan.budgetNote}</span>}
                {plan.categorySummary && (
                  <span>品类摘要：{plan.categorySummary}</span>
                )}
                {plan.scheduleSummary && (
                  <span>进度安排：{plan.scheduleSummary}</span>
                )}
              </div>

              <div>
                <h3 className="mb-1 text-xs font-medium text-zinc-700">
                  计划全文
                </h3>
                <pre className="max-h-96 overflow-auto rounded-md border border-zinc-200 bg-white p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-zinc-800">
                  {plan.planContent}
                </pre>
              </div>

              <div>
                <h3 className="mb-1 text-xs font-medium text-zinc-700">
                  审核评价
                </h3>
                {feedback ? (
                  <pre className="max-h-72 overflow-auto rounded-md border border-zinc-200 bg-white p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-zinc-800">
                    {feedback}
                  </pre>
                ) : (
                  <p className="text-xs text-zinc-400">（无审核评价）</p>
                )}
              </div>

              {plan.pendingIssues && (
                <div>
                  <h3 className="mb-1 text-xs font-medium text-zinc-700">
                    待确认事项
                  </h3>
                  <pre className="max-h-48 overflow-auto rounded-md border border-zinc-200 bg-white p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-zinc-800">
                    {plan.pendingIssues}
                  </pre>
                </div>
              )}

              <div className="text-xs text-zinc-500">
                备份路径：
                {plan.backupPath ? (
                  <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-zinc-700">
                    {plan.backupPath}
                  </code>
                ) : (
                  "（无备份）"
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
