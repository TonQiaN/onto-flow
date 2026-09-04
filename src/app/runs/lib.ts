/**
 * 运行历史 UI 的共享类型与格式化工具。
 * 时间字段经 JSON 序列化后可能是 ISO 字符串或毫秒数，统一用 toMillis 归一。
 */
import type { RunGraph } from "@/lib/run-graph";
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
  /**
   * 受理来源：`workflow` 是画布通用入口，其余是调用入口的 source 名。
   * 服务端从 `imports.invocation.source` 读时推导，没有对应的列。
   */
  source: string;
  startedAt: string | number;
  finishedAt: string | number | null;
  totalTokens: number;
  totalCost: number;
  /** 节点总数与已收束数（success/failed/cancelled/skipped），驱动进度展示 */
  nodesTotal: number;
  nodesDone: number;
}

/** 画布通用入口的来源名；其余取值都是调用入口 */
export const WORKFLOW_RUN_SOURCE = "workflow";

/** 画布通用入口有中文名；调用入口按来源原值展示（`imports.invocation.source` 的读时投影），平台不替它们起名 */
export function sourceLabel(source: string): string {
  return source === WORKFLOW_RUN_SOURCE ? "画布发起" : source;
}

/** summary.byModel 的一行：同一组筛选下某条模型路由的用量 */
export interface RunSummaryByModel {
  providerId: string;
  modelId: string;
  tokens: number;
  cost: number;
}

/**
 * 当前筛选集（不分页）的用量汇总。runs 数的是筛选集里 distinct 的运行，
 * 零用量的运行也算，所以它等于信封的 total；token 与费用与每行同源，从 `run_nodes`
 * 求和（权威汇总），只有 byModel 走 `node_usage`。
 */
export interface RunSummary {
  runs: number;
  tokens: number;
  cost: number;
  byModel: RunSummaryByModel[];
}

/** GET /api/runs 的信封：库列表那套 { items, total, page, pageSize } 另带 summary */
export interface RunListEnvelope {
  items: RunListItem[];
  total: number;
  page: number;
  pageSize: number;
  summary: RunSummary;
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
  /** 受理时冻结的图（ADR-0018）；早于本列的运行是空图，走同一条渲染路径 */
  graph: RunGraph;
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

/**
 * run_nodes 行的**骨架**：节点的最新状态与累计用量。
 *
 * 没有 `inputs` / `outputs` / `snapshot`——那三列是最新一轮的副本，与轮次行上的同名列
 * 同一份内容，跟着每一帧 snapshot 下发等于把同一份大对象推两遍；抽屉又只认光标所在
 * 那一轮的值，按轮单取（`/api/runs/[id]/nodes/[nodeId]/rounds/[round]`）。
 */
export interface RunNodeRow extends NodeUsage {
  id: string;
  runId: string;
  nodeId: string;
  label: string;
  status: NodeStatus;
  sessionId?: string | null;
  error?: string | null;
  startedAt: string | number | null;
  finishedAt: string | number | null;
}

/**
 * run_node_rounds 一行的**骨架**：一个节点的一次执行（ADR-0018）。
 *
 * 回放只看它——`run_nodes` 一个节点只有一行，回边重入会覆盖那一行的起止、出口、产物与
 * 快照。输入 / 输出 / 被跳过的节点没有会话，起止同一时刻。
 * 这一轮的输入输出与快照不在这里：它们是重载荷，抽屉按轮单取（RunNodeRoundPayload）。
 */
export interface RunNodeRoundRow {
  id: string;
  runId: string;
  nodeId: string;
  /** 第几轮，0 起；重入把整个环体的轮次一起推进，轮次号按节点单调递增 */
  round: number;
  sessionId: string | null;
  status: "running" | "success" | "failed" | "cancelled" | "skipped";
  startedAt: string | number;
  finishedAt: string | number | null;
  /** 本轮走出的具名出口；无具名出口为 null */
  exitName: string | null;
  error: string | null;
}

/**
 * 一轮的重载荷：GET /api/runs/[id]/nodes/[nodeId]/rounds/[round]。
 * 抽屉的「输入输出」「快照」页签在打开或换轮时取一轮；被事件清理置空的列是 null，
 * 与「这一轮本就没有」同一形状。
 */
export interface RunNodeRoundPayload {
  inputs: Record<string, unknown> | null;
  outputs: Record<string, unknown> | null;
  snapshot: Record<string, unknown> | null;
}

/** run_events 表行（SSE event: log 的 data） */
export interface RunEventRow {
  id: number;
  runId: string;
  nodeId: string | null;
  /**
   * 事件所属的会话，据此把事件归到轮（第 0 轮是节点 id，之后是 `<节点id>#<轮次+1>`）。
   * 早于 ADR-0018 的历史行为 null。
   */
  sessionId?: string | null;
  ts: string | number;
  type: string;
  payload: Record<string, unknown> | null;
}

// 轨迹接口的展示 DTO 与服务端投影同源，放在 @/lib/trajectory-view；这里连带导出，
// 运行页抽屉仍从本模块取全部运行相关类型。
export type {
  AgentTrajectoryResponse,
  TrajectoryDetail,
  TrajectoryRecord,
  TrajectorySession,
  TrajectorySessionStatus,
  TrajectoryUsage,
} from "@/lib/trajectory-view";

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
