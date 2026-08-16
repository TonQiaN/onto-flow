"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { SORT_OPTIONS, type SortKey } from "./types";

const DEBOUNCE_MS = 300;

/**
 * 搜索 + 排序 + 分页状态条。组件本身是受控的（URL 同步交给页面的 useLibraryQuery），
 * 只有搜索框内部维护即时输入态，300ms 防抖后才回调 onQChange。
 * 另负责分页越界自愈：URL 上的 page 超过实际页数时夹到最后一页并提示（见下）。
 */
export function LibraryToolbar({
  q,
  onQChange,
  sort,
  onSortChange,
  total,
  page,
  pageSize,
  onPageChange,
  right,
}: {
  q: string;
  onQChange: (v: string) => void;
  sort: SortKey;
  onSortChange: (s: SortKey) => void;
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
  right?: ReactNode;
}) {
  const [text, setText] = useState(q);
  /** 越界纠正提示：从第几页夹到了第几页（区分「翻过头了」与「真的没数据」） */
  const [clamped, setClamped] = useState<{ from: number; to: number } | null>(
    null,
  );
  /** 最近一次由本组件发出（或从外部同步进来）的值，用于区分外部改动与自身回声 */
  const emitted = useRef(q);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // 外部（URL 回填、清空筛选）改了 q 才回写输入框；自身回声不打断输入。
    // 页面通常把 q 写进 URL 时会 trim，故 trim 后相等也视为回声。
    if (q !== emitted.current && q !== emitted.current.trim()) {
      emitted.current = q;
      setText(q);
    }
  }, [q]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const emit = (value: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    emitted.current = value;
    onQChange(value);
  };

  const change = (value: string) => {
    setText(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => emit(value), DEBOUNCE_MS);
  };

  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const current = Math.min(Math.max(1, page), totalPages);
  /** URL 上的 page 超出实际页数（删到只剩一页却仍停在 page=3 之类） */
  const outOfRange = total > 0 && page > totalPages;

  /**
   * 越界页自动夹到最后一页并触发重拉。
   * 不夹的话页面是死的：服务端按 page=3 返回空 items，分页条按 total 显示「1/1」、
   * 上下页因 current 已被夹成 1 而全部禁用，用户既翻不动也看不到数据，
   * 还会看到「还没有数据」这种与事实相反的空态。
   * clampedRef 保证同一个越界页只夹一次，避免与父组件的 URL 回写来回打架。
   */
  const clampedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!outOfRange) {
      clampedRef.current = null;
      return;
    }
    if (clampedRef.current === page) return;
    clampedRef.current = page;
    setClamped({ from: page, to: totalPages });
    onPageChange(totalPages);
  }, [outOfRange, page, totalPages, onPageChange]);

  // 筛选条件变了，上一次的越界提示就过期了
  useEffect(() => {
    setClamped(null);
  }, [q, sort]);

  const goto = (p: number) => {
    setClamped(null);
    onPageChange(p);
  };

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1">
          <input
            value={text}
            onChange={(e) => change(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") emit(text);
              if (e.key === "Escape") {
                setText("");
                emit("");
              }
            }}
            placeholder="搜索名称或描述…"
            className="w-full rounded-md border border-zinc-300 bg-white py-2 pr-8 pl-3 text-sm focus:border-zinc-500 focus:outline-none"
          />
          {text && (
            <button
              type="button"
              aria-label="清空搜索"
              onClick={() => {
                setText("");
                emit("");
              }}
              className="absolute top-1/2 right-2 -translate-y-1/2 text-sm text-zinc-400 hover:text-zinc-700"
            >
              ×
            </button>
          )}
        </div>

        <label className="flex shrink-0 items-center gap-2 text-sm text-zinc-500">
          排序
          <select
            value={sort}
            onChange={(e) => onSortChange(e.target.value as SortKey)}
            className="rounded-md border border-zinc-300 bg-white px-2 py-2 text-sm text-zinc-800 focus:border-zinc-500 focus:outline-none"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <div className="flex shrink-0 items-center gap-2 text-sm text-zinc-500">
          <span className="tabular-nums">共 {total} 条</span>
          <button
            type="button"
            onClick={() => goto(current - 1)}
            disabled={current <= 1}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 disabled:hover:bg-white"
          >
            上一页
          </button>
          <span className="tabular-nums text-zinc-600">
            {current} / {totalPages}
          </span>
          <button
            type="button"
            onClick={() => goto(current + 1)}
            disabled={current >= totalPages}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 disabled:hover:bg-white"
          >
            下一页
          </button>
        </div>

        {right && <div className="shrink-0">{right}</div>}
      </div>

      {/* 越界纠正提示：让「翻过头了，已跳回来」与「这里真的没有数据」两种空态可区分 */}
      {(clamped || outOfRange) && (
        <p className="mt-2 text-xs text-amber-700">
          第 {clamped?.from ?? page} 页已不存在（当前共 {totalPages} 页），
          已自动跳到第 {clamped?.to ?? totalPages} 页。
        </p>
      )}
    </div>
  );
}
