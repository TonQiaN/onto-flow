/**
 * DeepSeek 官方 API 计价（人民币），把 usage 换算成费用，供落库时调用。
 *
 * 价目与时段抄自官方文档 https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * （2026-08-31 抄录）：高峰时段为北京时间周一至周五 9:00-12:00、14:00-18:00，
 * 其余时间（含周末全天）为空闲时段，空闲单价是高峰单价的一半。
 *
 * 口径约束（与上游适配器对齐，见 dsh-llm-deepseek 的 mapUsage）：
 * - inputTokens 是缓存未命中部分（prompt_tokens 减去命中），cacheReadTokens 是命中部分，
 *   两者不相交，各按各的单价计。
 * - outputTokens 直取 completion_tokens，**已含 reasoning**，因此 reasoning 不再单独计费。
 * - 缓存写入官方不计费。
 * - 未知 provider/model 返回 0：宁可少算也不虚构价目，用量汇总里的 0 就是「没有价目」的信号。
 */

/** 每百万 token 的高峰单价（元）；空闲价恒为一半，不单独建表。 */
interface PeakPricePerMillion {
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

const DEEPSEEK_PEAK_PRICES: Record<string, PeakPricePerMillion> = {
  "deepseek-v4-flash": { cacheHit: 0.1, cacheMiss: 3.0, output: 9.0 },
  "deepseek-v4-flash-vision-exp": { cacheHit: 0.1, cacheMiss: 3.0, output: 9.0 },
  "deepseek-v4-pro": { cacheHit: 0.3, cacheMiss: 9.0, output: 27.0 },
};

export interface BillableUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/** 官方高峰时段判定。中国无夏令时，北京时间恒为 UTC+8，直接偏移换算。 */
export function isPeakHours(at: Date): boolean {
  const beijing = new Date(at.getTime() + 8 * 3_600_000);
  const day = beijing.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = beijing.getUTCHours();
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/** 一条 usage 的人民币费用；按该条到达时刻决定峰谷。未知模型返回 0。 */
export function usageCostCny(
  providerId: string,
  modelId: string,
  usage: BillableUsage,
  at: Date,
): number {
  if (providerId !== "deepseek-official") return 0;
  const peak = DEEPSEEK_PEAK_PRICES[modelId];
  if (!peak) return 0;
  const factor = (isPeakHours(at) ? 1 : 0.5) / 1_000_000;
  return (
    (usage.cacheReadTokens * peak.cacheHit +
      usage.inputTokens * peak.cacheMiss +
      usage.outputTokens * peak.output) *
    factor
  );
}
