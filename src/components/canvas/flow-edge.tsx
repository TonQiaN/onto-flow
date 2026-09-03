"use client";

/**
 * 画布唯一注册的自定义边。编辑器与运行页共用；四态渲染，状态来自 CanvasVisualsContext
 * （运行页由 visualsAt(t) 推出，编辑器没有 Provider）：
 *
 * | state   | 含义                                   | 表现                |
 * |---------|----------------------------------------|---------------------|
 * | flowing | 上游该轮已成功、下游正在跑（正在供数） | 蓝色 .ff-edge-flow  |
 * | flowed  | 数据已流过                             | 绿色实线            |
 * | blocked | 上游收束但这条出口没走 / 上游没成功    | 淡灰细线            |
 * | idle    | 还没轮到                               | 淡灰实线            |
 *
 * 流动动画完全由 CSS 类 `.ff-edge-flow` 提供（globals.css，含 stroke-dasharray），
 * 这里不写任何内联 dasharray，免得覆盖掉那边的虚线节奏。
 *
 * 没有运行视觉时完全不写内联描边，把配色让回 globals.css 的
 * `.react-flow__edge-path` 与 hover/selected 规则——内联样式会盖掉它们。
 */
import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useNodesData,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { sourceExitName, type FlowNode } from "./node-model";
import { useCanvasVisuals, type EdgeFlowState } from "./node-visuals";

const STROKE: Record<EdgeFlowState, string> = {
  idle: "#d4d4d8", // zinc-300
  flowing: "#3b82f6", // blue-500
  flowed: "#10b981", // emerald-500
  blocked: "#e4e4e7", // zinc-200（这条出口没走，线不再有意义）
};

const LABEL_COLOR = {
  text: "#3f3f46",
  background: "#ffffff",
  border: "#d4d4d8",
};

export const FlowEdgeView = memo(function FlowEdgeView({
  id,
  source,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  sourceHandleId,
  selected,
}: EdgeProps<Edge>) {
  const visuals = useCanvasVisuals();
  const sourceNode = useNodesData<FlowNode>(source);
  const exitName = sourceExitName(sourceNode?.data, sourceHandleId);
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const state: EdgeFlowState | null = visuals ? (visuals.edges[id]?.state ?? "idle") : null;
  const flowing = state === "flowing";
  const labelColor = selected
    ? { text: "#18181b", background: "#ffffff", border: "#18181b" }
    : LABEL_COLOR;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className={flowing ? "ff-edge-flow" : undefined}
        style={
          state
            ? {
                stroke: selected ? "#18181b" : STROKE[state],
                strokeWidth: selected ? 2.5 : flowing ? 2.5 : state === "flowed" ? 2 : 1.75,
                strokeOpacity: state === "blocked" ? 0.5 : 1,
                transition: "stroke 200ms ease, stroke-width 200ms ease",
              }
            : undefined
        }
      />
      {exitName && (
        <EdgeLabelRenderer>
          <div
            data-testid={`workflow-edge-exit-${id}`}
            role="note"
            aria-label={`出口：${exitName}`}
            className="pointer-events-none absolute z-10 max-w-40 rounded-lg border px-2 py-0.5 text-center text-[10px] leading-4 font-semibold break-words whitespace-normal shadow-sm select-none"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              color: labelColor.text,
              background: labelColor.background,
              borderColor: labelColor.border,
            }}
          >
            {exitName}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
