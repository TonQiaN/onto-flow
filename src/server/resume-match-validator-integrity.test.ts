import { describe, expect, it } from "vitest";
import { toolContractSha256 } from "@/lib/tool-digest";
import {
  isAuthoritativeResumeMatchValidatorTool,
  resumeMatchValidatorToolDigest,
} from "./resume-match-validator-integrity";

const contract = {
  publicName: "validate_resume_match_result",
  description: "校验",
  parameters: { type: "object", properties: {} },
  output: null,
  timeoutMs: null,
  code: "export default async function execute() { return { valid: true }; }",
};

describe("简历校验 Tool 契约摘要", () => {
  it("摘要就是契约摘要，并拒绝任意替换实现", () => {
    expect(resumeMatchValidatorToolDigest(contract)).toBe(toolContractSha256(contract));
    expect(isAuthoritativeResumeMatchValidatorTool(contract)).toBe(false);
  });

  it("展示名、id 与时间戳不进入摘要", () => {
    const row = { ...contract, id: "tool-1", name: "随便改的展示名", createdAt: new Date(0) };
    expect(resumeMatchValidatorToolDigest(row)).toBe(resumeMatchValidatorToolDigest(contract));
  });
});
