"use client";

import { useState } from "react";

/**
 * 取消运行按钮：点击后就地展开二次确认，确认才真正 POST
 * /api/runs/[id]/cancel。成功后由 onCancelled 触发详情刷新
 * （SSE 也会推最新 snapshot，状态随即变为「已取消」）。
 */
export function CancelButton({ runId, onCancelled }: { runId: string; onCancelled: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doCancel = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/cancel`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : "取消运行失败");
        return;
      }
      setConfirming(false);
      onCancelled();
    } catch {
      setError("网络错误，取消运行失败");
    } finally {
      setPending(false);
    }
  };

  if (!confirming) {
    return (
      <div className="flex items-center gap-2">
        {error && <span className="text-xs text-red-600">{error}</span>}
        <button
          type="button"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-700"
        >
          取消运行
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-red-600">{error}</span>}
      <span className="text-sm text-zinc-600">确认中止本次运行？</span>
      <button
        type="button"
        disabled={pending}
        onClick={() => void doCancel()}
        className="rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-sm text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50"
      >
        {pending ? "取消中…" : "确认取消"}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => setConfirming(false)}
        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50"
      >
        再想想
      </button>
    </div>
  );
}
