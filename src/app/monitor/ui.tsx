"use client";

/**
 * 系统健康页与它的清理面板共用的小组件（只服务 /monitor，业务页面不复用）。
 *
 * 气质与库页面一致的浅色工作台：白底 zinc 描边，数值一律等宽 + tabular-nums。
 * 监控台收口成一页后，这里只留这一页真正在用的原语——图表、状态胶囊、连接徽标
 * 随总览 / 实时会话 / 日志检索一起删掉了。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

export type Tone = "zinc" | "sky" | "emerald" | "amber" | "red";

const TONE_TEXT: Record<Tone, string> = {
  zinc: "text-zinc-800",
  sky: "text-sky-700",
  emerald: "text-emerald-700",
  amber: "text-amber-700",
  red: "text-red-700",
};

const TONE_DOT: Record<Tone, string> = {
  zinc: "bg-zinc-400",
  sky: "bg-sky-500",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
};

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
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: ReactNode;
  tone?: Tone;
}) {
  const flash = useValueFlash(value);
  return (
    <div
      data-testid="metric-card"
      data-label={label}
      className={`rounded-lg border px-4 py-3 transition-colors duration-500 ${
        flash ? "border-zinc-300 bg-zinc-100" : "border-zinc-200 bg-zinc-50"
      }`}
    >
      <div className="flex items-center gap-1.5 text-[11px] tracking-wide text-zinc-500">
        <Dot tone={tone} pulse={tone !== "zinc"} />
        {label}
      </div>
      <div data-testid="metric-value" className="mt-1.5 flex items-baseline gap-1">
        <Num className={`text-2xl leading-none font-semibold ${TONE_TEXT[tone]}`}>{value}</Num>
        {unit && <span className="text-xs text-zinc-500">{unit}</span>}
      </div>
      <div className="mt-1.5 h-4 text-[11px] text-zinc-500">{hint}</div>
    </div>
  );
}

/** 卡片外壳 */
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
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <header className="flex items-center justify-between gap-4 border-b border-zinc-200 bg-zinc-50 px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium text-zinc-800">{title}</h2>
          {subtitle && <p className="mt-0.5 truncate text-[11px] text-zinc-500">{subtitle}</p>}
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/** 错误横幅（带重试） */
export function MonitorErrorBar({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
      <Dot tone="red" />
      <span className="min-w-0 flex-1 truncate">{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded border border-red-200 px-2 py-0.5 text-xs text-red-700 transition-colors hover:bg-red-100"
        >
          重试
        </button>
      )}
    </div>
  );
}

/** 图例：色块由调用方给字面色值（SVG 的 fill 不走 Tailwind 编译） */
export function Legend({
  items,
}: {
  items: Array<{ color: string; label: string; value?: string }>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-600">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-[2px]"
            style={{ backgroundColor: item.color }}
          />
          {item.label}
          {item.value !== undefined && <Num className="text-zinc-700">{item.value}</Num>}
        </span>
      ))}
    </div>
  );
}
