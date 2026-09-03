/**
 * 画布节点的共享模型：端口快照、类型配色与出口归属。
 * 编辑器（src/app/workflows/[id]/）与运行页（src/app/runs/[id]/）画的是同一套节点，
 * 这里只放两边都要的东西；Action / Object Type / 工作流这些实体形状留在编辑器的 types.ts。
 */
import type { Node } from "@xyflow/react";

export type PortKind = "text" | "file" | "json";
export type ReasoningEffort = "off" | "low" | "high" | "max";
export type RunNodeStatus = "pending" | "running" | "success" | "failed" | "skipped" | "cancelled";

export const KIND_LABEL: Record<PortKind, string> = {
  text: "文本",
  file: "文件",
  json: "JSON",
};

export const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  off: "关闭",
  low: "低",
  high: "高",
  max: "最大",
};

export interface PortSnapshot {
  name: string;
  objectTypeId: string;
  objectTypeName: string;
  kind: PortKind;
  /** 输出端口所属的具名出口；输入端口与普通输出端口为 null */
  exitName: string | null;
}

/** 节点卡片上的只读展示信息，不参与持久化（`_` 前缀，toNodeDto 天然剥离） */
export interface NodeMeta {
  description: string;
  modelName: string;
  effort: ReasoningEffort;
  refCount: number;
  /** Action 已被删除 / 引用失效 */
  missing?: boolean;
}

/**
 * node.data 只放展示与引用数据（Dify 模式）：
 * 持久化字段走 toNodeDto 白名单；`_` 前缀为瞬态字段，保存时天然剥离。
 */
export type FlowNodeData = {
  kind: "action" | "input" | "output";
  actionId: string | null;
  objectTypeId: string | null;
  label: string;
  inputs: PortSnapshot[];
  outputs: PortSnapshot[];
  /** 瞬态：卡片副信息（模型、思考强度、引用数…） */
  _meta?: NodeMeta;
};

export type FlowNode = Node<FlowNodeData, "flowNode">;

const PALETTE = [
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#6366f1",
  "#84cc16",
  "#e11d48",
  "#0ea5e9",
  "#a855f7",
];

/** objectTypeId 稳定哈希取色：同类型同色（ComfyUI 风端口配色） */
export function typeColor(objectTypeId: string): string {
  let h = 0;
  for (let i = 0; i < objectTypeId.length; i++) {
    h = (h * 31 + objectTypeId.charCodeAt(i)) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
}

/** 连线展示的情况名来自源端口所属出口，连线本身不保存条件（ADR-0009）。 */
export function sourceExitName(
  sourceData: FlowNodeData | undefined,
  sourceHandleId: string | null | undefined,
): string | null {
  const sourcePort = sourceData?.outputs.find((port) => port.name === (sourceHandleId ?? "value"));
  return sourcePort?.exitName ?? null;
}
