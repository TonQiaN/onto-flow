import { describe, expect, it } from "vitest";
import { isPeakHours, usageCostCny } from "./pricing";

// 北京时间（UTC+8）某时刻的 UTC Date。
function beijing(iso: string): Date {
  return new Date(new Date(`${iso}+08:00`).getTime());
}

describe("isPeakHours", () => {
  it("工作日 9:00-12:00 与 14:00-18:00 是高峰，边界取左闭右开", () => {
    expect(isPeakHours(beijing("2026-08-31T09:00:00"))).toBe(true); // 周一 9:00
    expect(isPeakHours(beijing("2026-08-31T08:59:59"))).toBe(false);
    expect(isPeakHours(beijing("2026-08-31T11:59:59"))).toBe(true);
    expect(isPeakHours(beijing("2026-08-31T12:00:00"))).toBe(false); // 午间空闲
    expect(isPeakHours(beijing("2026-08-31T14:00:00"))).toBe(true);
    expect(isPeakHours(beijing("2026-08-31T17:59:59"))).toBe(true);
    expect(isPeakHours(beijing("2026-08-31T18:00:00"))).toBe(false);
  });

  it("周末全天空闲", () => {
    expect(isPeakHours(beijing("2026-08-30T10:00:00"))).toBe(false); // 周日
    expect(isPeakHours(beijing("2026-09-05T15:00:00"))).toBe(false); // 周六
  });
});

describe("usageCostCny", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 };

  it("flash 高峰价：未命中 3 元 + 命中 0.1 元 + 输出 9 元", () => {
    expect(
      usageCostCny("deepseek-official", "deepseek-v4-flash", usage, beijing("2026-08-31T10:00:00")),
    ).toBeCloseTo(12.1, 6);
  });

  it("空闲时段半价，vision-exp 与 flash 同价", () => {
    expect(
      usageCostCny(
        "deepseek-official",
        "deepseek-v4-flash-vision-exp",
        usage,
        beijing("2026-08-31T13:00:00"),
      ),
    ).toBeCloseTo(6.05, 6);
  });

  it("pro 是 flash 的三倍价", () => {
    expect(
      usageCostCny("deepseek-official", "deepseek-v4-pro", usage, beijing("2026-08-31T10:00:00")),
    ).toBeCloseTo(36.3, 6);
  });

  it("未知模型或未知 provider 返回 0，不虚构价目", () => {
    const at = beijing("2026-08-31T10:00:00");
    expect(usageCostCny("deepseek-official", "deepseek-v9", usage, at)).toBe(0);
    expect(usageCostCny("other-provider", "deepseek-v4-flash", usage, at)).toBe(0);
  });
});
