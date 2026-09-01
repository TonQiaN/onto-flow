import { describe, expect, it } from "vitest";
import {
  isAuthoritativeResumeMatchValidatorTool,
  resumeMatchValidatorToolDigest,
} from "./resume-match-validator-integrity";

describe("简历校验 Tool 源码摘要", () => {
  it("使用稳定 SHA-256，并拒绝任意替换实现", () => {
    expect(resumeMatchValidatorToolDigest("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      isAuthoritativeResumeMatchValidatorTool(
        'export const name = "validate_resume_match_result"; export const valid = true;',
      ),
    ).toBe(false);
  });
});
