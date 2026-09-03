"use client";

/**
 * 监控台专用的小组件集合（只服务 /monitor/**，业务页面不复用）。
 *
 * 气质：深色控制台——zinc-950 底、zinc-800 描边、数值一律等宽 + tabular-nums，
 * 图表全部手写 SVG（不引图表库）。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

export type Tone = "zinc" | "sky" | "emerald" | "amber" | "red" | "violet";

const TONE_TEXT: Record<Tone, string> = {
  zinc: "text-zinc-300",
  sky: "text-sky-300",
  emerald: "text-emerald-300",
  amber: "text-amber-300",
  red: "text-red-300",
  violet: "text-violet-300",
};

const TONE_DOT: Record<Tone, string> = {
  zinc: "bg-zinc-500",
  sky: "bg-sky-400",
  emerald: "bg-emerald-400",
  amber: "bg-amber-400",
  red: "bg-red-400",
  violet: "bg-violet-400",
};

/** 图表配色（SVG fill/stroke 用字面色值，避免依赖 Tailwind 的 fill-* 编译） */
export const CHART_COLORS = {
  success: "#34d399",
  failed: "#f87171",
  cancelled: "#a1a1aa",
  tokens: "#38bdf8",
  grid: "#3f3f46",
  axis: "#71717a",
} as const;

/* --------------------------------- 原子 ---------------------------------- */

/** 状态点：pulse 表示「活的」 */
export function Dot({
  tone = "zinc",
  pulse = false,
  className = "",
}: {
  tone?: Tone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[tone]} ${
        pulse ? "animate-pulse" : ""
      } ${className}`}
    />
  );
}

/** 等宽数值：所有数字都走它，保证列对齐 */
export function Num({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono tabular-nums ${className}`}>{children}</span>;
}

/** 深色状态胶囊（业务页的 StatusBadge 是浅色系，在控制台里不用） */
const STATUS_CHIP: Record<string, { label: string; className: string }> = {
  running: { label: "运行中", className: "border-sky-500/40 bg-sky-500/10 text-sky-300" },
  success: {
    label: "成功",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  },
  failed: { label: "失败", className: "border-red-500/40 bg-red-500/10 text-red-300" },
  cancelled: {
    label: "已取消",
    className: "border-zinc-600 bg-zinc-800 text-zinc-400",
  },
  pending: { label: "等待中", className: "border-zinc-700 bg-zinc-900 text-zinc-500" },
  skipped: {
    label: "已跳过",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  },
};

export function StatusChip({ status }: { status: string }) {
  const s = STATUS_CHIP[status] ?? {
    label: status,
    className: "border-zinc-700 bg-zinc-900 text-zinc-400",
  };
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] leading-none font-medium ${s.className}`}
    >
      {s.label}
    </span>
  );
}

/** 值变化时轻微高亮 600ms（用 transition，不新增 keyframes） */
function useValueFlash(value: string): boolean {
  const previous = useRef(value);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), 600);
    return () => clearTimeout(timer);
  }, [value]);
  return flash;
}

/** 指标卡：大号等宽数值 + 副标题，数值变化时闪一下 */
export function MetricCard({
  label,
  value,
  unit,
  hint,
  tone = "zinc",
  loading = false,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: ReactNode;
  tone?: Tone;
  loading?: boolean;
}) {
  const flash = useValueFlash(value);
  return (
    <div
      data-testid="metric-card"
      data-label={label}
      className={`rounded-lg border border-zinc-800 px-4 py-3 transition-colors duration-500 ${
        flash ? "border-zinc-700 bg-zinc-800/70" : "bg-zinc-900/60"
      }`}
    >
      <div className="flex items-center gap-1.5 text-[11px] tracking-wide text-zinc-500">
        <Dot tone={tone} pulse={tone !== "zinc" && !loading} />
        {label}
      </div>
      <div data-testid="metric-value" className="mt-1.5 flex items-baseline gap-1">
        <Num
          className={`text-2xl leading-none font-semibold ${
            loading ? "text-zinc-700" : TONE_TEXT[tone]
          }`}
        >
          {loading ? "—" : value}
        </Num>
        {unit && !loading && <span className="text-xs text-zinc-500">{unit}</span>}
      </div>
      <div className="mt-1.5 h-4 text-[11px] text-zinc-500">{loading ? "" : hint}</div>
    </div>
  );
}

/** 深色面板 */
export function Panel({
  title,
  subtitle,
  right,
  children,
  bodyClassName = "px-4 py-4",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/60">
      <header className="flex items-center justify-between gap-4 border-b border-zinc-800 px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium text-zinc-200">{title}</h2>
          {subtitle && <p className="mt-0.5 truncate text-[11px] text-zinc-500">{subtitle}</p>}
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/** 空态：控制台里「没有数据」常常是正常状态，文案要说清楚 */
export function MonitorEmpty({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/30 px-6 py-12 text-center">
      <p className="text-sm text-zinc-400">{title}</p>
      {description && (
        <p className="mx-auto mt-1.5 max-w-md text-xs leading-5 text-zinc-500">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** 错误横幅（带重试） */
export function MonitorErrorBar({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
      <Dot tone="red" />
      <span className="min-w-0 flex-1 truncate">{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded border border-red-500/40 px-2 py-0.5 text-xs text-red-200 transition-colors hover:bg-red-500/20"
        >
          重试
        </button>
      )}
    </div>
  );
}

/** 连接状态指示：控制台右上角常驻 */
export function ConnectionBadge({
  state,
  lastMessageAt,
  onRetry,
}: {
  state: "connecting" | "open" | "reconnecting" | "closed";
  lastMessageAt?: number | null;
  onRetry?: () => void;
}) {
  const map = {
    connecting: { tone: "amber" as Tone, label: "连接中" },
    open: { tone: "emerald" as Tone, label: "实时" },
    reconnecting: { tone: "amber" as Tone, label: "重连中" },
    closed: { tone: "red" as Tone, label: "已断开" },
  };
  const view = map[state];
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-400">
      <Dot tone={view.tone} pulse={state === "open" || state === "connecting"} />
      {view.label}
      {state === "open" && lastMessageAt != null && (
        <Num className="text-zinc-600">
          {new Date(lastMessageAt).toLocaleTimeString("zh-CN", {
            hour12: false,
          })}
        </Num>
      )}
      {state === "closed" && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="ml-1 text-zinc-300 underline transition-colors hover:text-white"
        >
          重连
        </button>
      )}
    </span>
  );
}

/* --------------------------------- 图表 ---------------------------------- */

const VIEW_W = 720;
const VIEW_H = 190;
const PAD_L = 46;
const PAD_R = 10;
const PAD_T = 12;
const PAD_B = 24;
const PLOT_W = VIEW_W - PAD_L - PAD_R;
const PLOT_H = VIEW_H - PAD_T - PAD_B;

function niceAxis(max: number): number {
  if (max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * base;
    if (candidate >= max) return candidate;
  }
  return 10 * base;
}

function Grid({ max, formatValue }: { max: number; formatValue: (n: number) => string }) {
  return (
    <>
      {[0, 0.5, 1].map((frac) => {
        const y = PAD_T + PLOT_H * (1 - frac);
        return (
          <g key={frac}>
            <line
              x1={PAD_L}
              x2={VIEW_W - PAD_R}
              y1={y}
              y2={y}
              stroke={CHART_COLORS.grid}
              strokeWidth={1}
              strokeDasharray={frac === 0 ? undefined : "3 4"}
            />
            <text
              x={PAD_L - 8}
              y={y + 3.5}
              textAnchor="end"
              fontSize={10}
              fill={CHART_COLORS.axis}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            >
              {formatValue(max * frac)}
            </text>
          </g>
        );
      })}
    </>
  );
}

export interface SparkbarDatum {
  label: string;
  /** 与 colors 同序：堆叠自下而上 */
  values: number[];
  /** 悬停 tooltip 文本 */
  title?: string;
}

/** 手写 SVG 堆叠柱状图（近 24h 运行量：成功/失败/取消分色） */
export function Sparkbars({
  data,
  colors,
  formatValue = (n) => String(Math.round(n)),
  labelEvery = 4,
}: {
  data: SparkbarDatum[];
  colors: string[];
  formatValue?: (n: number) => string;
  labelEvery?: number;
}) {
  const totals = data.map((d) => d.values.reduce((a, b) => a + b, 0));
  const max = niceAxis(Math.max(0, ...totals));
  const slot = data.length > 0 ? PLOT_W / data.length : PLOT_W;
  const barW = Math.max(2, slot * 0.6);

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className="h-44 w-full"
      role="img"
      aria-label="近 24 小时运行量"
    >
      <Grid max={max} formatValue={formatValue} />
      {data.map((d, i) => {
        const x = PAD_L + slot * i + (slot - barW) / 2;
        let cursor = PAD_T + PLOT_H;
        const total = totals[i];
        return (
          <g key={d.label + String(i)}>
            <title>{d.title ?? `${d.label} · ${formatValue(total)}`}</title>
            {total === 0 ? (
              <rect
                x={x}
                y={PAD_T + PLOT_H - 1.5}
                width={barW}
                height={1.5}
                fill={CHART_COLORS.grid}
              />
            ) : (
              d.values.map((value, vi) => {
                if (value <= 0) return null;
                const h = (value / max) * PLOT_H;
                cursor -= h;
                return (
                  <rect
                    key={vi}
                    x={x}
                    y={cursor}
                    width={barW}
                    height={h}
                    fill={colors[vi] ?? CHART_COLORS.cancelled}
                  />
                );
              })
            )}
            {i % labelEvery === 0 && (
              <text
                x={x + barW / 2}
                y={VIEW_H - 8}
                textAnchor="middle"
                fontSize={10}
                fill={CHART_COLORS.axis}
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              >
                {d.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** 手写 SVG 折线图（近 24h token 消耗） */
export function Sparkline({
  data,
  color = CHART_COLORS.tokens,
  formatValue = (n) => String(Math.round(n)),
  labelEvery = 4,
  ariaLabel = "趋势",
}: {
  data: Array<{ label: string; value: number; title?: string }>;
  color?: string;
  formatValue?: (n: number) => string;
  labelEvery?: number;
  ariaLabel?: string;
}) {
  const max = niceAxis(Math.max(0, ...data.map((d) => d.value)));
  const slot = data.length > 0 ? PLOT_W / data.length : PLOT_W;
  const points = data.map((d, i) => {
    const x = PAD_L + slot * i + slot / 2;
    const y = PAD_T + PLOT_H * (1 - d.value / max);
    return { x, y, datum: d };
  });
  const line = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area =
    points.length > 0
      ? `M ${points[0].x.toFixed(1)} ${(PAD_T + PLOT_H).toFixed(1)} L ${line
          .split(" ")
          .join(" L ")} L ${points[points.length - 1].x.toFixed(1)} ${(PAD_T + PLOT_H).toFixed(
          1,
        )} Z`
      : "";

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className="h-44 w-full"
      role="img"
      aria-label={ariaLabel}
    >
      <Grid max={max} formatValue={formatValue} />
      {points.length > 1 && (
        <>
          <path d={area} fill={color} fillOpacity={0.12} />
          <polyline
            points={line}
            fill="none"
            stroke={color}
            strokeWidth={1.75}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </>
      )}
      {points.map((p, i) => (
        <g key={p.datum.label + String(i)}>
          <title>{p.datum.title ?? `${p.datum.label} · ${formatValue(p.datum.value)}`}</title>
          {p.datum.value > 0 && <circle cx={p.x} cy={p.y} r={2.2} fill={color} />}
          {/* 透明热区，方便悬停 */}
          <rect x={p.x - slot / 2} y={PAD_T} width={slot} height={PLOT_H} fill="transparent" />
          {i % labelEvery === 0 && (
            <text
              x={p.x}
              y={VIEW_H - 8}
              textAnchor="middle"
              fontSize={10}
              fill={CHART_COLORS.axis}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            >
              {p.datum.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

/** 图例 */
export function Legend({
  items,
}: {
  items: Array<{ color: string; label: string; value?: string }>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-400">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-[2px]"
            style={{ backgroundColor: item.color }}
          />
          {item.label}
          {item.value !== undefined && <Num className="text-zinc-300">{item.value}</Num>}
        </span>
      ))}
    </div>
  );
}
