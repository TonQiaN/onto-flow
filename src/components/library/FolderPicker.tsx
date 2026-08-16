"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type EntityKind,
  type FolderDto,
  type FolderRef,
  notifyFoldersChanged,
  readError,
} from "./types";

/** 下拉面板里的一行：扁平化后的文件夹 + 缩进深度 + 完整路径 */
interface PickerRow {
  id: string;
  name: string;
  path: string;
  depth: number;
}

/** 扁平文件夹 → 缩进有序行：父在前、同级按中文名升序，path = 根到本文件夹 */
function flattenFolders(folders: FolderDto[]): PickerRow[] {
  const ids = new Set(folders.map((f) => f.id));
  const childrenOf = new Map<string | null, FolderDto[]>();
  for (const f of folders) {
    // 父不存在（理论上不会发生）时视为根，避免整棵子树凭空消失
    const key = f.parentId && ids.has(f.parentId) ? f.parentId : null;
    const list = childrenOf.get(key);
    if (list) list.push(f);
    else childrenOf.set(key, [f]);
  }
  const rows: PickerRow[] = [];
  const walk = (parentKey: string | null, depth: number, prefix: string) => {
    const list = childrenOf.get(parentKey) ?? [];
    list.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
    for (const f of list) {
      const path = prefix ? `${prefix}/${f.name}` : f.name;
      rows.push({ id: f.id, name: f.name, path, depth });
      walk(f.id, depth + 1, path);
    }
  };
  walk(null, 0, "");
  return rows;
}

/** 小文件夹图标（与 FolderTree 同款内联 SVG） */
function FolderIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      className={className}
      aria-hidden="true"
    >
      <path d="M1.75 4.25c0-.55.45-1 1-1h3.1l1.4 1.5h6c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1v-7.5Z" />
    </svg>
  );
}

/**
 * 编辑器里的备选归类途径：只选择、不管理（新建/重命名/删除去列表页左树）。
 * 触发按钮显示当前归属 path（未归类时显示「未归类」）；下拉面板渲染缩进树 +
 * 顶部「未归类」选项 + 搜索框，单选即保存：
 * entityId 非空时 POST /api/folders/assign 成功后才回调 onChange 并广播；
 * entityId 为空（新建表单未落库）只改内存态，落库后由页面补指派。
 */
export function FolderPicker({
  kind,
  entityId,
  value,
  onChange,
}: {
  kind: EntityKind;
  entityId: string;
  value: FolderRef | null;
  onChange: (folder: FolderRef | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<PickerRow[] | null>(null);
  const [keyword, setKeyword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const loadOptions = useCallback(async () => {
    try {
      const res = await fetch("/api/folders", { cache: "no-store" });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const data = (await res.json()) as { folders?: FolderDto[] };
      setOptions(
        flattenFolders(Array.isArray(data.folders) ? data.folders : []),
      );
    } catch {
      setError("网络错误，无法加载文件夹列表");
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

  const trimmed = keyword.trim();
  /** 搜索时保留命中行及其祖先/子孙，缩进层级不断裂 */
  const visible = useMemo(() => {
    const rows = options ?? [];
    if (!trimmed) return rows;
    const lower = trimmed.toLowerCase();
    const hit = (r: PickerRow) => r.name.toLowerCase().includes(lower);
    return rows.filter(
      (r) =>
        hit(r) ||
        rows.some(
          (o) =>
            hit(o) &&
            (o.path.startsWith(`${r.path}/`) ||
              r.path.startsWith(`${o.path}/`)),
        ),
    );
  }, [options, trimmed]);

  /** 单选即保存；row 为 null = 未归类 */
  const choose = async (row: PickerRow | null) => {
    if (busy) return;
    const next: FolderRef | null = row
      ? { id: row.id, name: row.name, path: row.path }
      : null;
    if ((next?.id ?? null) === (value?.id ?? null)) {
      setOpen(false);
      return;
    }
    setError(null);
    // 实体尚未落库（新建表单）时只更新内存态，保存实体后由页面再行指派
    if (!entityId) {
      onChange(next);
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/folders/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityKind: kind,
          entityId,
          folderId: next?.id ?? null,
        }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      onChange(next);
      notifyFoldersChanged();
      setOpen(false);
    } catch {
      setError("网络错误，归类未保存");
    } finally {
      setBusy(false);
    }
  };

  /** 单选对勾：选中行显示 ✓，未选中占位保持对齐 */
  const check = (on: boolean) => (
    <span
      className={`w-3.5 shrink-0 text-center text-[10px] leading-none ${
        on ? "text-zinc-900" : "text-transparent"
      }`}
    >
      ✓
    </span>
  );

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={value ? `当前归属：${value.path}` : "未归类"}
        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 hover:border-zinc-400"
      >
        <FolderIcon className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        <span className="max-w-48 truncate">{value?.path ?? "未归类"}</span>
        <span className="text-[10px] text-zinc-400">▾</span>
      </button>

      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}

      {open && (
        <div className="absolute z-40 mt-1 w-64 rounded-lg border border-zinc-200 bg-white shadow-lg">
          <div className="border-b border-zinc-200 p-2">
            <input
              autoFocus
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索文件夹…"
              className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs focus:border-zinc-500 focus:outline-none"
            />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => void choose(null)}
              className="flex w-full items-center gap-2 border-b border-zinc-100 px-3 py-1.5 text-left text-xs text-zinc-500 hover:bg-zinc-50 disabled:opacity-50"
            >
              {check(value === null)}
              <span>未归类</span>
            </button>
            {options === null ? (
              <p className="px-3 py-3 text-xs text-zinc-400">加载中…</p>
            ) : visible.length === 0 ? (
              <p className="px-3 py-3 text-xs text-zinc-400">
                {trimmed ? "没有匹配的文件夹" : "还没有文件夹"}
              </p>
            ) : (
              visible.map((row) => {
                const on = value?.id === row.id;
                return (
                  <button
                    key={row.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void choose(row)}
                    title={row.path}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                    style={{ paddingLeft: `${row.depth * 12 + 12}px` }}
                  >
                    {check(on)}
                    <FolderIcon className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                    <span className="truncate">{row.name}</span>
                  </button>
                );
              })
            )}
          </div>
          <p className="border-t border-zinc-100 px-3 py-1.5 text-[11px] text-zinc-400">
            文件夹的新建与整理在库列表页左侧树进行
          </p>
        </div>
      )}
    </div>
  );
}
