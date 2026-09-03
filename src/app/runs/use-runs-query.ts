"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { asStatusFilter, formatDateTime, type RunStatus } from "./lib";

/**
 * 运行列表筛选态 ↔ URL query 的读写（`?workflowId=&status=&source=&from=&to=&page=`）。
 * 与库页面 `use-library-query` 同一习惯：一律 router.replace(scroll:false) 不塞历史栈；
 * 任何筛选变化都回到第 1 页（页码是筛选集内的位置，筛选一变就过期）。
 *
 * from / to 用 epoch 毫秒住 URL，与 `/api/runs` 的同名参数同单位——同一个筛选在地址栏与
 * 请求里是同一个数，不需要两套换算；日期输入框的年月日换算由本文件下方两对纯函数负责。
 *
 * 注意：这里只保证 page ≥ 1，上界要拿到载荷的 total 才知道，越界回夹由页面负责。
 */
export interface RunsQuery {
  workflowId: string;
  status: "" | RunStatus;
  source: string;
  /** 起始时刻（含），未选为 null */
  from: number | null;
  /** 结束时刻（不含），未选为 null */
  to: number | null;
  page: number;
  /** 是否有任一筛选生效（空态文案与「清除筛选」按钮据此区分） */
  filtered: boolean;
  setFilter: (patch: RunsFilterPatch) => void;
  setPage: (page: number) => void;
  clearFilters: () => void;
}

export interface RunsFilterPatch {
  workflowId?: string;
  status?: "" | RunStatus;
  source?: string;
  from?: number | null;
  to?: number | null;
}

const FILTER_KEYS = ["workflowId", "status", "source", "from", "to"] as const;

function readMillis(raw: string | null): number | null {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isSafeInteger(value) ? value : null;
}

export function useRunsQuery(): RunsQuery {
  const router = useRouter();
  const searchParams = useSearchParams();
  const raw = searchParams.toString();

  // 同一 tick 内连续写多个参数时以最近一次写入为基准，避免互相覆盖（同 use-library-query）
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
      router.replace(next ? `/runs?${next}` : "/runs", { scroll: false });
    },
    [router],
  );

  const workflowId = searchParams.get("workflowId") ?? "";
  const status = asStatusFilter(searchParams.get("status"));
  const source = searchParams.get("source") ?? "";
  const from = readMillis(searchParams.get("from"));
  const to = readMillis(searchParams.get("to"));
  const pageRaw = Number.parseInt(searchParams.get("page") ?? "", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  const setFilter = useCallback(
    (patch: RunsFilterPatch) => {
      write((p) => {
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined || value === null || value === "") p.delete(key);
          else p.set(key, String(value));
        }
        p.delete("page");
      });
    },
    [write],
  );

  const setPage = useCallback(
    (next: number) => {
      write((p) => {
        if (next > 1) p.set("page", String(next));
        else p.delete("page");
      });
    },
    [write],
  );

  const clearFilters = useCallback(() => {
    write((p) => {
      for (const key of FILTER_KEYS) p.delete(key);
      p.delete("page");
    });
  }, [write]);

  return {
    workflowId,
    status,
    source,
    from,
    to,
    page,
    filtered: Boolean(workflowId || status || source || from !== null || to !== null),
    setFilter,
    setPage,
    clearFilters,
  };
}

/* ------------------------------ 日期输入框 ↔ epoch 毫秒 ------------------------------ */
/**
 * 时间范围是左闭右开的 [from, to)：起始日取当地 0 点，结束日取次日 0 点，
 * 这样「起=止=同一天」筛出的就是那一整天。回填输入框时结束日要减 1 毫秒才落回当天。
 * 一律按浏览器所在时区解释——运行列表的时刻也是按本地时区展示的。
 */
function parseDate(value: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(y, m - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) return null;
  return { y, m, d };
}

/** 起始日输入框 → 当地 0 点毫秒；空串或非法日期为 null（即不限） */
export function rangeStartMillis(value: string): number | null {
  const parts = parseDate(value);
  return parts === null ? null : new Date(parts.y, parts.m - 1, parts.d).getTime();
}

/** 结束日输入框 → 次日当地 0 点毫秒（开区间上界）；空串或非法日期为 null */
export function rangeEndMillis(value: string): number | null {
  const parts = parseDate(value);
  return parts === null ? null : new Date(parts.y, parts.m - 1, parts.d + 1).getTime();
}

/** 起始毫秒 → 输入框的 yyyy-MM-dd */
export function rangeStartInput(ms: number | null): string {
  return ms === null ? "" : formatDateTime(ms).slice(0, 10);
}

/** 开区间上界毫秒 → 输入框的 yyyy-MM-dd（减 1 毫秒落回选中的那一天） */
export function rangeEndInput(ms: number | null): string {
  return ms === null ? "" : formatDateTime(ms - 1).slice(0, 10);
}
