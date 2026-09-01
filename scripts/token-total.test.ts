import { describe, expect, it } from "vitest";
import { totalUsageTokens } from "./token-total";

describe("付费验收脚本 token 口径", () => {
  it("累计两类缓存且不重复累计 reasoning", () => {
    expect(
      totalUsageTokens({
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 99,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
      }),
    ).toBe(37);
  });
});
