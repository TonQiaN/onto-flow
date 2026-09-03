"use client";

/**
 * 画布级 UI 状态的旁路通道（不进 node.data，避免每次交互都重建整份节点数组）。
 *
 * 放在这里的都是「所有节点都要看、但不该被持久化」的东西：
 * - connecting：正在拖的那根线的源端口信息，节点据此高亮可接端口、淡化不可接端口；
 * - issueNodeIds：服务端校验命中的节点，卡片描边成琥珀色；
 * - onEditAction：双击/右键「编辑 Action」的回调（ADR-0004）。
 */
import { createContext, useContext } from "react";

export interface ConnectingState {
  /** 起点所在节点 */
  nodeId: string;
  /** 起点端口名 */
  handleId: string;
  /** 起点是输出（source）还是输入（target） */
  handleType: "source" | "target";
  /** 起点端口的 Object Type，nominal 判等的唯一依据（ADR-0002） */
  objectTypeId: string;
  /** 已被占用的输入端口集合（`${nodeId}:${portName}`），一个输入口最多一条入线 */
  occupied: Set<string>;
}

export interface CanvasContextValue {
  connecting: ConnectingState | null;
  issueNodeIds: Set<string>;
  onEditAction: (nodeId: string) => void;
}

const EMPTY: CanvasContextValue = {
  connecting: null,
  issueNodeIds: new Set(),
  onEditAction: () => {},
};

const CanvasContext = createContext<CanvasContextValue>(EMPTY);

export const CanvasStateProvider = CanvasContext.Provider;

export function useCanvasState(): CanvasContextValue {
  return useContext(CanvasContext);
}

/**
 * 拖线过程中某个端口的可接状态：
 * - "ok"        同类型、方向相反、非同节点、输入口未被占用 → 高亮
 * - "blocked"   拖线进行中但接不上 → 淡化
 * - "idle"      没有在拖线 → 常态
 */
export function handleAffinity(
  connecting: ConnectingState | null,
  nodeId: string,
  portName: string,
  objectTypeId: string,
  side: "source" | "target",
): "ok" | "blocked" | "idle" {
  if (!connecting) return "idle";
  // 起点自己保持常态，别把用户正在拖的那个点也淡掉
  if (
    connecting.nodeId === nodeId &&
    connecting.handleId === portName &&
    connecting.handleType === side
  )
    return "idle";
  if (connecting.nodeId === nodeId) return "blocked";
  if (connecting.handleType === side) return "blocked";
  if (connecting.objectTypeId !== objectTypeId) return "blocked";
  if (side === "target" && connecting.occupied.has(`${nodeId}:${portName}`)) return "blocked";
  return "ok";
}
