"use client";

import { useEffect, useRef, useState } from "react";
import type { RunNodeRoundPayload, RunNodeRoundRow, RunStatus } from "../lib";

type PayloadState = { key: string; refreshing: boolean } & (
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; payload: RunNodeRoundPayload }
);

/** 仅打开载荷页签时读取；终态轮缓存，执行中的轮串行重读，版本变化取消旧请求。 */
export function useRoundPayload({
  runId,
  nodeId,
  round,
  runStatus,
  enabled,
}: {
  runId: string;
  nodeId: string;
  round: RunNodeRoundRow | null;
  runStatus: RunStatus;
  enabled: boolean;
}) {
  const cache = useRef(new Map<string, { version: string; payload: RunNodeRoundPayload }>());
  const [state, setState] = useState<PayloadState>();
  const [refreshTick, setRefreshTick] = useState(0);
  const roundNo = round?.round ?? null;
  const key = `${runId}/${nodeId}/${roundNo}`;
  // 用权威轮次状态，不用光标推导的视觉状态：回放不会把已完成载荷变回旧版本。
  const version = JSON.stringify([
    round?.status,
    round?.sessionId,
    round?.finishedAt,
    round?.payloadClearedAt,
    runStatus,
  ]);
  const live = round?.status === "running" && runStatus === "running";

  useEffect(() => {
    if (!enabled || roundNo === null) return;
    const cached = cache.current.get(key);
    if (!live && cached?.version === version) {
      setState({ key, status: "ready", payload: cached.payload, refreshing: false });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const load = async () => {
      setState((previous) =>
        previous?.key === key && previous.status === "ready"
          ? { ...previous, refreshing: true }
          : { key, status: "loading", refreshing: true },
      );
      try {
        const res = await fetch(
          `/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/rounds/${roundNo}`,
          {
            cache: "no-store",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
          },
        );
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok)
          throw new Error(typeof data?.error === "string" ? data.error : "读取这一轮的记录失败");
        const payload = data as RunNodeRoundPayload;
        cache.current.set(key, { version, payload });
        setState({ key, status: "ready", payload, refreshing: false });
        // 一次读完才安排下一次，慢请求不叠加；关闭页签或进入终态即停止。
        if (live) timer = setTimeout(() => void load(), 2000);
      } catch (error) {
        if (!cancelled) cache.current.delete(key);
        if (!cancelled)
          setState({
            key,
            status: "error",
            message:
              error instanceof Error && error.name === "TimeoutError"
                ? "读取超时，请重试"
                : error instanceof Error && error.name !== "TypeError"
                  ? error.message
                  : "网络错误，读取这一轮的记录失败",
            refreshing: false,
          });
      }
    };
    void load();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [enabled, key, version, live, nodeId, roundNo, runId, refreshTick]);

  const refresh = () => {
    cache.current.delete(key);
    setRefreshTick((n) => n + 1);
  };
  return { entry: state?.key === key ? state : undefined, refresh, refreshTick };
}
