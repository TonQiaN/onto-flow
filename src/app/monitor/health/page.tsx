"use client";

/**
 * 监控 · 系统健康（模块 D）
 *
 * 开发者/管理员视角的控制台页：引擎就绪、在跑的运行子进程、数据库与磁盘占用、
 * 孤儿运行与孤儿实体，外加手动清理面板。信息密度高、等宽字体多、深色卡片，
 * 与业务页面（浅色 zinc 工作台）刻意区分。外壳（顶栏 + 六标签）由 /monitor/layout.tsx 提供，
 * 深色小组件（Panel / MetricCard / Dot / Num / Legend …）一律复用 ../ui。
 *
 * 数据来源：GET /api/monitor/health（契约见 ./lib.ts）+ GET /api/references/orphans。
 * 图表手写 SVG，不引图表库。
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { durationText, formatDateTime, toMillis } from "@/app/runs/lib";
import {
  CHART_COLORS,
  Dot,
  Legend,
  MetricCard,
  MonitorErrorBar,
  Num,
  Panel,
} from "../ui";
import { CleanupPanel, type CleanupUsage } from "./cleanup-panel";
import {
  asHealth,
  asOrphanEntities,
  formatBytes,
  formatCount,
  kindLabel,
  WORKSPACE_WARN_BYTES,
  type HealthPayload,
  type OrphanEntity,
} from "./lib";

const AUTO_REFRESH_MS = 15_000;

export default function MonitorHealthPage() {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [orphanEntities, setOrphanEntities] = useState<OrphanEntity[]>([]);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [orphanError, setOrphanError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [healthRes, orphanRes] = await Promise.allSettled([
      fetchJson("/api/monitor/health"),
      fetchJson("/api/references/orphans"),
    ]);
    if (!aliveRef.current) return;

    if (healthRes.status === "fulfilled") {
      setHealth(asHealth(healthRes.value));
      setHealthError(null);
    } else {
      setHealthError(errorText(healthRes.reason, "加载系统健康数据失败"));
    }

    if (orphanRes.status === "fulfilled") {
      setOrphanEntities(asOrphanEntities(orphanRes.value));
      setOrphanError(null);
    } else {
      setOrphanError(errorText(orphanRes.reason, "加载孤儿实体失败"));
    }

    setLoadedAt(Date.now());
    setLoading(false);
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => {
      aliveRef.current = false;
    };
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => void load(), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, load]);

  const workspaceOverLimit =
    health !== null && health.disk.runs.sizeBytes > WORKSPACE_WARN_BYTES;

  return (
    <div className="flex flex-col gap-4 px-6 py-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-zinc-100">系统健康</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-amber-400/90">
            本页是开发者 / 管理员视角：直接读取进程、数据库与磁盘状态。页内的清理操作
            <strong className="font-semibold">立即生效且不可撤销</strong>
            （没有回收站、没有备份），执行前请先预览影响。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 font-mono text-[11px] text-zinc-500">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="accent-zinc-400"
            />
            自动刷新 15s
          </label>
          <span className="inline-flex items-center gap-1.5">
            {loading && <Dot tone="sky" pulse />}
            {loading
              ? "刷新中…"
              : loadedAt
                ? `更新于 ${formatDateTime(loadedAt)}`
                : "—"}
          </span>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-zinc-200 transition-colors hover:bg-zinc-700"
          >
            刷新
          </button>
        </div>
      </header>

      {healthError && (
        <MonitorErrorBar message={healthError} onRetry={() => void load()} />
      )}

      {workspaceOverLimit && health && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-xs leading-5 text-amber-300">
          <Dot tone="amber" pulse />
          <span>
            运行工作区已占用{" "}
            <Num className="font-semibold">
              {formatBytes(health.disk.runs.sizeBytes)}
            </Num>
            ，超过阈值 <Num>{formatBytes(WORKSPACE_WARN_BYTES)}</Num>（共{" "}
            <Num>{formatCount(health.disk.runs.count)}</Num> 个目录）。
            建议清理旧运行的工作区目录。
          </span>
          <button
            type="button"
            onClick={scrollToCleanup}
            className="rounded border border-amber-500/40 px-2 py-0.5 text-amber-200 transition-colors hover:bg-amber-500/20"
          >
            去清理
          </button>
        </div>
      )}

      {health === null ? (
        !healthError && (
          <p className="py-16 text-center font-mono text-xs text-zinc-600">
            加载中…
          </p>
        )
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <EngineCard health={health} />
            <RunProcessesCard health={health} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <DatabaseCard health={health} />
            <DiskCard health={health} />
          </div>

          <OrphanCard
            health={health}
            entities={orphanEntities}
            entityError={orphanError}
          />

          <CleanupPanel
            usage={cleanupUsage(health)}
            usageWarning={workspaceOverLimit}
            onDone={() => void load()}
          />
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 卡片                                                                        */
/* -------------------------------------------------------------------------- */

function EngineCard({ health }: { health: HealthPayload }) {
  const { engine } = health;
  // 换成 dsh 引擎后没有常驻外部服务（ADR-0006）：就绪只取决于 runner 入口在不在、
  // 凭据引用名有没有值。真正「活着的东西」是每次运行自己的子进程，见右边那张卡。
  const ok = engine.ready && engine.credentialConfigured;
  return (
    <Panel
      title="执行引擎"
      subtitle="DeepSeek Harness，每次运行一个子进程，无常驻外部服务"
      right={
        <span
          className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[11px] ${
            ok
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
              : "border-red-500/40 bg-red-500/10 text-red-300"
          }`}
        >
          <Dot tone={ok ? "emerald" : "red"} />
          {ok ? "就绪" : "未就绪"}
        </span>
      }
    >
      <dl className="grid grid-cols-[4.5rem_1fr] gap-y-1 font-mono text-[11px]">
        <dt className="text-zinc-500">runner</dt>
        <dd className="break-all text-zinc-200">{engine.runnerEntry || "—"}</dd>
        <dt className="text-zinc-500">凭据</dt>
        <dd className="text-zinc-200">
          {engine.credentialRef || "—"}
          <span
            className={
              engine.credentialConfigured ? "ml-2 text-emerald-400" : "ml-2 text-red-400"
            }
          >
            {engine.credentialConfigured ? "已配置" : "未配置"}
          </span>
        </dd>
      </dl>

      {!ok && (
        <div className="mt-3 space-y-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-200">
          {engine.error && <p className="font-mono break-all">{engine.error}</p>}
          <div>
            <p className="font-medium">排查步骤</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-red-200/90">
              {!engine.ready && (
                <li>
                  runner 入口不存在：确认{" "}
                  <code className="font-mono">src/server/harness/runner.ts</code> 未被删除。
                </li>
              )}
              {!engine.credentialConfigured && (
                <li>
                  把 <code className="font-mono">{engine.credentialRef}</code>{" "}
                  写进仓库根的 <code className="font-mono">.env.local</code>（已被 .gitignore
                  排除），然后重启 Next.js 进程——凭据在启动时按引用名从进程环境挑值。
                </li>
              )}
            </ol>
          </div>
        </div>
      )}
    </Panel>
  );
}

function RunProcessesCard({ health }: { health: HealthPayload }) {
  const { activeRuns, runEntries } = health.runProcesses;
  // 计数与明细应一一对应，不一致说明有子进程句柄没被 executeRun 的 finally 清掉
  const mismatch = activeRuns !== runEntries;
  return (
    <Panel
      title="运行子进程"
      subtitle="一次运行一个 harness 子进程，独占一个工作区"
      right={
        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-zinc-500">
          <Dot tone={mismatch ? "amber" : "zinc"} pulse={mismatch} />
          {mismatch ? "计数不一致" : "一致"}
        </span>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <MetricCard
          label="在跑运行"
          value={formatCount(activeRuns)}
          unit="个"
          tone={activeRuns > 0 ? "sky" : "zinc"}
          hint="ontoflowRunProcesses"
        />
        <MetricCard
          label="子进程句柄"
          value={formatCount(runEntries)}
          unit="个"
          tone={mismatch ? "amber" : "zinc"}
          hint="runProcesses.runs"
        />
      </div>
      <p className="mt-3 text-xs leading-5 text-zinc-500">
        运行收束时 executeRun 的 finally 会 dispose 子进程并从表里移除。
        {mismatch &&
          " 当前两个数字不相等，说明有子进程未被正常收束（进程内残留），重启 Next.js 进程即可清空。"}
      </p>
    </Panel>
  );
}

function DatabaseCard({ health }: { health: HealthPayload }) {
  const { database } = health;
  const maxRows = database.tables.reduce((m, t) => Math.max(m, t.rows), 0);
  const totalRows = database.tables.reduce((s, t) => s + t.rows, 0);
  return (
    <Panel
      title="数据库"
      subtitle={database.path || "data/ontoflow.db"}
      right={
        <Num className="text-[11px] text-zinc-400">
          {formatBytes(database.sizeBytes)}
        </Num>
      }
    >
      {database.tables.length === 0 ? (
        <p className="font-mono text-xs text-zinc-600">暂无表统计</p>
      ) : (
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full font-mono text-[11px]">
            <thead className="sticky top-0 bg-zinc-900 text-zinc-500">
              <tr className="text-left">
                <th className="py-1 pr-2 font-normal">表</th>
                <th className="py-1 pr-2 text-right font-normal">行数</th>
                <th className="w-24 py-1 font-normal">相对占比</th>
              </tr>
            </thead>
            <tbody>
              {database.tables.map((t) => (
                <tr key={t.name} className="border-t border-zinc-800/70">
                  <td className="py-1 pr-2 text-zinc-300">{t.name}</td>
                  <td className="py-1 pr-2 text-right">
                    <Num className="text-zinc-200">{formatCount(t.rows)}</Num>
                  </td>
                  <td className="py-1">
                    <MiniBar ratio={maxRows > 0 ? t.rows / maxRows : 0} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-zinc-700 text-zinc-400">
                <td className="py-1 pr-2">合计</td>
                <td className="py-1 pr-2 text-right">
                  <Num>{formatCount(totalRows)}</Num>
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** 三个数据目录的配色，取自 ui.tsx 的图表色板 */
const DISK_COLORS = [
  CHART_COLORS.tokens,
  CHART_COLORS.cancelled,
  CHART_COLORS.success,
];

function DiskCard({ health }: { health: HealthPayload }) {
  const { disk } = health;
  const segments = [
    { key: "runs", label: "data/runs 运行工作区", entry: disk.runs, unit: "个目录" },
    { key: "uploads", label: "data/uploads 上传", entry: disk.uploads, unit: "个文件" },
    {
      key: "documents",
      label: "data/documents 归档",
      entry: disk.documents,
      unit: "个文件",
    },
  ];
  const total = segments.reduce((s, x) => s + x.entry.sizeBytes, 0);
  const over = disk.runs.sizeBytes > WORKSPACE_WARN_BYTES;

  let cursor = 0;
  const bars = segments.map((seg, i) => {
    const w = total > 0 ? (seg.entry.sizeBytes / total) * 100 : 0;
    const x = cursor;
    cursor += w;
    return (
      <rect
        key={seg.key}
        x={x}
        y={0}
        width={w}
        height={6}
        fill={DISK_COLORS[i]}
      />
    );
  });

  return (
    <Panel
      title="磁盘占用"
      subtitle={`工作区阈值 ${formatBytes(WORKSPACE_WARN_BYTES)}，超出即在页面顶部告警`}
      right={
        <Num className="text-[11px] text-zinc-400">
          合计 {formatBytes(total)}
        </Num>
      }
    >
      <svg
        viewBox="0 0 100 6"
        preserveAspectRatio="none"
        className="h-3 w-full overflow-hidden rounded-sm bg-zinc-800"
        role="img"
        aria-label="三个数据目录的体积占比"
      >
        {total > 0 ? (
          bars
        ) : (
          <rect x={0} y={2.25} width={100} height={1.5} fill={CHART_COLORS.grid} />
        )}
      </svg>

      <div className="mt-2">
        <Legend
          items={segments.map((seg, i) => ({
            color: DISK_COLORS[i],
            label: seg.label,
          }))}
        />
      </div>

      <table className="mt-3 w-full font-mono text-[11px]">
        <tbody>
          {segments.map((seg) => (
            <tr key={seg.key} className="border-t border-zinc-800/70">
              <td className="py-1.5 pr-2 text-zinc-300">{seg.label}</td>
              <td className="py-1.5 pr-2 text-right text-zinc-500">
                <Num>{formatCount(seg.entry.count)}</Num> {seg.unit}
              </td>
              <td className="py-1.5 text-right">
                <Num
                  className={
                    seg.key === "runs" && over
                      ? "font-semibold text-amber-300"
                      : "text-zinc-200"
                  }
                >
                  {formatBytes(seg.entry.sizeBytes)}
                </Num>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function OrphanCard({
  health,
  entities,
  entityError,
}: {
  health: HealthPayload;
  entities: OrphanEntity[];
  entityError: string | null;
}) {
  const runs = health.orphanRuns;
  const grouped = new Map<string, OrphanEntity[]>();
  for (const e of entities) {
    const list = grouped.get(e.kind);
    if (list) list.push(e);
    else grouped.set(e.kind, [e]);
  }

  return (
    <Panel
      title="孤儿检测"
      subtitle="悬挂的运行 + 没人引用的库条目"
      right={
        <Num className="text-[11px] text-zinc-500">
          运行 {formatCount(runs.length)} · 实体 {formatCount(entities.length)}
        </Num>
      }
    >
      <section>
        <h3 className="mb-2 text-xs font-medium text-zinc-300">
          孤儿运行
          <span className="ml-2 font-normal text-zinc-500">
            状态仍为进行中、但进程内已无对应会话（多为进程重启遗留；下次启动的对账会把它们失败化）
          </span>
        </h3>
        {runs.length === 0 ? (
          <p className="font-mono text-xs text-zinc-600">
            无 —— 没有悬挂的运行
          </p>
        ) : (
          <div className="overflow-x-auto rounded border border-zinc-800">
            <table className="w-full font-mono text-[11px]">
              <thead className="bg-zinc-950/60 text-left text-zinc-500">
                <tr>
                  <th className="px-2 py-1.5 font-normal">运行</th>
                  <th className="px-2 py-1.5 font-normal">工作流</th>
                  <th className="px-2 py-1.5 font-normal">状态</th>
                  <th className="px-2 py-1.5 font-normal">开始</th>
                  <th className="px-2 py-1.5 font-normal">已挂起</th>
                  <th className="px-2 py-1.5 font-normal">滞留节点</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const started = toMillis(r.startedAt);
                  return (
                    <tr key={r.id} className="border-t border-zinc-800/70">
                      <td className="px-2 py-1.5">
                        <Link
                          href={`/runs/${r.id}`}
                          className="text-sky-400 underline-offset-2 hover:underline"
                        >
                          {r.id.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="px-2 py-1.5 text-zinc-300">
                        {r.workflowName || "—"}
                      </td>
                      <td className="px-2 py-1.5 text-amber-300">{r.status}</td>
                      <td className="px-2 py-1.5 text-zinc-400">
                        {started == null ? "—" : formatDateTime(started)}
                      </td>
                      <td className="px-2 py-1.5 text-zinc-400">
                        {durationText(r.startedAt, null)}
                      </td>
                      <td className="px-2 py-1.5 text-zinc-400">
                        {r.pendingNodes == null
                          ? (r.reason ?? "—")
                          : `${formatCount(r.pendingNodes)} 个`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-5">
        <h3 className="mb-2 text-xs font-medium text-zinc-300">
          孤儿实体
          <span className="ml-2 font-normal text-zinc-500">
            没有被任何工作流 / Action
            引用的库条目，点击可直接打开（工作流是顶层实体，不参与判定）
          </span>
        </h3>
        {entityError ? (
          <p className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 font-mono text-xs text-red-300">
            {entityError}
          </p>
        ) : grouped.size === 0 ? (
          <p className="font-mono text-xs text-zinc-600">
            无 —— 所有库条目都至少被引用一次
          </p>
        ) : (
          <div className="space-y-2">
            {[...grouped.entries()].map(([kind, list]) => (
              <div key={kind} className="flex flex-wrap items-baseline gap-2">
                <span className="w-24 shrink-0 font-mono text-[11px] text-zinc-500">
                  {kindLabel(kind)}（{list.length}）
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {list.map((e) => (
                    <Link
                      key={`${e.kind}:${e.id}`}
                      href={e.href || "#"}
                      className="rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 font-mono text-[11px] text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
                    >
                      {e.name}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </Panel>
  );
}

/** 表格里的行数占比条（纯 SVG） */
function MiniBar({ ratio }: { ratio: number }) {
  const w = Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <svg
      viewBox="0 0 100 4"
      preserveAspectRatio="none"
      className="h-1.5 w-full rounded-sm bg-zinc-800"
      aria-hidden="true"
    >
      <rect x={0} y={0} width={w} height={4} fill={CHART_COLORS.axis} />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* 工具                                                                        */
/* -------------------------------------------------------------------------- */

function scrollToCleanup(): void {
  document
    .getElementById("cleanup")
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * 清理面板旁常驻的「当前占用」文案，全部取自 health 接口。
 * 行数走 counts（服务端为此专门提供的字段），不再按表名去 database.tables 里捞：
 * 那是靠字符串匹配的软引用，表一改名就静默变 0，和清理面板显示 0 项是同一类坑。
 */
function cleanupUsage(health: HealthPayload): CleanupUsage {
  const { counts } = health;
  return {
    workspaces: `${formatBytes(health.disk.runs.sizeBytes)} · ${formatCount(
      health.disk.runs.count,
    )} 个目录`,
    events: `${formatCount(counts.runEvents)} 条事件`,
    runs: `${formatCount(counts.runs)} 条运行 · ${formatCount(
      counts.nodeUsage,
    )} 条用量明细`,
  };
}

async function fetchJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch {
    throw new Error(`网络错误，无法访问 ${url}`);
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      typeof data === "object" && data !== null && "error" in data
        ? String((data as { error: unknown }).error)
        : `请求失败（HTTP ${res.status}）：${url}`;
    throw new Error(message);
  }
  return data;
}

function errorText(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}
