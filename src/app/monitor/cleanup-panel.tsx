"use client";

/**
 * 手动清理面板（本版只有手动，没有任何自动/定时清理）。
 *
 * 三个清理项各自独立：天数输入 → 「预览影响」(dryRun:true) → 「执行清理」二次确认
 * (dryRun:false)。确认框里必须复述影响并手输确认词，红色危险按钮，执行完回调刷新健康数据。
 * 每项旁边常驻显示当前占用，让人知道什么时候该清。
 */

import { useCallback, useState } from "react";
import { formatDateTime } from "@/app/runs/lib";
import {
  asCleanupResult,
  formatBytes,
  formatCount,
  type CleanupResult,
  type CleanupTarget,
} from "./lib";
import { Num, Panel } from "./ui";

const CONFIRM_WORD = "确认删除";

interface TargetSpec {
  key: CleanupTarget;
  title: string;
  /** 删什么 */
  what: string;
  /** 删了会失去什么（确认框里再强调一遍） */
  impact: string;
  defaultDays: number;
}

const SPECS: TargetSpec[] = [
  {
    key: "workspaces",
    title: "运行工作区目录",
    what: "删除 data/runs/<工作流>/<运行>/ 整个运行目录（workspace/、sessions/、logs/、tmp/、plugins/）：开始时间早于 N 天的运行工作区，以及目录修改时间早于 N 天、库里已无记录的孤儿目录。",
    impact:
      "运行记录、节点用量与事件都保留，但这些运行的现场文件不可再打开；仍在进行中的运行永远不会被删。",
    defaultDays: 7,
  },
  {
    key: "events",
    title: "事件明细",
    what: "两条资格各算各的：删除 run_events 中时间早于 N 天的事件行（文本增量、工具调用、会话错误/空闲），按每条事件自己的时间；把轮次行与节点行上的输入输出与快照置空，按运行的结束时间早于 N 天。进行中的运行两样都不动。",
    impact:
      "运行、节点与轮次的骨架（轮次、会话、起止、终态、出口、错误）与用量全部保留；运行页的回放只在被删事件覆盖的那段时间退化到轮次级，被置空的运行在抽屉的输入输出与快照两个页签只剩一句已清空的说明，轨迹面板退回显示技能 slug。",
    defaultDays: 30,
  },
  {
    key: "runs",
    title: "旧运行记录",
    what: "删除早于 N 天的 runs 记录，并级联删除其节点、事件、用量与持久业务结果。",
    impact:
      "运行历史、运行快照、用量明细与专用 API 结果一并消失，运行列表的用量汇总会缺这段区间；进行中的运行不会被删。",
    defaultDays: 90,
  },
];

export interface CleanupUsage {
  /** 每项旁常驻显示的当前占用文案 */
  workspaces: string;
  events: string;
  runs: string;
}

export function CleanupPanel({
  usage,
  usageWarning,
  onDone,
}: {
  usage: CleanupUsage;
  /** 工作区超阈值时置 true，对应项标红提示 */
  usageWarning?: boolean;
  /** 执行（非预览）成功后回调，用于刷新健康数据 */
  onDone: () => void;
}) {
  return (
    <div id="cleanup" className="scroll-mt-28">
      <Panel
        title="手动清理"
        subtitle="本版没有任何自动/定时清理，三项都要人工触发"
        right={<span className="font-mono text-[11px] text-red-600">删除不可撤销</span>}
        bodyClassName="divide-y divide-zinc-200"
      >
        {SPECS.map((spec) => (
          <CleanupItem
            key={spec.key}
            spec={spec}
            usageText={usage[spec.key]}
            warn={spec.key === "workspaces" && usageWarning === true}
            onDone={onDone}
          />
        ))}
      </Panel>
    </div>
  );
}

function CleanupItem({
  spec,
  usageText,
  warn,
  onDone,
}: {
  spec: TargetSpec;
  usageText: string;
  warn: boolean;
  onDone: () => void;
}) {
  const [days, setDays] = useState(spec.defaultDays);
  const [preview, setPreview] = useState<CleanupResult | null>(null);
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [busy, setBusy] = useState<"preview" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // 天数变了，上次的预览与结果都作废。下限 1 天：服务端要求 beforeDays 是正整数，
  // 没有「删全部」的入口（0 天会被拒成 400）
  const changeDays = (next: number) => {
    setDays(next);
    setPreview(null);
    setResult(null);
    setError(null);
  };

  const runPreview = useCallback(async (): Promise<CleanupResult | null> => {
    setBusy("preview");
    setError(null);
    try {
      const res = await callCleanup(spec.key, days, true);
      setPreview(res);
      return res;
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : "预览影响失败");
      return null;
    } finally {
      setBusy(null);
    }
  }, [spec.key, days]);

  const execute = async () => {
    setBusy("run");
    setError(null);
    try {
      const res = await callCleanup(spec.key, days, false);
      setResult(res);
      setPreview(null);
      setConfirming(false);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "执行清理失败");
    } finally {
      setBusy(null);
    }
  };

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  return (
    <div data-testid="cleanup-item" data-target={spec.key} className="px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-zinc-800">{spec.title}</h3>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-zinc-500">{spec.what}</p>
        </div>
        <div
          className={`shrink-0 rounded border px-2.5 py-1 font-mono text-[11px] ${
            warn
              ? "border-amber-200 bg-amber-50 text-amber-700"
              : "border-zinc-200 bg-zinc-50 text-zinc-600"
          }`}
        >
          当前占用 <Num>{usageText}</Num>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-zinc-600">
          保留最近
          <input
            type="number"
            min={1}
            max={3650}
            value={days}
            onChange={(e) => {
              const v = Number(e.target.value);
              changeDays(Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1);
            }}
            className="w-20 rounded border border-zinc-300 bg-white px-2 py-1 text-right font-mono text-xs text-zinc-800 outline-none focus:border-zinc-500"
          />
          天
        </label>
        <span className="font-mono text-[11px] text-zinc-500">
          截止 {formatDateTime(cutoff)} 之前
        </span>

        <button
          type="button"
          onClick={() => void runPreview()}
          disabled={busy !== null}
          className="rounded border border-zinc-300 bg-white px-3 py-1 text-xs text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50"
        >
          {busy === "preview" ? "预览中…" : "预览影响"}
        </button>
        <button
          type="button"
          onClick={() => {
            setConfirming(true);
            if (!preview && busy === null) void runPreview();
          }}
          disabled={busy !== null}
          className="rounded border border-red-300 bg-red-50 px-3 py-1 text-xs text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50"
        >
          执行清理
        </button>
      </div>

      {preview && (
        <p className="mt-2 font-mono text-xs text-zinc-700">
          预览：将删除 {formatCount(preview.items)} 项
          {preview.bytes > 0 && ` · 释放约 ${formatBytes(preview.bytes)}`}
          {preview.items === 0 && "（没有符合条件的数据，无需清理）"}
          {preview.note && <span className="text-zinc-500"> · {preview.note}</span>}
        </p>
      )}

      {result && (
        <p className="mt-2 font-mono text-xs text-emerald-700">
          已清理 {formatCount(result.items)} 项
          {result.bytes > 0 && ` · 释放 ${formatBytes(result.bytes)}`}
          {result.note && <span className="text-zinc-500"> · {result.note}</span>}
        </p>
      )}

      {error && (
        <p className="mt-2 rounded border border-red-200 bg-red-50 px-3 py-2 font-mono text-xs text-red-700">
          {error}
        </p>
      )}

      {confirming && (
        <ConfirmDialog
          spec={spec}
          days={days}
          cutoff={cutoff}
          preview={preview}
          previewing={busy === "preview"}
          running={busy === "run"}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void execute()}
        />
      )}
    </div>
  );
}

function ConfirmDialog({
  spec,
  days,
  cutoff,
  preview,
  previewing,
  running,
  onCancel,
  onConfirm,
}: {
  spec: TargetSpec;
  days: number;
  cutoff: number;
  preview: CleanupResult | null;
  previewing: boolean;
  running: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [word, setWord] = useState("");
  const ready = word.trim() === CONFIRM_WORD && !previewing && !running;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`确认清理 ${spec.title}`}
        className="w-full max-w-lg rounded-lg border border-red-200 bg-white shadow-xl"
      >
        <header className="border-b border-zinc-200 px-5 py-3">
          <h3 className="text-sm font-medium text-red-700">确认清理：{spec.title}</h3>
        </header>

        <div className="space-y-3 px-5 py-4 text-xs leading-5 text-zinc-700">
          <dl className="grid grid-cols-[6rem_1fr] gap-y-1.5 font-mono text-[11px]">
            <dt className="text-zinc-500">清理项</dt>
            <dd className="text-zinc-800">
              {spec.title}（{spec.key}）
            </dd>
            <dt className="text-zinc-500">保留窗口</dt>
            <dd className="text-zinc-800">最近 {days} 天</dd>
            <dt className="text-zinc-500">删除范围</dt>
            <dd className="text-zinc-800">{formatDateTime(cutoff)} 之前</dd>
            <dt className="text-zinc-500">影响面</dt>
            <dd className="text-zinc-800">
              {previewing ? (
                <span className="text-zinc-500">正在计算…</span>
              ) : preview ? (
                <>
                  {formatCount(preview.items)} 项
                  {preview.bytes > 0 && ` · ${formatBytes(preview.bytes)}`}
                  {preview.note && <span className="text-zinc-500"> · {preview.note}</span>}
                </>
              ) : (
                <span className="text-amber-700">预览失败，影响面未知</span>
              )}
            </dd>
          </dl>

          <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">
            {spec.impact}
            <br />
            <strong className="font-semibold">
              此操作立即生效且不可撤销，没有回收站、没有备份。
            </strong>
          </p>

          {preview?.items === 0 && (
            <p className="text-zinc-500">当前预览为 0 项，执行不会有任何变化。</p>
          )}

          <label className="block">
            <span className="text-zinc-600">
              请输入 <code className="text-zinc-900">{CONFIRM_WORD}</code> 以确认你已理解上述影响：
            </span>
            <input
              autoFocus
              value={word}
              onChange={(e) => setWord(e.target.value)}
              placeholder={CONFIRM_WORD}
              className="mt-1.5 w-full rounded border border-zinc-300 bg-white px-3 py-1.5 font-mono text-xs text-zinc-800 outline-none focus:border-red-400"
            />
          </label>
        </div>

        <footer className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={running}
            className="rounded border border-zinc-300 bg-white px-3 py-1.5 text-xs text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!ready}
            className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-200 disabled:text-red-400"
          >
            {running ? "清理中…" : "确认删除"}
          </button>
        </footer>
      </div>
    </div>
  );
}

async function callCleanup(
  target: CleanupTarget,
  days: number,
  dryRun: boolean,
): Promise<CleanupResult> {
  let res: Response;
  try {
    res = await fetch("/api/monitor/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 服务端字段名是 beforeDays（/api/monitor/cleanup 硬校验：必须是 ≥1 的整数），
      // 发 days 会被一律拒成 400——预览与执行六条路径全废，别再改回去
      body: JSON.stringify({ target, beforeDays: days, dryRun }),
      cache: "no-store",
    });
  } catch {
    throw new Error("网络错误，清理请求未送达");
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      typeof data === "object" && data !== null && "error" in data
        ? String((data as { error: unknown }).error)
        : `清理请求失败（HTTP ${res.status}）`;
    throw new Error(message);
  }
  return asCleanupResult(data, target, days, dryRun);
}
