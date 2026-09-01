import { createHash } from "node:crypto";
import { RESUME_MATCH_VALIDATOR_TOOL_SHA256 } from "@/lib/resume-match";

export function resumeMatchValidatorToolDigest(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** 名称与关联都可在网页保留不变地改写；只有源码摘要匹配内置 pin 才是权威校验器。 */
export function isAuthoritativeResumeMatchValidatorTool(code: string): boolean {
  return resumeMatchValidatorToolDigest(code) === RESUME_MATCH_VALIDATOR_TOOL_SHA256;
}
