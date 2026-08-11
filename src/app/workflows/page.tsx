"use client";

/**
 * 工作流列表页：卡片列表（名称、描述、节点数、更新时间）+ 新建 / 重命名 / 删除。
 * 重命名走「GET 详情 → PUT 整图透传 + 新名称」以满足 PUT 整图替换契约。
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface WorkflowListItem {
  id: string;
  name: string;
  description: string;
  nodeCount?: number;
  updatedAt?: string | number;
}

type ModalState =
  | { mode: "create" }
  | { mode: "rename"; id: string }
  | null;

function formatTime(v?: string | number): string {
  if (v === undefined || v === null) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", { hour12: false });
}

export default function WorkflowsPage() {
  const router = useRouter();
  const [items, setItems] = useState<WorkflowListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [nameInput, setNameInput] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/workflows");
      const body = (await res.json().catch(() => null)) as
        | WorkflowListItem[]
        | { error?: string }
        | null;
      if (!res.ok || !Array.isArray(body)) {
        throw new Error(
          (body && !Array.isArray(body) && body.error) || "加载工作流列表失败",
        );
      }
      setItems(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setNameInput("");
    setModal({ mode: "create" });
  };

  const openRename = (w: WorkflowListItem) => {
    setNameInput(w.name);
    setModal({ mode: "rename", id: w.id });
  };

  const submitModal = async () => {
    const name = nameInput.trim();
    if (!name || !modal || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (modal.mode === "create") {
        const res = await fetch("/api/workflows", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, description: "" }),
        });
        const body = (await res.json().catch(() => null)) as {
          id?: string;
          error?: string;
        } | null;
        if (!res.ok || !body?.id) throw new Error(body?.error ?? "创建失败");
        router.push(`/workflows/${body.id}`);
        return;
      }
      // rename：先取整图再透传（PUT 为整图替换）
      const detailRes = await fetch(`/api/workflows/${modal.id}`);
      const detail = (await detailRes.json().catch(() => null)) as {
        workflow?: { description?: string };
        nodes?: unknown[];
        edges?: unknown[];
        error?: string;
      } | null;
      if (!detailRes.ok) throw new Error(detail?.error ?? "加载工作流失败");
      const res = await fetch(`/api/workflows/${modal.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: detail?.workflow?.description ?? "",
          nodes: detail?.nodes ?? [],
          edges: detail?.edges ?? [],
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) throw new Error(body?.error ?? "重命名失败");
      setModal(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (w: WorkflowListItem) => {
    if (!window.confirm(`确认删除工作流「${w.name}」？该操作不可恢复。`)) {
      return;
    }
    setError(null);
    const res = await fetch(`/api/workflows/${w.id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      setError(body?.error ?? "删除失败");
      return;
    }
    await load();
  };

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">工作流</h1>
          <p className="mt-0.5 text-sm text-zinc-400">
            编排 Action 的 DAG，点击卡片进入画布编辑器
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-700"
        >
          ＋ 新建工作流
        </button>
      </div>

      {error && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-700"
          >
            ×
          </button>
        </div>
      )}

      {items === null ? (
        <p className="text-sm text-zinc-400">加载中…</p>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white px-6 py-12 text-center text-sm text-zinc-400">
          还没有工作流，点击右上角「新建工作流」开始
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((w) => (
            <div
              key={w.id}
              onClick={() => router.push(`/workflows/${w.id}`)}
              className="cursor-pointer rounded-lg border border-zinc-200 bg-white p-4 shadow-sm transition-colors hover:border-zinc-400"
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="truncate text-sm font-semibold text-zinc-900">
                  {w.name}
                </h2>
                <div
                  className="flex shrink-0 gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    onClick={() => openRename(w)}
                    className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(w)}
                    className="rounded px-1.5 py-0.5 text-xs text-red-500 hover:bg-red-50 hover:text-red-700"
                  >
                    删除
                  </button>
                </div>
              </div>
              <p className="mt-1 line-clamp-2 min-h-[1.25rem] text-xs text-zinc-500">
                {w.description || "（无描述）"}
              </p>
              <div className="mt-3 flex items-center justify-between text-[11px] text-zinc-400">
                <span>
                  节点数：
                  {typeof w.nodeCount === "number" ? w.nodeCount : "—"}
                </span>
                <span>更新于 {formatTime(w.updatedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => {
            if (!busy) setModal(null);
          }}
        >
          <div
            className="w-96 rounded-lg border border-zinc-200 bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-zinc-900">
              {modal.mode === "create" ? "新建工作流" : "重命名工作流"}
            </h2>
            <input
              autoFocus
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitModal();
              }}
              placeholder="工作流名称"
              className="mt-3 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setModal(null)}
                disabled={busy}
                className="rounded-md border border-zinc-300 bg-white px-3.5 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void submitModal()}
                disabled={busy || !nameInput.trim()}
                className="rounded-md bg-zinc-900 px-3.5 py-1.5 text-sm text-white hover:bg-zinc-700 disabled:opacity-50"
              >
                {busy ? "处理中…" : "确定"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
