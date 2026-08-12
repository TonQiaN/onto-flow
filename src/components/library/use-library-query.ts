"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { DEFAULT_SORT, isSortKey, type SortKey } from "./types";

export interface LibraryQuery {
  q: string;
  tags: string[];
  sort: SortKey;
  page: number;
  setQ: (v: string) => void;
  setTags: (ids: string[]) => void;
  setSort: (s: SortKey) => void;
  setPage: (p: number) => void;
}

/**
 * 列表页筛选状态 ↔ URL query 的读写（五个库统一 `?q=&tags=&sort=&page=`）。
 * 写入一律 router.replace(scroll:false)，不往历史栈塞记录；
 * 改 q / tags / sort 时自动回到第 1 页。
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
  const tagsParam = searchParams.get("tags") ?? "";
  const sortParam = searchParams.get("sort");
  const pageParam = Number.parseInt(searchParams.get("page") ?? "", 10);

  const tags = useMemo(
    () => tagsParam.split(",").filter((t) => t.length > 0),
    [tagsParam],
  );
  const sort: SortKey = isSortKey(sortParam) ? sortParam : DEFAULT_SORT;
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const setQ = useCallback(
    (v: string) => {
      write((p) => {
        const trimmed = v.trim();
        if (trimmed) p.set("q", trimmed);
        else p.delete("q");
        p.delete("page");
      });
    },
    [write],
  );

  const setTags = useCallback(
    (ids: string[]) => {
      write((p) => {
        if (ids.length) p.set("tags", ids.join(","));
        else p.delete("tags");
        p.delete("page");
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
      });
    },
    [write],
  );

  const setPage = useCallback(
    (n: number) => {
      write((p) => {
        if (n > 1) p.set("page", String(n));
        else p.delete("page");
      });
    },
    [write],
  );

  return { q, tags, sort, page, setQ, setTags, setSort, setPage };
}
