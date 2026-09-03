"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type EntityKind, type EntityReference, readError } from "./types";

const REF_KIND_LABEL: Record<EntityReference["kind"], string> = {
  workflow: "工作流",
  action: "Action",
};

/** 「被引用」面板：谁在引用这个实体（ADR-0004 要求编辑面板常驻影响面提示） */
export function ReferencesPanel({ kind, id }: { kind: EntityKind; id: string }) {
  const [refs, setRefs] = useState<EntityReference[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) {
      setRefs([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/references?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        setError(await readError(res));
        setRefs(null);
        return;
      }
      const data = (await res.json()) as { refs?: EntityReference[] };
      setRefs(Array.isArray(data.refs) ? data.refs : []);
    } catch {
      setError("网络错误，无法加载引用信息");
      setRefs(null);
    } finally {
      setLoading(false);
    }
  }, [kind, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const map = new Map<EntityReference["kind"], EntityReference[]>();
    for (const ref of refs ?? []) {
      const list = map.get(ref.kind) ?? [];
      list.push(ref);
      map.set(ref.kind, list);
    }
    return [...map.entries()];
  }, [refs]);

  return (
    <section className="rounded-lg border border-zinc-200 bg-white">
      <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <h3 className="text-sm font-semibold text-zinc-900">被引用</h3>
        <span className="text-xs text-zinc-500">
          {loading ? "统计中…" : refs ? `被 ${refs.length} 处引用` : "引用信息不可用"}
        </span>
      </header>

      {error && (
        <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">
          {error}
          <button
            type="button"
            onClick={() => void load()}
            className="ml-2 underline hover:text-red-900"
          >
            重试
          </button>
        </div>
      )}

      <div className="px-4 py-3">
        {loading ? (
          <p className="py-4 text-center text-xs text-zinc-400">加载中…</p>
        ) : refs && refs.length === 0 ? (
          <p className="py-4 text-center text-xs text-zinc-400">暂无引用</p>
        ) : (
          <div className="space-y-4">
            {groups.map(([refKind, list]) => (
              <div key={refKind}>
                <p className="mb-1.5 text-xs font-medium text-zinc-500">
                  {REF_KIND_LABEL[refKind] ?? refKind}（{list.length}）
                </p>
                <ul className="space-y-1">
                  {list.map((ref, index) => (
                    <li key={`${ref.kind}:${ref.id}:${index}`}>
                      <Link
                        href={ref.href}
                        className="flex items-baseline gap-2 rounded-md px-2 py-1.5 text-sm text-zinc-800 hover:bg-zinc-50"
                      >
                        <span className="truncate font-medium">{ref.name}</span>
                        {ref.detail && (
                          <span className="truncate text-xs text-zinc-400">{ref.detail}</span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
