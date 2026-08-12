"use client";

/**
 * 画布唯一注册的自定义节点组件（Dify 模式：单一 nodeType，内部按 data.kind 分发）。
 *
 * 信息层级（自上而下逐级弱化）：
 *   ① 标题行：Action 名 / 输入·输出角色
 *   ② 副信息：模型 · 思考强度（Action）或 对象类型形态（输入输出节点）
 *   ③ 端口行：类型色点 + 端口名，hover 才显示对象类型全名
 *
 * 运行态视觉（模块 C）：
 * - 状态源是 RunVisualsContext（use-run-visuals.ts）；无 Provider 时降级读 data._status。
 * - 五态描边见 STATUS_STYLE；执行中额外挂 .ff-node-running 呼吸 + 顶部细进度条，
 *   running → success 的瞬间挂一次 .ff-node-pulse。
 * - 卡片底部常驻运行信息条：执行中是秒级计时 + 最近活动摘要，
 *   结束后是耗时 + token + 费用（失败再补一行错误摘要）。
 */
import { memo, useEffect, useRef, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  EFFORT_LABEL,
  KIND_LABEL,
  typeColor,
  type FlowNode,
  type PortSnapshot,
  type RunNodeStatus,
} from "./types";
import { handleAffinity, useCanvasState } from "./canvas-state";
import {
  activitySummary,
  formatCost,
  formatDuration,
  formatTokens,
  useRunVisualsContext,
  type NodeActivity,
  type NodeVisual,
} from "./use-run-visuals";

/**
 * 五态（+pending）视觉。动画类由 globals.css（模块 B）提供，这里只挂类名。
 * 语义：未执行淡灰半透明 / 执行中蓝 / 已完成绿 / 失败红 /
 *       跳过灰虚线更淡（没轮到它） / 已取消琥珀虚线（人为中止，不是出错）。
 */
const STATUS_STYLE: Record<RunNodeStatus, string> = {
  pending: "border-zinc-300 opacity-60",
  running: "border-blue-500 ff-node-running",
  success: "border-emerald-500",
  failed: "border-red-500",
  skipped: "border-dashed border-zinc-300 opacity-35",
  cancelled: "border-dashed border-amber-500 opacity-75",
};

const STATUS_TEXT: Record<RunNodeStatus, string> = {
  pending: "待执行",
  running: "执行中",
  success: "成功",
  failed: "失败",
  skipped: "已跳过",
  cancelled: "已取消",
};

const STATUS_DOT: Record<RunNodeStatus, string> = {
  pending: "bg-zinc-300",
  running: "bg-blue-500",
  success: "bg-emerald-500",
  failed: "bg-red-500",
  skipped: "bg-zinc-300",
  cancelled: "bg-amber-500",
};

function handleStyle(
  objectTypeId: string,
  side: "left" | "right",
): React.CSSProperties {
  const style: React.CSSProperties = {
    width: 11,
    height: 11,
    background: typeColor(objectTypeId),
    border: "2px solid #fff",
    boxShadow: "0 0 0 1px rgb(0 0 0 / 0.2)",
    zIndex: 2,
  };
  if (side === "left") style.left = -6;
  else style.right = -6;
  return style;
}

/** running → success 的那一刻返回 true 一小段时间，驱动 .ff-node-pulse 播放一遍 */
function useCompletionPulse(status: RunNodeStatus | undefined): boolean {
  const [pulsing, setPulsing] = useState(false);
  const prevRef = useRef<RunNodeStatus | undefined>(undefined);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = status;
    if (prev !== "running" || status !== "success") return;
    setPulsing(true);
    // 略长于 ff-node-pop 的 0.7s，确保动画播完再摘类名
    const timer = setTimeout(() => setPulsing(false), 800);
    return () => clearTimeout(timer);
  }, [status]);

  return pulsing;
}

/** 执行中的顶部细进度条：不确定进度，纯 CSS 呼吸（Tailwind animate-pulse） */
function TopProgress() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[3px] overflow-hidden rounded-t-[10px] bg-blue-100">
      <div className="h-full w-full animate-pulse bg-blue-500" />
    </div>
  );
}

/** 卡片底部的运行信息条：执行中实时，结束后固化 */
function RunFooter({
  status,
  visual,
  activity,
  now,
}: {
  status: RunNodeStatus;
  visual: NodeVisual | undefined;
  activity: NodeActivity | undefined;
  now: number;
}) {
  if (status === "pending") {
    return (
      <div className="rounded-b-[10px] border-t border-zinc-100 bg-zinc-50/60 px-3 py-1 text-[10px] text-zinc-400">
        等待执行
      </div>
    );
  }

  if (status === "running") {
    const startedAt = visual?.startedAt ?? null;
    const elapsed = startedAt == null ? 0 : Math.max(0, now - startedAt);
    return (
      <div className="rounded-b-[10px] border-t border-blue-100 bg-blue-50/70 px-3 py-1">
        <div className="flex items-center gap-1.5 text-[10px] font-medium tabular-nums text-blue-700">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-blue-500" />
          {formatDuration(elapsed)}
        </div>
        <p className="mt-0.5 truncate text-[10px] leading-4 text-blue-600/90">
          {activitySummary(activity) ?? "会话已启动，等待首个输出…"}
        </p>
      </div>
    );
  }

  if (status === "skipped") {
    return (
      <div className="rounded-b-[10px] border-t border-zinc-100 bg-zinc-50/60 px-3 py-1 text-[10px] text-zinc-400">
        已跳过（上游未产出）
      </div>
    );
  }

  if (status === "cancelled") {
    return (
      <div className="rounded-b-[10px] border-t border-amber-100 bg-amber-50/70 px-3 py-1 text-[10px] tabular-nums text-amber-700">
        已取消
        {visual?.durationMs != null && <> · {formatDuration(visual.durationMs)}</>}
      </div>
    );
  }

  // success / failed：耗时 + token + 费用固化在卡片上
  const failed = status === "failed";
  return (
    <div
      className={`rounded-b-[10px] border-t px-3 py-1 ${
        failed
          ? "border-red-100 bg-red-50/70"
          : "border-emerald-100 bg-emerald-50/60"
      }`}
    >
      <div
        className={`flex flex-wrap items-center gap-x-1.5 text-[10px] tabular-nums ${
          failed ? "text-red-700" : "text-emerald-700"
        }`}
      >
        <span>
          {visual?.durationMs != null ? formatDuration(visual.durationMs) : "—"}
        </span>
        {visual && visual.totalTokens > 0 && (
          <>
            <span className="opacity-40">·</span>
            <span>{formatTokens(visual.totalTokens)} tokens</span>
            <span className="opacity-40">·</span>
            <span>{formatCost(visual.cost)}</span>
          </>
        )}
      </div>
      {failed && visual?.error && (
        <p
          className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-red-600"
          title={visual.error}
        >
          {visual.error}
        </p>
      )}
    </div>
  );
}

/** 端口行：色点 handle + 端口名，hover 浮出对象类型全名 */
function PortRow({
  nodeId,
  port,
  side,
}: {
  nodeId: string;
  port: PortSnapshot;
  side: "source" | "target";
}) {
  const { connecting } = useCanvasState();
  const [hover, setHover] = useState(false);
  const isOut = side === "source";
  const affinity = handleAffinity(
    connecting,
    nodeId,
    port.name,
    port.objectTypeId,
    side,
  );

  const handleClass =
    affinity === "ok"
      ? "ff-handle-ok"
      : affinity === "blocked"
        ? "ff-handle-dim"
        : "";

  return (
    <div
      className={`relative flex items-center gap-1.5 px-3 py-1 transition-opacity ${
        isOut ? "justify-end" : ""
      } ${affinity === "blocked" ? "opacity-35" : ""}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Handle
        type={isOut ? "source" : "target"}
        position={isOut ? Position.Right : Position.Left}
        id={port.name}
        className={handleClass}
        style={handleStyle(port.objectTypeId, isOut ? "right" : "left")}
      />
      {!isOut && (
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: typeColor(port.objectTypeId) }}
        />
      )}
      <span className="truncate text-xs text-zinc-700">{port.name}</span>
      {isOut && (
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: typeColor(port.objectTypeId) }}
        />
      )}

      {/* hover 才露出对象类型全名，常态下不占版面 */}
      {hover && (
        <span
          className={`ff-fade-in pointer-events-none absolute top-1/2 z-20 -translate-y-1/2 whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[10px] leading-none text-white shadow-lg ${
            isOut ? "left-full ml-3" : "right-full mr-3"
          }`}
        >
          {port.objectTypeName}
          <span className="ml-1 text-zinc-400">{KIND_LABEL[port.kind]}</span>
        </span>
      )}
    </div>
  );
}

export const FlowNodeView = memo(function FlowNodeView({
  id,
  data,
  selected,
}: NodeProps<FlowNode>) {
  const { issueNodeIds, onEditAction } = useCanvasState();
  const visuals = useRunVisualsContext();

  const visual = visuals?.nodes[id];
  // Context 优先；没挂 RunVisualsProvider 时降级读 data._status（只有状态、没有用量）
  const status: RunNodeStatus | undefined = visual?.status ?? data._status;
  const activity = visuals?.activityByNode[id];
  const pulsing = useCompletionPulse(status);
  const meta = data._meta;
  const hasIssue = issueNodeIds.has(id);

  const frame = [
    "group relative rounded-xl border-2 bg-white shadow-sm transition-shadow",
    status ? STATUS_STYLE[status] : hasIssue ? "border-amber-400" : "border-zinc-200",
    pulsing ? "ff-node-pulse" : "",
    // 注意：ring 与 .ff-node-running/.ff-node-pulse 都走 box-shadow，
    // 执行中/完成脉冲期间动画会盖掉 ring，这是刻意的——同一时刻只保留一种强调。
    selected ? "ring-2 ring-zinc-900/60 ring-offset-1" : "",
    "hover:shadow-md",
  ].join(" ");

  const runFooter = status ? (
    <RunFooter
      status={status}
      visual={visual}
      activity={activity}
      now={visuals?.now ?? Date.now()}
    />
  ) : null;

  const statusBadge = status ? (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-white/80 px-1.5 py-0.5 text-[10px] text-zinc-500">
      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />
      {STATUS_TEXT[status]}
    </span>
  ) : null;

  if (data.kind === "action") {
    return (
      <div className={`${frame} w-64`}>
        {status === "running" && <TopProgress />}
        {/* 标题区 */}
        <div className="rounded-t-[10px] border-b border-zinc-200 bg-gradient-to-b from-zinc-50 to-white px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[9px] font-medium leading-none text-white">
              ACTION
            </span>
            {meta?.missing && (
              <span className="rounded bg-red-100 px-1.5 py-0.5 text-[9px] leading-none text-red-700">
                已删除
              </span>
            )}
            <span className="ml-auto flex items-center gap-1">
              {statusBadge}
              <button
                type="button"
                title="编辑这个 Action（双击节点同效）"
                onClick={(e) => {
                  e.stopPropagation();
                  onEditAction(id);
                }}
                className="hidden rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 group-hover:block"
              >
                编辑
              </button>
            </span>
          </div>
          <span
            className="mt-1 block truncate text-sm font-semibold text-zinc-900"
            title={data.label}
          >
            {data.label}
          </span>
          <span className="mt-0.5 block truncate text-[10px] text-zinc-400">
            {meta
              ? `${meta.modelName} · 思考 ${EFFORT_LABEL[meta.effort]}`
              : "　"}
          </span>
        </div>

        {/* 端口区 */}
        <div className="py-1.5">
          {data.inputs.map((p) => (
            <PortRow key={`in:${p.name}`} nodeId={id} port={p} side="target" />
          ))}
          {data.inputs.length > 0 && data.outputs.length > 0 && (
            <div className="mx-3 my-1 border-t border-dashed border-zinc-100" />
          )}
          {data.outputs.map((p) => (
            <PortRow key={`out:${p.name}`} nodeId={id} port={p} side="source" />
          ))}
          {data.inputs.length === 0 && data.outputs.length === 0 && (
            <p className="px-3 py-1 text-xs text-zinc-400">（无端口）</p>
          )}
        </div>

        {/* 引用提示：共享 Action 的波及面（ADR-0004） */}
        {meta && meta.refCount > 1 && (
          <div
            className={`border-t border-zinc-100 bg-zinc-50 px-3 py-1 text-[10px] text-zinc-400 ${
              runFooter ? "" : "rounded-b-[10px]"
            }`}
          >
            共享给 {meta.refCount} 处，改动同时生效
          </div>
        )}
        {runFooter}
      </div>
    );
  }

  // 输入 / 输出内置节点：单 Handle，端口名固定 "value"
  const isInput = data.kind === "input";
  const port = isInput ? data.outputs[0] : data.inputs[0];
  return (
    <div className={`${frame} w-48`}>
      {status === "running" && <TopProgress />}
      <div className="flex items-center gap-2 rounded-t-[10px] border-b border-zinc-200 bg-gradient-to-b from-zinc-50 to-white px-3 py-1.5">
        <span
          className={`rounded px-1.5 py-0.5 text-[9px] font-medium leading-none ${
            isInput
              ? "bg-sky-100 text-sky-700"
              : "bg-emerald-100 text-emerald-700"
          }`}
        >
          {isInput ? "输入" : "输出"}
        </span>
        <span className="ml-auto">{statusBadge}</span>
      </div>
      <div className="py-1.5">
        {port ? (
          <PortRow
            nodeId={id}
            port={port}
            side={isInput ? "source" : "target"}
          />
        ) : (
          <p className="px-3 py-1 text-xs text-zinc-400">（未绑定类型）</p>
        )}
        <p className="px-3 pb-0.5 pt-0.5 text-[10px] text-zinc-400">
          {port ? `${port.objectTypeName} · ${KIND_LABEL[port.kind]}` : "—"}
        </p>
      </div>
      {runFooter}
    </div>
  );
});
