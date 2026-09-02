import { RESUME_MATCH_VALIDATOR_TOOL_SHA256 } from "@/lib/resume-match";
import { toolContractSha256, type ToolContractDigestInput } from "@/lib/tool-digest";

export function resumeMatchValidatorToolDigest(contract: ToolContractDigestInput): string {
  return toolContractSha256(contract);
}

/**
 * 展示名与关联都可在网页保留不变地改写；只有契约摘要（公名、描述、参数与输出 schema、
 * 超时、execute 源码）匹配内置 pin 才是权威校验器（ADR-0017：钉契约，不钉包装）。
 */
export function isAuthoritativeResumeMatchValidatorTool(
  contract: ToolContractDigestInput,
): boolean {
  return resumeMatchValidatorToolDigest(contract) === RESUME_MATCH_VALIDATOR_TOOL_SHA256;
}
