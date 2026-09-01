import { describe, expect, it } from "vitest";
import {
  parseResumeMatchResult,
  validateResumeMatchResult,
  type ResumeMatchResult,
} from "./resume-match";

function validResult(): ResumeMatchResult {
  return {
    schemaVersion: "1.0",
    decision: "recommend",
    overallScore: 75,
    matchLevel: "good",
    evidenceConfidence: "low",
    summary: "当前材料支持推荐，匹配结论以现有岗位与简历证据为限。",
    decisiveReasons: ["四个非否决维度平均分达到推荐线，且没有否决项。"],
    veto: { triggered: false, dimensions: [], reasons: [] },
    hardRequirements: [
      {
        requirement: "具备岗位要求的核心技术经验",
        status: "met",
        evidence: "负责核心服务的设计与实现。",
        impact: "硬性条件有直接证据支持。",
      },
    ],
    dimensions: {
      mustHave: {
        reviewerScore: 100,
        finalScore: 100,
        evidenceConfidence: "high",
        conclusion: "全部硬性条件有证据支持。",
      },
      skillMatch: {
        reviewerScore: 80,
        finalScore: 80,
        evidenceConfidence: "high",
        conclusion: "核心技能多数直接命中。",
      },
      experienceDepth: {
        reviewerScore: 70,
        finalScore: 70,
        evidenceConfidence: "medium",
        conclusion: "职责深度达到岗位基本要求。",
      },
      domainFit: {
        reviewerScore: 60,
        finalScore: 60,
        evidenceConfidence: "low",
        conclusion: "存在可迁移经验，但直接领域证据有限。",
      },
      stability: {
        reviewerScore: 90,
        finalScore: 90,
        evidenceConfidence: "high",
        conclusion: "时间线完整且自洽。",
      },
      authenticityRisk: {
        reviewerScore: 100,
        finalScore: 100,
        evidenceConfidence: "high",
        conclusion: "未发现足以否决的内部矛盾。",
      },
    },
    strengths: [{ point: "核心技能有项目证据", evidence: "负责核心服务的设计与实现。" }],
    concerns: [
      {
        point: "直接领域经验有限",
        evidenceStatus: "unverified",
        impact: "领域匹配维度按现有证据计 60 分。",
      },
    ],
    adjustments: [],
  };
}

describe("简历匹配 JSON 结果契约", () => {
  it("接受字段完整且评分算法一致的结果", () => {
    expect(validateResumeMatchResult(validResult())).toEqual([]);
    expect(parseResumeMatchResult(JSON.stringify(validResult()))).toEqual({
      ok: true,
      data: validResult(),
    });
  });

  it("拒绝额外字段、错误总分和错误档位", () => {
    const result = { ...validResult(), extra: true, overallScore: 74, matchLevel: "strong" };
    const errors = validateResumeMatchResult(result);
    expect(errors).toContain("$.extra 是未允许字段");
    expect(errors).toContain("$.overallScore 应为四个非否决维度最终分的四舍五入均值 75");
    expect(errors).toContain("$.matchLevel 应为 good");
  });

  it("把否决维度、硬性条件和最终判断绑定在一起", () => {
    const result = validResult();
    result.dimensions.mustHave.reviewerScore = 0;
    result.dimensions.mustHave.finalScore = 0;
    result.hardRequirements[0].status = "unverified";
    result.hardRequirements[0].evidence = "";
    result.decision = "not_recommend";
    result.veto = {
      triggered: true,
      dimensions: ["mustHave"],
      reasons: ["当前材料没有达到硬性条件的证据门槛。"],
    };
    expect(validateResumeMatchResult(result)).toEqual([]);

    result.veto.dimensions = [];
    expect(validateResumeMatchResult(result)).toContain(
      "$.veto.dimensions 应为 [mustHave]",
    );
  });

  it("只有未核验的硬性条件可以缺少原文证据", () => {
    const result = validResult();
    result.hardRequirements[0].evidence = "";
    expect(validateResumeMatchResult(result)).toContain(
      "$.hardRequirements[0].evidence 必须是非空字符串",
    );

    result.hardRequirements[0].status = "unverified";
    result.dimensions.mustHave.reviewerScore = 0;
    result.dimensions.mustHave.finalScore = 0;
    result.decision = "not_recommend";
    result.veto = {
      triggered: true,
      dimensions: ["mustHave"],
      reasons: ["当前材料没有达到硬性条件的证据门槛。"],
    };
    expect(validateResumeMatchResult(result)).toEqual([]);
  });

  it("要求每个改分维度在 adjustments 中且分数完全一致", () => {
    const result = validResult();
    result.dimensions.domainFit.finalScore = 64;
    result.overallScore = 76;
    result.adjustments = [
      {
        dimension: "domainFit",
        reviewerScore: 60,
        finalScore: 64,
        reason: "原文支持一个可迁移的同构业务场景。",
      },
    ];
    expect(validateResumeMatchResult(result)).toEqual([]);

    result.adjustments = [];
    expect(validateResumeMatchResult(result)).toContain(
      "$.adjustments 缺少已改分维度 domainFit",
    );
  });

  it("嵌入 Tool 的函数源码只需携带转译器的 __name 辅助函数", () => {
    const restored = Function(
      `const __name = (target) => target; return (${validateResumeMatchResult.toString()})`,
    )() as typeof validateResumeMatchResult;
    expect(restored(validResult())).toEqual([]);
  });

  it("拒绝不是 JSON 的产物", () => {
    const parsed = parseResumeMatchResult("```json\n{}\n```");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors[0]).toContain("JSON 解析失败");
  });
});
