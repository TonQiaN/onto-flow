"use client";

/**
 * 画布唯一注册的自定义边（模块 C）。三态渲染，状态来自 RunVisualsContext：
 *
 * | 条件                                        | 表现                       |
 * |---------------------------------------------|----------------------------|
 * | 上游 success 且下游 running（正在供数）      | 蓝色 .ff-edge-flow 流动虚线 |
 * | 上游 success（数据已流过）                    | 绿色实线                    |
 * | 其余（含未运行）                              | 淡灰实线                    |
 *
 * 流动动画完全由 CSS 类 `.ff-edge-flow` 提供（globals.css 归模块 B，含 stroke-dasharray），
 * 这里不写任何内联 dasharray，免得覆盖掉那边的虚线节奏。
 *
 * 没有运行时（Context 为空）完全不写内联描边，把配色让回 globals.css 的
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
import { sourceExitName, type FlowNode } from "./types";
import { useRunVisualsContext } from "./use-run-visuals";

export type EdgeFlowState = "idle" | "flowing" | "flowed" | "blocked";

const STROKE: Record<EdgeFlowState, string> = {
  idle: "#d4d4d8", // zinc-300
  flowing: "#3b82f6", // blue-500
  flowed: "#10b981", // emerald-500
  blocked: "#e4e4e7", // zinc-200（下游被跳过/取消，这条线不再有意义）
};

const LABEL_COLOR = {
  text: "#3f3f46",
  background: "#ffffff",
  border: "#d4d4d8",
};

export const FlowEdgeView = memo(function FlowEdgeView({
  id,
  source,
  target,
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
  const visuals = useRunVisualsContext();
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

  const hasRun = Boolean(visuals?.runId);
  let state: EdgeFlowState = "idle";
  if (hasRun && visuals) {
    const upstream = visuals.statusByNode[source];
    const downstream = visuals.statusByNode[target];
    if (upstream === "success") {
      if (downstream === "running") state = "flowing";
      else if (downstream === "skipped" || downstream === "cancelled")
        state = "blocked";
      else state = "flowed";
    }
  }

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
        className={hasRun && flowing ? "ff-edge-flow" : undefined}
        style={
          hasRun
            ? {
                stroke: selected ? "#18181b" : STROKE[state],
                strokeWidth: selected
                  ? 2.5
                  : flowing
                    ? 2.5
                    : state === "flowed"
                      ? 2
                      : 1.75,
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
            className="pointer-events-none absolute z-10 max-w-40 select-none whitespace-normal break-words rounded-lg border px-2 py-0.5 text-center text-[10px] font-semibold leading-4 shadow-sm"
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
