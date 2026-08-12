"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { DEFAULT_SORT, isSortKey, type SortKey } from "./types";

export interface LibraryQuery {
  q: string;
  /** 当前进入的文件夹 id；null = 全部（服务端按「含全部子孙」过滤，ADR-0005） */
  folder: string | null;
  sort: SortKey;
  page: number;
  /** 树上点实体叶子后要在列表里定位高亮的实体 id */
  highlight: string | null;
  setQ: (v: string) => void;
  setFolder: (id: string | null) => void;
  setSort: (s: SortKey) => void;
  setPage: (p: number) => void;
  /** 点实体叶子：一次写入同时进入其文件夹并高亮该实体卡片 */
  openEntity: (folderId: string | null, entityId: string) => void;
}

/**
 * 列表页筛选状态 ↔ URL query 的读写（统一 `?q=&folder=&sort=&page=&highlight=`，
 * workflow 库不分类，只用 q/sort/page）。
 * 写入一律 router.replace(scroll:false)，不往历史栈塞记录；
 * 改 q / folder / sort 时自动回到第 1 页；除 openEntity 外任何写入都清掉 highlight
 * （高亮是一次性的定位提示，筛选一变就过期）。
 *
 * 注意：这里只保证 page ≥ 1，**上界要等拿到信封的 total 才知道**，
 * 所以越界（例如删到只剩一页却停在 page=3）由 LibraryToolbar 拿到 total 后
 * 回调 setPage 夹到最后一页；本 hook 不做也做不了这件事。
 */
export function useLibraryQuery(): LibraryQuery {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const raw = searchParams.toString();

  // 同一 tick 内连续写多个参数时，以最近一次写入的 query 为基准，避免互相覆盖
  const pendingRef = useRef(raw);
  useEffect(() => {
    pendingRef.current = raw;
  }, [raw]);

  const write = useCallback(
    (mutate: (p: URLSearchParams) => void) => {
      const params = new URLSearchParams(pendingRef.current);
      mutate(params);
      const next = params.toString();
      pendingRef.current = next;
      router.replace(next ? `${pathname}?${next}` : pathname, {
        scroll: false,
      });
    },
    [pathname, router],
  );

  const q = searchParams.get("q") ?? "";
  const folder = searchParams.get("folder") || null;
  const highlight = searchParams.get("highlight") || null;
  const sortParam = searchParams.get("sort");
  const pageParam = Number.parseInt(searchParams.get("page") ?? "", 10);

  const sort: SortKey = isSortKey(sortParam) ? sortParam : DEFAULT_SORT;
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const setQ = useCallback(
    (v: string) => {
      write((p) => {
        const trimmed = v.trim();
        if (trimmed) p.set("q", trimmed);
        else p.delete("q");
        p.delete("page");
        p.delete("highlight");
      });
    },
    [write],
  );

  const setFolder = useCallback(
    (id: string | null) => {
      write((p) => {
        if (id) p.set("folder", id);
        else p.delete("folder");
        p.delete("page");
        p.delete("highlight");
      });
    },
    [write],
  );

  const setSort = useCallback(
    (s: SortKey) => {
      write((p) => {
        if (s === DEFAULT_SORT) p.delete("sort");
        else p.set("sort", s);
        p.delete("page");
        p.delete("highlight");
      });
    },
    [write],
  );

  const setPage = useCallback(
    (n: number) => {
      write((p) => {
        if (n > 1) p.set("page", String(n));
        else p.delete("page");
        p.delete("highlight");
      });
    },
    [write],
  );

  const openEntity = useCallback(
    (folderId: string | null, entityId: string) => {
      write((p) => {
        if (folderId) p.set("folder", folderId);
        else p.delete("folder");
        p.set("highlight", entityId);
        // 点叶子是绝对定位动作：清掉搜索词与页码，避免目标被残留筛选挡在列表外
        // （页码由列表请求带 locate=highlight 让服务端反查）
        p.delete("q");
        p.delete("page");
      });
    },
    [write],
  );

  return {
    q,
    folder,
    sort,
    page,
    highlight,
    setQ,
    setFolder,
    setSort,
    setPage,
    openEntity,
  };
}
