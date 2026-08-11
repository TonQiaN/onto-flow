/** run / run_node 状态徽章（含节点独有的 pending / skipped） */
const STYLES: Record<
  string,
  { label: string; badge: string; dot: string }
> = {
  running: {
    label: "运行中",
    badge: "border-blue-200 bg-blue-50 text-blue-700",
    dot: "animate-pulse bg-blue-500",
  },
  success: {
    label: "成功",
    badge: "border-emerald-200 bg-emerald-50 text-emerald-700",
    dot: "bg-emerald-500",
  },
  failed: {
    label: "失败",
    badge: "border-red-200 bg-red-50 text-red-700",
    dot: "bg-red-500",
  },
  pending: {
    label: "等待中",
    badge: "border-zinc-200 bg-zinc-50 text-zinc-500",
    dot: "bg-zinc-300",
  },
  skipped: {
    label: "已跳过",
    badge: "border-amber-200 bg-amber-50 text-amber-700",
    dot: "bg-amber-400",
  },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STYLES[status] ?? {
    label: status,
    badge: "border-zinc-200 bg-zinc-50 text-zinc-500",
    dot: "bg-zinc-300",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${s.badge}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

/** 时间线节点圆点配色 */
export const STATUS_DOT: Record<string, string> = {
  running: "animate-pulse bg-blue-500",
  success: "bg-emerald-500",
  failed: "bg-red-500",
  pending: "bg-zinc-300",
  skipped: "bg-amber-400",
};
