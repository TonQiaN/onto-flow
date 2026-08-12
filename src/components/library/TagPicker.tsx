"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type EntityKind,
  notifyTagsChanged,
  readError,
  type Tag,
  tagColor,
} from "./types";

/**
 * 实体上的标签编辑：下拉多选已有标签 + 输入新名字直接创建 + 移除。
 * 每次变更立刻 POST /api/tags/assign 整体替换该实体的标签集合，成功后才回调 onChange。
 */
export function TagPicker({
  kind,
  entityId,
  value,
  onChange,
}: {
  kind: EntityKind;
  entityId: string;
  value: Tag[];
  onChange: (tags: Tag[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Tag[] | null>(null);
  const [keyword, setKeyword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const loadOptions = useCallback(async () => {
    try {
      const res = await fetch("/api/tags", { cache: "no-store" });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const data = (await res.json()) as Tag[];
      setOptions(Array.isArray(data) ? data : []);
    } catch {
      setError("网络错误，无法加载标签列表");
    }
  }, []);

  useEffect(() => {
    if (open && options === null) void loadOptions();
  }, [open, options, loadOptions]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /** 整体替换该实体的标签集合并回调 */
  const persist = useCallback(
    async (next: Tag[]) => {
      setError(null);
      // 实体尚未落库（新建表单）时只更新内存态，保存实体后由页面再行指派
      if (!entityId) {
        onChange(next);
        return true;
      }
      setBusy(true);
      try {
        const res = await fetch("/api/tags/assign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entityKind: kind,
            entityId,
            tagIds: next.map((t) => t.id),
          }),
        });
        if (!res.ok) {
          setError(await readError(res));
          return false;
        }
        onChange(next);
        notifyTagsChanged();
        return true;
      } catch {
        setError("网络错误，标签未保存");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [entityId, kind, onChange],
  );

  const selectedIds = useMemo(() => new Set(value.map((t) => t.id)), [value]);
  const trimmed = keyword.trim();
  const filtered = useMemo(() => {
    const list = options ?? [];
    if (!trimmed) return list;
    const lower = trimmed.toLowerCase();
    return list.filter((t) => t.name.toLowerCase().includes(lower));
  }, [options, trimmed]);
  const exactExists = (options ?? []).some((t) => t.name === trimmed);

  const toggle = async (tag: Tag) => {
    const next = selectedIds.has(tag.id)
      ? value.filter((t) => t.id !== tag.id)
      : [...value, tag];
    await persist(next);
  };

  const create = async () => {
    if (!trimmed || busy) return;
    setError(null);
    setBusy(true);
    let created: Tag | null = null;
    try {
      const res = await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      created = (await res.json()) as Tag;
      setOptions((prev) => [...(prev ?? []), created as Tag]);
      setKeyword("");
      notifyTagsChanged();
    } catch {
      setError("网络错误，标签创建失败");
    } finally {
      setBusy(false);
    }
    if (created) await persist([...value, created]);
  };

  return (
    <div ref={boxRef} className="relative">
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((tag) => (
          <span
            key={tag.id}
            className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-xs text-zinc-700"
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: tagColor(tag) }}
            />
            {tag.name}
            <button
              type="button"
              aria-label={`移除标签 ${tag.name}`}
              disabled={busy}
              onClick={() => void toggle(tag)}
              className="text-zinc-400 hover:text-red-600 disabled:opacity-50"
            >
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-full border border-dashed border-zinc-300 px-2 py-0.5 text-xs text-zinc-500 hover:border-zinc-400 hover:text-zinc-700"
        >
          ＋ 标签
        </button>
      </div>

      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}

      {open && (
        <div className="absolute z-40 mt-1 w-64 rounded-lg border border-zinc-200 bg-white shadow-lg">
          <div className="border-b border-zinc-200 p-2">
            <input
              autoFocus
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && trimmed && !exactExists) void create();
              }}
              placeholder="搜索或输入新标签名…"
              className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs focus:border-zinc-500 focus:outline-none"
            />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {options === null ? (
              <p className="px-3 py-3 text-xs text-zinc-400">加载中…</p>
            ) : filtered.length === 0 && !trimmed ? (
              <p className="px-3 py-3 text-xs text-zinc-400">还没有标签</p>
            ) : (
              filtered.map((tag) => {
                const checked = selectedIds.has(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void toggle(tag)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                  >
                    <span
                      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] leading-none ${
                        checked
                          ? "border-zinc-900 bg-zinc-900 text-white"
                          : "border-zinc-300"
                      }`}
                    >
                      {checked ? "✓" : ""}
                    </span>
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: tagColor(tag) }}
                    />
                    <span className="truncate">{tag.name}</span>
                  </button>
                );
              })
            )}
            {trimmed && !exactExists && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void create()}
                className="flex w-full items-center gap-2 border-t border-zinc-100 px-3 py-2 text-left text-xs text-zinc-900 hover:bg-zinc-50 disabled:opacity-50"
              >
                创建标签「{trimmed}」
              </button>
            )}
          </div>
          <p className="border-t border-zinc-100 px-3 py-1.5 text-[11px] text-zinc-400">
            标签名用 / 表达层级，如 采购/集采
          </p>
        </div>
      )}
    </div>
  );
}
