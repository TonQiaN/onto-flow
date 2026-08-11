/**
 * 运行历史 UI 的共享类型与格式化工具。
 * 时间字段经 JSON 序列化后可能是 ISO 字符串或毫秒数，统一用 toMillis 归一。
 */
import type { PortValue } from "@/lib/values";

export type RunStatus = "running" | "success" | "failed";
export type NodeStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "skipped";

/** GET /api/runs 列表项 */
export interface RunListItem {
  id: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  startedAt: string | number;
  finishedAt: string | number | null;
}

/** runs 表行（GET /api/runs/[id] 与 SSE snapshot 中的 run） */
export interface RunRow {
  id: string;
  workflowId: string;
  status: RunStatus;
  error: string | null;
  startedAt: string | number;
  finishedAt: string | number | null;
}

/** run_nodes 表行 */
export interface RunNodeRow {
  id: string;
  runId: string;
  nodeId: string;
  label: string;
  status: NodeStatus;
  inputs?: Record<string, unknown> | null;
  outputs?: Record<string, unknown> | null;
  sessionId?: string | null;
  error?: string | null;
  startedAt: string | number | null;
  finishedAt: string | number | null;
}

/** run_events 表行（SSE event: log 的 data） */
export interface RunEventRow {
  id: number;
  runId: string;
  nodeId: string | null;
  ts: string | number;
  type: string;
  payload: Record<string, unknown> | null;
}

/** 时间归一：接受毫秒数 / ISO 字符串 / Date，其余返回 null */
export function toMillis(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  if (value instanceof Date) return value.getTime();
  return null;
}

const pad = (n: number, len = 2) => String(n).padStart(len, "0");

/** yyyy-MM-dd HH:mm:ss */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** HH:mm:ss.SSS（事件日志时间戳） */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(
    d.getSeconds(),
  )}.${pad(d.getMilliseconds(), 3)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} 秒`;
  const m = Math.floor(s / 60);
  const restSec = Math.round(s % 60);
  if (m < 60) return `${m} 分 ${restSec} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** 耗时展示：未开始 → “—”；进行中 → 已耗时 + “…”；已结束 → 总耗时 */
export function durationText(startedAt: unknown, finishedAt: unknown): string {
  const start = toMillis(startedAt);
  if (start == null) return "—";
  const end = toMillis(finishedAt);
  if (end == null) return `${formatDuration(Date.now() - start)}…`;
  return formatDuration(end - start);
}

/** 宽松校验 run_nodes.inputs/outputs 里的值是否为 PortValue */
export function asPortValue(value: unknown): PortValue | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  if (o.kind === "text" && typeof o.text === "string") {
    return { kind: "text", text: o.text };
  }
  if (o.kind === "json" && "json" in o) {
    return { kind: "json", json: o.json };
  }
  if (o.kind === "file" && typeof o.file === "object" && o.file !== null) {
    const f = o.file as Record<string, unknown>;
    if (typeof f.name === "string" && typeof f.path === "string") {
      return {
        kind: "file",
        file: {
          path: f.path,
          name: f.name,
          mime: typeof f.mime === "string" ? f.mime : "",
        },
      };
    }
  }
  return null;
}
