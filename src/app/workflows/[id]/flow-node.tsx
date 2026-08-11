"use client";

/**
 * 画布唯一注册的自定义节点组件（Dify 模式：单一 nodeType，内部按 data.kind 分发）。
 * 运行状态视觉完全由 data._status 驱动（保存时剥离）。
 */
import { memo } from "react";
import { Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import { typeColor, type FlowNode, type RunNodeStatus } from "./types";

const STATUS_BORDER: Record<RunNodeStatus, string> = {
  pending: "border-zinc-300",
  running: "border-blue-500 ring-2 ring-blue-200 animate-pulse",
  success: "border-emerald-500",
  failed: "border-red-500",
  skipped: "border-zinc-200 opacity-40",
};

function handleStyle(objectTypeId: string, side: "left" | "right") {
  const style: React.CSSProperties = {
    width: 10,
    height: 10,
    background: typeColor(objectTypeId),
    border: "2px solid #fff",
    boxShadow: "0 0 0 1px rgb(0 0 0 / 0.2)",
  };
  if (side === "left") style.left = -5;
  else style.right = -5;
  return style;
}

export const FlowNodeView = memo(function FlowNodeView({
  id,
  data,
  selected,
}: NodeProps<FlowNode>) {
  const { deleteElements } = useReactFlow();

  const statusClass = data._status
    ? STATUS_BORDER[data._status]
    : "border-zinc-200";
  const selectedClass = selected ? " ring-2 ring-zinc-400" : "";

  const deleteButton = (
    <button
      type="button"
      title="删除节点"
      onClick={(e) => {
        e.stopPropagation();
        void deleteElements({ nodes: [{ id }] });
      }}
      className="absolute -right-2 -top-2 z-10 hidden h-5 w-5 items-center justify-center rounded-full bg-zinc-900 text-[11px] leading-none text-white hover:bg-red-600 group-hover:flex"
    >
      ×
    </button>
  );

  if (data.kind === "action") {
    return (
      <div
        className={`group relative w-60 rounded-lg border-2 bg-white shadow-sm ${statusClass}${selectedClass}`}
      >
        {deleteButton}
        <div className="rounded-t-md border-b border-zinc-200 bg-zinc-50 px-3 py-2">
          <span className="block truncate text-sm font-semibold text-zinc-900">
            {data.label}
          </span>
          <span className="block text-[10px] text-zinc-400">Action</span>
        </div>
        <div className="py-1.5">
          {data.inputs.map((p) => (
            <div
              key={p.name}
              className="relative flex items-center px-3 py-1"
            >
              <Handle
                type="target"
                position={Position.Left}
                id={p.name}
                style={handleStyle(p.objectTypeId, "left")}
              />
              <span className="truncate text-xs text-zinc-700">
                {p.name}
                <span className="text-zinc-400"> · {p.objectTypeName}</span>
              </span>
            </div>
          ))}
          {data.outputs.map((p) => (
            <div
              key={p.name}
              className="relative flex items-center justify-end px-3 py-1"
            >
              <span className="truncate text-xs text-zinc-700">
                {p.name}
                <span className="text-zinc-400"> · {p.objectTypeName}</span>
              </span>
              <Handle
                type="source"
                position={Position.Right}
                id={p.name}
                style={handleStyle(p.objectTypeId, "right")}
              />
            </div>
          ))}
          {data.inputs.length === 0 && data.outputs.length === 0 && (
            <p className="px-3 py-1 text-xs text-zinc-400">（无端口）</p>
          )}
        </div>
      </div>
    );
  }

  // 输入 / 输出内置节点：单 Handle，端口名固定 "value"
  const isInput = data.kind === "input";
  const port = isInput ? data.outputs[0] : data.inputs[0];
  return (
    <div
      className={`group relative w-44 rounded-lg border-2 bg-white shadow-sm ${statusClass}${selectedClass}`}
    >
      {deleteButton}
      <div className="relative px-3 py-2">
        {port && (
          <Handle
            type={isInput ? "source" : "target"}
            position={isInput ? Position.Right : Position.Left}
            id="value"
            style={handleStyle(port.objectTypeId, isInput ? "right" : "left")}
          />
        )}
        <span className="block text-[10px] text-zinc-400">
          {isInput ? "输入节点" : "输出节点"}
        </span>
        <span className="block truncate text-sm font-medium text-zinc-900">
          {port?.objectTypeName ?? "未知类型"}
        </span>
      </div>
    </div>
  );
});
