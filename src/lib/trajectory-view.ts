/**
 * `GET /api/runs/[id]/nodes/[nodeId]/trajectory` 的展示 DTO——服务端投影与运行页
 * 抽屉共知的那份形状。
 *
 * 客户端不能从 `@/server` 取类型，所以这份契约放在两侧都能 import 的 `src/lib/`，
 * 而不是在运行页手抄一份；`src/lib/run-graph.ts` 是同款先例。
 *
 * 纯模块：不 import 任何东西，改这里就是改一份两侧共有的契约。
 */

/** 一条记录展开后的详情片段。 */
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

export type TrajectorySessionStatus =
  | "running"
  | "completed"
  | "error"
  | "aborted"
  | "blocked"
  | "max-tokens"
  | "interrupted"
  | "unknown";

export interface TrajectorySession {
  id: string;
  round: number;
  status: TrajectorySessionStatus;
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
