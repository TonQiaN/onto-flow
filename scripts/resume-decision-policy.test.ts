import fs from "node:fs";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(new URL("./seed-resume.ts", import.meta.url), "utf8");

describe("简历评分闭环裁决契约", () => {
  it("明确禁止把证据缺口或评委分歧交给后续人工流程", () => {
    expect(source).not.toContain("## 面试提问");
    expect(source).not.toContain("## 待确认");
    expect(source).not.toContain("不重新评分");
    expect(source).not.toContain("不推翻单维结论");
    expect(source).toContain("不得生成面试问题、人工复核、后续核实或交给他人判断等行动项");
    expect(source).toContain("本维度判断必须在当前材料内完成");
  });

  it("要求评委处理证据缺口，最终汇总输出严格 JSON 并完成机械校验", () => {
    expect(source).toContain("## 证据缺口及计分处理");
    expect(source).toContain("RESUME_MATCH_RESULT_SCHEMA_TEXT");
    expect(source).toContain("match-result.json");
    expect(source).toContain("RESUME_MATCH_VALIDATOR_TOOL_NAME");
    expect(source).toContain("const __name = <T>(target: T, _value: string): T => target");
    expect(source).toContain(
      "const expected = path.resolve(root, ${JSON.stringify(RESUME_MATCH_RESULT_ARTIFACT)});",
    );
    expect(source).toContain("if (candidate !== expected)");
    expect(source).toContain("没有拿到 `valid=true` 不得提交结构化输出");
    expect(source).toContain("结果不得保留未裁决项");
    expect(source).toMatch(/toolIds: \[validateResultTool\]/);
  });

  it("把岗位、简历和六份评委结论全部接入最终汇总", () => {
    const criticKeys = source.match(
      /key: "(?:must-have|skill-match|experience-depth|domain-fit|stability|red-flag)"/g,
    );
    expect(criticKeys).toHaveLength(6);
    expect(source).toMatch(
      /const report = upsertAction\(\{[\s\S]*?inputs: \[\s*\{ name: RESUME_MATCH_PARSED_JOB_PORT, objectTypeId: tJdMd \},\s*\{ name: RESUME_MATCH_PARSED_RESUME_PORT, objectTypeId: tResumeMd \},\s*\{ name: RESUME_MATCH_REPORT_CRITICS_PORT, objectTypeId: tVerdict \},\s*\],\s*outputs:/,
    );
    expect(source).toMatch(
      /sourceNodeId: parseNode\.id,\s*sourcePort: RESUME_MATCH_PARSED_JOB_PORT,\s*targetNodeId: reportNode\.id,\s*targetPort: RESUME_MATCH_PARSED_JOB_PORT/,
    );
    expect(source).toMatch(
      /sourceNodeId: parseNode\.id,\s*sourcePort: RESUME_MATCH_PARSED_RESUME_PORT,\s*targetNodeId: reportNode\.id,\s*targetPort: RESUME_MATCH_PARSED_RESUME_PORT/,
    );
    expect(source).toMatch(
      /\.\.\.criticNodes\.map\(\(criticNode\) =>\s*edge\(\{\s*sourceNodeId: criticNode\.id,\s*sourcePort: RESUME_MATCH_CRITIC_RESULT_PORT,\s*targetNodeId: reportNode\.id,\s*targetPort: RESUME_MATCH_REPORT_CRITICS_PORT/,
    );
  });

  it("把未证实保留为事实状态，同时固定其评分影响", () => {
    expect(source).toContain("未证实不等于不具备");
    expect(source).toContain("只有每一条硬性条件都有明确证据满足才记 100");
    expect(source).toContain("未证实项不得写成候选人不具备");
    expect(source).toContain("材料未说明原因绝不影响分数");
    expect(source).toContain('未证实时写「无」');
  });
});
