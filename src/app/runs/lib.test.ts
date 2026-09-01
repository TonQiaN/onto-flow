import { describe, expect, it } from "vitest";
import { sumTokens, totalUsage } from "./lib";

describe("运行 token 汇总口径", () => {
  it("output 已含 reasoning，总量不重复加推理拆分", () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      cost: 0.12,
    };

    expect(sumTokens(usage)).toBe(37);
    expect(totalUsage([usage, usage])).toEqual({ tokens: 74, cost: 0.24 });
  });
});
