/**
 * 「简历匹配评分」工作流的稳定结果契约。
 *
 * 工作流的提示、汇总节点校验 Tool 与内部调用入口必须共用这一个事实源：
 * JSON Schema 负责告诉 Agent 精确形状，手写校验器负责核对字段与跨字段算法。
 */

export const RESUME_MATCH_WORKFLOW_NAME = "简历匹配评分";
export const RESUME_MATCH_JOB_INPUT_LABEL = "岗位JD";
export const RESUME_MATCH_RESUME_INPUT_LABEL = "简历";
export const RESUME_MATCH_JOB_OBJECT_TYPE_NAME = "岗位JD文件";
export const RESUME_MATCH_RESUME_OBJECT_TYPE_NAME = "简历文件";
export const RESUME_MATCH_PARSE_ACTION_NAME = "简历评分·解析";
export const RESUME_MATCH_JOB_PARSE_PORT = "岗位文件";
export const RESUME_MATCH_RESUME_PARSE_PORT = "简历文件";
export const RESUME_MATCH_OUTPUT_LABEL = "评分结果";
export const RESUME_MATCH_RESULT_ARTIFACT = "match-result.json";
export const RESUME_MATCH_RESULT_SCHEMA_VERSION = "1.0";
export const RESUME_MATCH_VALIDATOR_TOOL_NAME = "validate_resume_match_result";
/** seed 生成的权威 Tool 源码摘要；实现变化必须经过代码审查后显式更新此 pin。 */
export const RESUME_MATCH_VALIDATOR_TOOL_SHA256 =
  "080d8fea2c8ebedeeadda585da547cb8d762d0460c796c626162cfaf4b014a64";

export const RESUME_MATCH_DIMENSIONS = [
  "mustHave",
  "skillMatch",
  "experienceDepth",
  "domainFit",
  "stability",
  "authenticityRisk",
] as const;

export type ResumeMatchDimension = (typeof RESUME_MATCH_DIMENSIONS)[number];
export type ResumeMatchConfidence = "high" | "medium" | "low";

export interface ResumeMatchDimensionResult {
  reviewerScore: number;
  finalScore: number;
  evidenceConfidence: ResumeMatchConfidence;
  conclusion: string;
}

export interface ResumeMatchResult {
  schemaVersion: "1.0";
  decision: "recommend" | "not_recommend";
  overallScore: number;
  matchLevel: "strong" | "good" | "partial" | "weak";
  evidenceConfidence: ResumeMatchConfidence;
  summary: string;
  decisiveReasons: string[];
  veto: {
    triggered: boolean;
    dimensions: Array<"mustHave" | "authenticityRisk">;
    reasons: string[];
  };
  hardRequirements: Array<{
    requirement: string;
    status: "met" | "not_met" | "unverified" | "conflict";
    evidence: string;
    impact: string;
  }>;
  dimensions: Record<ResumeMatchDimension, ResumeMatchDimensionResult>;
  strengths: Array<{ point: string; evidence: string }>;
  concerns: Array<{
    point: string;
    evidenceStatus: "supported" | "unverified" | "conflict";
    impact: string;
  }>;
  adjustments: Array<{
    dimension: ResumeMatchDimension;
    reviewerScore: number;
    finalScore: number;
    reason: string;
  }>;
}

const nonEmptyString = { type: "string", minLength: 1 } as const;
const score = { type: "integer", minimum: 0, maximum: 100 } as const;
const confidence = { type: "string", enum: ["high", "medium", "low"] } as const;
const dimensionNames = { type: "string", enum: [...RESUME_MATCH_DIMENSIONS] } as const;
const dimensionResultSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reviewerScore: score,
    finalScore: score,
    evidenceConfidence: confidence,
    conclusion: nonEmptyString,
  },
  required: ["reviewerScore", "finalScore", "evidenceConfidence", "conclusion"],
} as const;

/** Agent 要逐字段遵守的精确 JSON Schema；跨字段算法由下方校验器补齐。 */
export const RESUME_MATCH_RESULT_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "ResumeMatchResult",
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: RESUME_MATCH_RESULT_SCHEMA_VERSION },
    decision: { type: "string", enum: ["recommend", "not_recommend"] },
    overallScore: score,
    matchLevel: { type: "string", enum: ["strong", "good", "partial", "weak"] },
    evidenceConfidence: confidence,
    summary: nonEmptyString,
    decisiveReasons: {
      type: "array",
      minItems: 1,
      items: nonEmptyString,
    },
    veto: {
      type: "object",
      additionalProperties: false,
      properties: {
        triggered: { type: "boolean" },
        dimensions: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", enum: ["mustHave", "authenticityRisk"] },
        },
        reasons: { type: "array", items: nonEmptyString },
      },
      required: ["triggered", "dimensions", "reasons"],
    },
    hardRequirements: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          requirement: nonEmptyString,
          status: {
            type: "string",
            enum: ["met", "not_met", "unverified", "conflict"],
          },
          evidence: { type: "string" },
          impact: nonEmptyString,
        },
        required: ["requirement", "status", "evidence", "impact"],
      },
    },
    dimensions: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        RESUME_MATCH_DIMENSIONS.map((name) => [name, dimensionResultSchema]),
      ),
      required: [...RESUME_MATCH_DIMENSIONS],
    },
    strengths: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { point: nonEmptyString, evidence: nonEmptyString },
        required: ["point", "evidence"],
      },
    },
    concerns: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          point: nonEmptyString,
          evidenceStatus: {
            type: "string",
            enum: ["supported", "unverified", "conflict"],
          },
          impact: nonEmptyString,
        },
        required: ["point", "evidenceStatus", "impact"],
      },
    },
    adjustments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          dimension: dimensionNames,
          reviewerScore: score,
          finalScore: score,
          reason: nonEmptyString,
        },
        required: ["dimension", "reviewerScore", "finalScore", "reason"],
      },
    },
  },
  required: [
    "schemaVersion",
    "decision",
    "overallScore",
    "matchLevel",
    "evidenceConfidence",
    "summary",
    "decisiveReasons",
    "veto",
    "hardRequirements",
    "dimensions",
    "strengths",
    "concerns",
    "adjustments",
  ],
} as const;

export const RESUME_MATCH_RESULT_SCHEMA_TEXT = JSON.stringify(
  RESUME_MATCH_RESULT_JSON_SCHEMA,
  null,
  2,
);

/**
 * 严格核对 JSON 形状与评分算法。函数故意完全自包含：seed 会把它的 JS 源码
 * 原样嵌进汇总 Action 的校验 Tool，使服务器和 Agent 用的是同一套规则。
 */
export function validateResumeMatchResult(value: unknown): string[] {
  const errors: string[] = [];
  const dimensions = [
    "mustHave",
    "skillMatch",
    "experienceDepth",
    "domainFit",
    "stability",
    "authenticityRisk",
  ] as const;
  const confidences = ["high", "medium", "low"] as const;

  function isObject(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
  }

  function exactObject(
    input: unknown,
    at: string,
    keys: readonly string[],
  ): Record<string, unknown> | null {
    if (!isObject(input)) {
      errors.push(`${at} 必须是对象`);
      return null;
    }
    for (const key of keys) {
      if (!(key in input)) errors.push(`${at}.${key} 缺失`);
    }
    for (const key of Object.keys(input)) {
      if (!keys.includes(key)) errors.push(`${at}.${key} 是未允许字段`);
    }
    return input;
  }

  function text(input: unknown, at: string, allowEmpty = false): string | null {
    if (typeof input !== "string" || (!allowEmpty && input.trim() === "")) {
      errors.push(`${at} 必须是${allowEmpty ? "" : "非空"}字符串`);
      return null;
    }
    return input;
  }

  function oneOf<T extends string>(
    input: unknown,
    at: string,
    allowed: readonly T[],
  ): T | null {
    if (typeof input !== "string" || !allowed.includes(input as T)) {
      errors.push(`${at} 必须是 ${allowed.join(" / ")} 之一`);
      return null;
    }
    return input as T;
  }

  function integer(input: unknown, at: string): number | null {
    if (!Number.isInteger(input) || (input as number) < 0 || (input as number) > 100) {
      errors.push(`${at} 必须是 0-100 的整数`);
      return null;
    }
    return input as number;
  }

  function array(input: unknown, at: string): unknown[] | null {
    if (!Array.isArray(input)) {
      errors.push(`${at} 必须是数组`);
      return null;
    }
    return input;
  }

  function stringArray(input: unknown, at: string, minItems = 0): string[] | null {
    const items = array(input, at);
    if (!items) return null;
    if (items.length < minItems) errors.push(`${at} 至少要有 ${minItems} 项`);
    const result: string[] = [];
    items.forEach((item, index) => {
      const parsed = text(item, `${at}[${index}]`);
      if (parsed !== null) result.push(parsed);
    });
    return result;
  }

  const rootKeys = [
    "schemaVersion",
    "decision",
    "overallScore",
    "matchLevel",
    "evidenceConfidence",
    "summary",
    "decisiveReasons",
    "veto",
    "hardRequirements",
    "dimensions",
    "strengths",
    "concerns",
    "adjustments",
  ];
  const root = exactObject(value, "$", rootKeys);
  if (!root) return errors;

  if (root.schemaVersion !== "1.0") errors.push("$.schemaVersion 必须等于 1.0");
  const decision = oneOf(root.decision, "$.decision", ["recommend", "not_recommend"]);
  const overallScore = integer(root.overallScore, "$.overallScore");
  const matchLevel = oneOf(root.matchLevel, "$.matchLevel", [
    "strong",
    "good",
    "partial",
    "weak",
  ]);
  const aggregateConfidence = oneOf(
    root.evidenceConfidence,
    "$.evidenceConfidence",
    confidences,
  );
  text(root.summary, "$.summary");
  stringArray(root.decisiveReasons, "$.decisiveReasons", 1);

  const veto = exactObject(root.veto, "$.veto", ["triggered", "dimensions", "reasons"]);
  let vetoTriggered: boolean | null = null;
  let vetoDimensions: string[] | null = null;
  let vetoReasons: string[] | null = null;
  if (veto) {
    if (typeof veto.triggered !== "boolean") {
      errors.push("$.veto.triggered 必须是布尔值");
    } else {
      vetoTriggered = veto.triggered;
    }
    const rawDimensions = array(veto.dimensions, "$.veto.dimensions");
    if (rawDimensions) {
      vetoDimensions = [];
      rawDimensions.forEach((item, index) => {
        const parsed = oneOf(item, `$.veto.dimensions[${index}]`, [
          "mustHave",
          "authenticityRisk",
        ]);
        if (parsed !== null) vetoDimensions!.push(parsed);
      });
      if (new Set(vetoDimensions).size !== vetoDimensions.length) {
        errors.push("$.veto.dimensions 不得重复");
      }
    }
    vetoReasons = stringArray(veto.reasons, "$.veto.reasons");
  }

  const hardRequirements = array(root.hardRequirements, "$.hardRequirements");
  const hardStatuses: string[] = [];
  if (hardRequirements) {
    if (hardRequirements.length === 0) errors.push("$.hardRequirements 至少要有 1 项");
    hardRequirements.forEach((item, index) => {
      const at = `$.hardRequirements[${index}]`;
      const requirement = exactObject(item, at, [
        "requirement",
        "status",
        "evidence",
        "impact",
      ]);
      if (!requirement) return;
      text(requirement.requirement, `${at}.requirement`);
      const status = oneOf(requirement.status, `${at}.status`, [
        "met",
        "not_met",
        "unverified",
        "conflict",
      ]);
      if (status !== null) hardStatuses.push(status);
      text(requirement.evidence, `${at}.evidence`, status === "unverified");
      text(requirement.impact, `${at}.impact`);
    });
  }

  const dimensionsObject = exactObject(root.dimensions, "$.dimensions", dimensions);
  const dimensionValues: Record<
    string,
    { reviewerScore: number | null; finalScore: number | null; confidence: string | null }
  > = {};
  if (dimensionsObject) {
    for (const dimension of dimensions) {
      const at = `$.dimensions.${dimension}`;
      const item = exactObject(dimensionsObject[dimension], at, [
        "reviewerScore",
        "finalScore",
        "evidenceConfidence",
        "conclusion",
      ]);
      if (!item) continue;
      const reviewerScore = integer(item.reviewerScore, `${at}.reviewerScore`);
      const finalScore = integer(item.finalScore, `${at}.finalScore`);
      const confidenceValue = oneOf(
        item.evidenceConfidence,
        `${at}.evidenceConfidence`,
        confidences,
      );
      text(item.conclusion, `${at}.conclusion`);
      dimensionValues[dimension] = {
        reviewerScore,
        finalScore,
        confidence: confidenceValue,
      };
      if (
        (dimension === "mustHave" || dimension === "authenticityRisk") &&
        ((reviewerScore !== null && reviewerScore !== 0 && reviewerScore !== 100) ||
          (finalScore !== null && finalScore !== 0 && finalScore !== 100))
      ) {
        errors.push(`${at} 是否决维度，评委分和最终分只能是 0 或 100`);
      }
    }
  }

  const strengths = array(root.strengths, "$.strengths");
  strengths?.forEach((item, index) => {
    const at = `$.strengths[${index}]`;
    const strength = exactObject(item, at, ["point", "evidence"]);
    if (!strength) return;
    text(strength.point, `${at}.point`);
    text(strength.evidence, `${at}.evidence`);
  });

  const concerns = array(root.concerns, "$.concerns");
  concerns?.forEach((item, index) => {
    const at = `$.concerns[${index}]`;
    const concern = exactObject(item, at, ["point", "evidenceStatus", "impact"]);
    if (!concern) return;
    text(concern.point, `${at}.point`);
    oneOf(concern.evidenceStatus, `${at}.evidenceStatus`, [
      "supported",
      "unverified",
      "conflict",
    ]);
    text(concern.impact, `${at}.impact`);
  });

  const adjustments = array(root.adjustments, "$.adjustments");
  const adjustmentValues = new Map<
    string,
    { reviewerScore: number | null; finalScore: number | null }
  >();
  adjustments?.forEach((item, index) => {
    const at = `$.adjustments[${index}]`;
    const adjustment = exactObject(item, at, [
      "dimension",
      "reviewerScore",
      "finalScore",
      "reason",
    ]);
    if (!adjustment) return;
    const dimension = oneOf(adjustment.dimension, `${at}.dimension`, dimensions);
    const reviewerScore = integer(adjustment.reviewerScore, `${at}.reviewerScore`);
    const finalScore = integer(adjustment.finalScore, `${at}.finalScore`);
    text(adjustment.reason, `${at}.reason`);
    if (dimension !== null) {
      if (adjustmentValues.has(dimension)) {
        errors.push(`$.adjustments 对 ${dimension} 只能记录一次`);
      } else {
        adjustmentValues.set(dimension, { reviewerScore, finalScore });
      }
    }
  });

  for (const dimension of dimensions) {
    const scores = dimensionValues[dimension];
    if (!scores || scores.reviewerScore === null || scores.finalScore === null) continue;
    const adjustment = adjustmentValues.get(dimension);
    if (scores.reviewerScore === scores.finalScore) {
      if (adjustment) errors.push(`$.adjustments 不应记录未改分维度 ${dimension}`);
      continue;
    }
    if (!adjustment) {
      errors.push(`$.adjustments 缺少已改分维度 ${dimension}`);
    } else if (
      adjustment.reviewerScore !== scores.reviewerScore ||
      adjustment.finalScore !== scores.finalScore
    ) {
      errors.push(`$.adjustments 中 ${dimension} 的分数必须与 dimensions 一致`);
    }
  }

  const scoredDimensions = ["skillMatch", "experienceDepth", "domainFit", "stability"];
  const scoredValues = scoredDimensions.map(
    (dimension) => dimensionValues[dimension]?.finalScore ?? null,
  );
  if (overallScore !== null && scoredValues.every((item) => item !== null)) {
    const expectedScore = Math.round(
      (scoredValues as number[]).reduce((sum, item) => sum + item, 0) /
        scoredValues.length,
    );
    if (overallScore !== expectedScore) {
      errors.push(`$.overallScore 应为四个非否决维度最终分的四舍五入均值 ${expectedScore}`);
    }
    const expectedLevel =
      expectedScore >= 85
        ? "strong"
        : expectedScore >= 70
          ? "good"
          : expectedScore >= 55
            ? "partial"
            : "weak";
    if (matchLevel !== null && matchLevel !== expectedLevel) {
      errors.push(`$.matchLevel 应为 ${expectedLevel}`);
    }
  }

  const expectedVetoDimensions = ["mustHave", "authenticityRisk"].filter(
    (dimension) => dimensionValues[dimension]?.finalScore === 0,
  );
  const expectedVeto = expectedVetoDimensions.length > 0;
  if (vetoTriggered !== null && vetoTriggered !== expectedVeto) {
    errors.push(`$.veto.triggered 应为 ${expectedVeto}`);
  }
  if (
    vetoDimensions &&
    (vetoDimensions.length !== expectedVetoDimensions.length ||
      vetoDimensions.some((item, index) => item !== expectedVetoDimensions[index]))
  ) {
    errors.push(`$.veto.dimensions 应为 [${expectedVetoDimensions.join(", ")}]`);
  }
  if (vetoReasons && ((expectedVeto && vetoReasons.length === 0) || (!expectedVeto && vetoReasons.length > 0))) {
    errors.push(`$.veto.reasons 在否决时必须非空、无否决时必须为空`);
  }
  if (decision !== null && overallScore !== null) {
    const expectedDecision = expectedVeto || overallScore < 70 ? "not_recommend" : "recommend";
    if (decision !== expectedDecision) errors.push(`$.decision 应为 ${expectedDecision}`);
  }

  const mustHaveScore = dimensionValues.mustHave?.finalScore;
  if (hardStatuses.length > 0 && mustHaveScore !== null && mustHaveScore !== undefined) {
    const allMet = hardStatuses.every((status) => status === "met");
    if ((mustHaveScore === 100) !== allMet) {
      errors.push("$.dimensions.mustHave.finalScore 只有全部硬性条件为 met 时才能是 100");
    }
  }

  const confidenceValues = dimensions
    .map((dimension) => dimensionValues[dimension]?.confidence)
    .filter((item): item is string => typeof item === "string");
  if (aggregateConfidence !== null && confidenceValues.length === dimensions.length) {
    const expectedConfidence = confidenceValues.includes("low")
      ? "low"
      : confidenceValues.includes("medium")
        ? "medium"
        : "high";
    if (aggregateConfidence !== expectedConfidence) {
      errors.push(`$.evidenceConfidence 应为六个维度证据充分度的最低档 ${expectedConfidence}`);
    }
  }

  return errors;
}

export type ResumeMatchParseResult =
  | { ok: true; data: ResumeMatchResult }
  | { ok: false; errors: string[] };

export function parseResumeMatchResult(content: string): ResumeMatchParseResult {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    return {
      ok: false,
      errors: [`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const errors = validateResumeMatchResult(value);
  return errors.length === 0
    ? { ok: true, data: value as ResumeMatchResult }
    : { ok: false, errors };
}
