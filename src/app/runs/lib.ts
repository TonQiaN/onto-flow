/**
 * 运行历史 UI 的共享类型与格式化工具。
 * 时间字段经 JSON 序列化后可能是 ISO 字符串或毫秒数，统一用 toMillis 归一。
 */
import type { PortValue } from "@/lib/values";

/** cancelled 是人为终结的独立终态，区别于 failed */
export type RunStatus = "running" | "success" | "failed" | "cancelled";
export type NodeStatus = "pending" | "running" | "success" | "failed" | "skipped" | "cancelled";

/** 列表页状态筛选：空串代表「全部」，其余写进 URL 的 ?status= */
export const RUN_STATUS_FILTERS: Array<{ value: "" | RunStatus; label: string }> = [
  { value: "", label: "全部" },
  { value: "success", label: "成功" },
  { value: "failed", label: "失败" },
  { value: "cancelled", label: "已取消" },
  { value: "running", label: "进行中" },
];

export function asStatusFilter(value: string | null): "" | RunStatus {
  const hit = RUN_STATUS_FILTERS.find((f) => f.value !== "" && f.value === value);
  return hit ? hit.value : "";
}

/** GET /api/runs 列表项（用量为该次运行全部节点的合计） */
export interface RunListItem {
  id: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  startedAt: string | number;
  finishedAt: string | number | null;
  totalTokens: number;
  totalCost: number;
  /** 节点总数与已收束数（success/failed/cancelled/skipped），驱动进度展示 */
  nodesTotal: number;
  nodesDone: number;
}

/** runs 表行（GET /api/runs/[id] 与 SSE snapshot 中的 run） */
export interface RunRow {
  id: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  error: string | null;
  /** 相对项目根目录的运行目录；工作区位于其 workspace/ 子目录。 */
  runDir: string | null;
  /** 受理时冻结的三层设置（RunSettingsSnapshot，ADR-0016）；早于三层设置的运行为 null */
  settingsSnapshot?: unknown;
  startedAt: string | number;
  finishedAt: string | number | null;
}

/** run_nodes 的六个用量字段 */
export interface NodeUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

/** run_nodes 表行 */
export interface RunNodeRow extends NodeUsage {
  id: string;
  runId: string;
  nodeId: string;
  label: string;
  status: NodeStatus;
  /** 运行快照：本次执行实际使用的完整配置，可能为 null（输入/输出节点无快照） */
  snapshot?: unknown;
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

/** GET /api/runs/[id]/nodes/[nodeId]/trajectory 的详情片段。 */
export interface TrajectoryDetail {
  label: string;
  content: string;
  format: "text" | "json";
  truncated: boolean;
}

export interface TrajectoryUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** 一条会话轨迹记录；startedAt / finishedAt 同时供三泳道时间条投影。 */
export interface TrajectoryRecord {
  id: string;
  seq: number;
  kind: "system" | "user" | "context" | "assistant" | "tool" | "error";
  lane: "input" | "model" | "tools";
  label: string;
  summary: string;
  turn: number | null;
  step: number | null;
  startedAt: number;
  finishedAt: number | null;
  state: "complete" | "running" | "error";
  callId?: string;
  toolName?: string;
  details: TrajectoryDetail[];
  usage?: TrajectoryUsage;
}

export interface TrajectorySession {
  id: string;
  round: number;
  status:
    | "running"
    | "completed"
    | "error"
    | "aborted"
    | "blocked"
    | "max-tokens"
    | "interrupted"
    | "unknown";
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  provider: string;
  model: string;
  contextWindow: number | null;
  turns: number;
  steps: number;
  calls: number;
  records: TrajectoryRecord[];
}

export type AgentTrajectoryResponse =
  | { available: true; sessions: TrajectorySession[] }
  | {
      available: false;
      reason: "not-recorded" | "cleaned";
      sessions: [];
    };

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

/** outputTokens 已含 reasoning；推理 token 只作拆分展示，不能再次计入总量。 */
export function sumTokens(usage: Partial<NodeUsage> | null | undefined): number {
  if (!usage) return 0;
  return (
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  );
}

/** 多个节点的用量求和 */
export function totalUsage(nodes: Array<Partial<NodeUsage>>): {
  tokens: number;
  cost: number;
} {
  return nodes.reduce<{ tokens: number; cost: number }>(
    (acc, n) => ({
      tokens: acc.tokens + sumTokens(n),
      cost: acc.cost + (n.cost ?? 0),
    }),
    { tokens: 0, cost: 0 },
  );
}

export function formatTokens(n: number): string {
  return Math.round(n).toLocaleString("zh-CN");
}

/** 费用为美元，保留 4 位；极小的非零值不显示成 $0.0000 */
/** 费用单位是人民币：按 DeepSeek 官方峰谷价在落库时计算（src/server/pricing.ts）。 */
export function formatCost(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "¥0";
  if (n < 0.0001) return "<¥0.0001";
  return `¥${n.toFixed(4)}`;
}

/** run_nodes.snapshot 的展示形态（服务端 RunSnapshot 的宽松镜像） */
export interface RunSnapshotPortView {
  name: string;
  objectTypeName: string;
  kind: string;
}

/** 工作流技能集里的一项：content 是会话启动前读到的投影正文，preloaded 标记本 Action 的预载 */
export interface RunSnapshotSkillView {
  id: string;
  name: string;
  slug: string;
  preloaded: boolean;
  content: string;
}

/** 工作流 Tool 集里的一项公名；visible 标记本 Action 会话看得见它 */
export interface RunSnapshotToolView {
  name: string;
  visible: boolean;
}

export interface RunSnapshotView {
  actionName: string;
  prompt: string;
  rule: string;
  model: string;
  reasoningEffort: string;
  skills: RunSnapshotSkillView[];
  tools: RunSnapshotToolView[];
  /** 实际发给模型的完整提示（含预载的 /技能 行、上游产物指引与产物要求） */
  renderedPrompt: string;
  inputs: RunSnapshotPortView[];
  outputs: RunSnapshotPortView[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function asSnapshotSkills(value: unknown): RunSnapshotSkillView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const o = item as Record<string, unknown>;
    return [
      {
        id: str(o.id),
        name: str(o.name),
        slug: str(o.slug),
        preloaded: o.preloaded === true,
        content: str(o.content),
      },
    ];
  });
}

function asSnapshotTools(value: unknown): RunSnapshotToolView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const o = item as Record<string, unknown>;
    return [{ name: str(o.name), visible: o.visible === true }];
  });
}

function asPorts(value: unknown): RunSnapshotPortView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const o = item as Record<string, unknown>;
    return [
      {
        name: str(o.name),
        objectTypeName: str(o.objectTypeName),
        kind: str(o.kind),
      },
    ];
  });
}

/** 宽松解析 run_nodes.snapshot（历史行可能缺字段，缺什么就空什么） */
export function asRunSnapshot(value: unknown): RunSnapshotView | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  const model = o.model as Record<string, unknown> | undefined;
  const ports = (o.ports ?? {}) as Record<string, unknown>;
  return {
    actionName: str(o.actionName),
    prompt: str(o.prompt),
    rule: str(o.rule),
    model: model
      ? str(model.displayName) ||
        [str(model.providerId), str(model.modelId)].filter(Boolean).join("/")
      : "",
    reasoningEffort: str(o.reasoningEffort),
    skills: asSnapshotSkills(o.skills),
    tools: asSnapshotTools(o.tools),
    renderedPrompt: str(o.renderedPrompt),
    inputs: asPorts(ports.inputs),
    outputs: asPorts(ports.outputs),
  };
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

/**
 * run_events 里 compaction 事件的一行中文摘要（引擎侧出处：src/server/engine/events.ts）。
 * 载荷只有长度与用量，没有摘要正文；正文看 Action 轨迹面板。
 */
export function compactionEventLine(payload: Record<string, unknown> | null): string {
  const p = payload ?? {};
  const n = (value: unknown): number => (typeof value === "number" ? value : 0);
  const s = (value: unknown): string => (typeof value === "string" ? value : "");
  if (p.op === "prune") {
    return `工具结果已裁剪：${n(p.shadowedNodes)} 条（约 ${formatTokens(n(p.shadowedTokenCount))} tokens）`;
  }
  if (p.status === "running") {
    return `上下文压缩中${typeof p.turn === "number" ? `（回合 ${p.turn}）` : ""}…`;
  }
  if (p.status === "error") {
    return `上下文压缩失败：${s(p.error) || "未知错误"}`;
  }
  const route = [s(p.provider), s(p.model)].filter(Boolean).join("/");
  const usage =
    typeof p.inputTokens === "number"
      ? `用量 ${formatTokens(n(p.inputTokens))} 入 / ${formatTokens(n(p.outputTokens))} 出 · ${formatCost(n(p.costCny))}`
      : "用量未上报";
  return (
    `上下文已压缩：${route ? `${route} · ` : ""}摘要 ${n(p.summaryChars)} 字，` +
    `替换 ${n(p.shadowedNodes)} 条消息（约 ${formatTokens(n(p.shadowedTokenCount))} tokens）· ${usage}`
  );
}
