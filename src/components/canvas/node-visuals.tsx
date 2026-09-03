"use client";

/**
 * 画布的运行视觉通道：节点与连线在**某一时刻**长什么样。
 *
 * 值由运行页的纯函数 visualsAt(t) 推出（src/app/runs/[id]/visuals-at.ts），
 * 经这个 Context 下发给 flow-node / flow-edge；编辑器不提供 Provider，
 * 于是同一套组件在编辑器里就是静态画布（ADR-0018：看运行只有 /runs/<id> 一个地方）。
 */
import { createContext, useContext, type ReactNode } from "react";
import type { RunNodeStatus } from "./node-model";

export type ActivityKind = "tool" | "text" | "reasoning" | "idle" | "error";

/** 光标所在轮里、截至光标时刻的会话活动（来自带 session_id 的 run_events） */
export interface NodeActivity {
  /** 累计输出字数（type=text 的 payload.text 长度合计） */
  chars: number;
  /** 累计思考字数（type=reasoning 的 payload.text 长度合计） */
  reasoningChars: number;
  /** 最近一次工具调用的名字与状态（type=tool） */
  tool: string | null;
  toolStatus: string | null;
  lastKind: ActivityKind | null;
  updatedAt: number;
}

/** 节点在光标时刻的视觉数据 */
export interface CanvasNodeVisual {
  status: RunNodeStatus;
  /** 光标落在第几轮（0 起）；节点还没有任何轮次行时为 null */
  round: number | null;
  /** 该轮起止；该轮尚未结束时 finishedAt 为 null */
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  activity: NodeActivity | null;
  /** 节点全轮累计用量（run_nodes），只在节点整体已收束时给出，否则为 null */
  tokens: number | null;
  cost: number | null;
}

/**
 * 连线在光标时刻的状态：
 * flowing 上游该轮已成功且下游正在跑 / flowed 数据已流过 /
 * blocked 上游收束但这条出口没走（或上游没成功）/ idle 还没轮到。
 */
export type EdgeFlowState = "idle" | "flowing" | "flowed" | "blocked";

export interface CanvasEdgeVisual {
  state: EdgeFlowState;
}

export interface CanvasVisuals {
  /** 光标时刻（毫秒）：节点上的秒表按它走，不读 Date.now() */
  t: number;
  nodes: Record<string, CanvasNodeVisual>;
  edges: Record<string, CanvasEdgeVisual>;
}

const CanvasVisualsContext = createContext<CanvasVisuals | null>(null);

export function CanvasVisualsProvider({
  value,
  children,
}: {
  value: CanvasVisuals | null;
  children: ReactNode;
}) {
  return <CanvasVisualsContext.Provider value={value}>{children}</CanvasVisualsContext.Provider>;
}

/** 没有运行视觉（编辑器）时返回 null，节点与连线按静态样式画 */
export function useCanvasVisuals(): CanvasVisuals | null {
  return useContext(CanvasVisualsContext);
}

/** 节点卡片内联的「最近活动」摘要文案 */
export function activitySummary(activity: NodeActivity | null | undefined): string | null {
  if (!activity || activity.lastKind === null) return null;
  if (activity.lastKind === "tool" && activity.tool) {
    if (activity.toolStatus === "completed") return `工具 ${activity.tool} 已完成`;
    if (activity.toolStatus === "error") return `工具 ${activity.tool} 出错`;
    return `正在调用工具 ${activity.tool}`;
  }
  if (activity.lastKind === "error") return "会话报错，处理中…";
  if (activity.lastKind === "idle") return "本轮已收尾";
  if (activity.lastKind === "reasoning") {
    return `思考中…（已思考 ${activity.reasoningChars} 字）`;
  }
  if (activity.chars > 0) return `已输出 ${activity.chars} 字`;
  return "思考中…";
}
