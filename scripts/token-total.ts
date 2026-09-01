/** DeepSeek output 已含 reasoning；验收脚本与产品统一只累计 input/output/cache。 */
export function totalUsageTokens(usage: {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheWriteTokens
  );
}
