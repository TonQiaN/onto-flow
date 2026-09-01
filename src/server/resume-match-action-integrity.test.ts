import { describe, expect, it } from "vitest";
import type { ResolvedActionDefinition } from "./resolve";
import {
  matchesResumeMatchActionBehavior,
  resumeMatchActionBehaviorDigest,
} from "./resume-match-action-integrity";

const now = new Date(0);

function definition(): ResolvedActionDefinition {
  return {
    action: {
      id: "action-test",
      name: "行为测试",
      description: "不进入模型行为摘要",
      prompt: "读取全部输入并输出结论",
      rule: "不得编造证据",
      modelId: "model-row",
      reasoningEffort: "high",
      maxReentries: 0,
      onExhausted: "fail",
      createdAt: now,
      updatedAt: now,
    },
    model: {
      id: "model-row",
      providerId: "deepseek-official",
      modelId: "deepseek-v4-flash",
      displayName: "显示名不进入模型行为摘要",
    },
    ports: { inputs: [], outputs: [] },
    skills: [],
  };
}

describe("简历评分 Action 行为摘要", () => {
  it("关系顺序不影响摘要，非执行描述也不进入摘要", () => {
    const original = definition();
    const digest = resumeMatchActionBehaviorDigest(original, ["工具乙", "工具甲"]);
    const renamedDescription: ResolvedActionDefinition = {
      ...original,
      action: { ...original.action, description: "仅供人看的新描述" },
      model: { ...original.model, displayName: "新的显示名" },
    };

    expect(resumeMatchActionBehaviorDigest(renamedDescription, ["工具甲", "工具乙"]))
      .toBe(digest);
  });

  it.each([
    ["任务", (value: ResolvedActionDefinition) => ({
      ...value,
      action: { ...value.action, prompt: "篡改任务" },
    })],
    ["规则", (value: ResolvedActionDefinition) => ({
      ...value,
      action: { ...value.action, rule: "篡改规则" },
    })],
    ["provider", (value: ResolvedActionDefinition) => ({
      ...value,
      model: { ...value.model, providerId: "other-provider" },
    })],
    ["model", (value: ResolvedActionDefinition) => ({
      ...value,
      model: { ...value.model, modelId: "other-model" },
    })],
    ["推理档位", (value: ResolvedActionDefinition) => ({
      ...value,
      action: { ...value.action, reasoningEffort: "low" as const },
    })],
    ["重入上限", (value: ResolvedActionDefinition) => ({
      ...value,
      action: { ...value.action, maxReentries: 1 },
    })],
    ["耗尽策略", (value: ResolvedActionDefinition) => ({
      ...value,
      action: { ...value.action, onExhausted: "accept" as const },
    })],
    ["Skill 集合", (value: ResolvedActionDefinition) => ({
      ...value,
      skills: [{ id: "skill-one", name: "额外 Skill" }],
    })],
  ])("%s 变化会使固定摘要失效", (_field, mutate) => {
    const original = definition();
    const expected = resumeMatchActionBehaviorDigest(original, ["校验工具"]);
    expect(matchesResumeMatchActionBehavior(mutate(original), ["校验工具"], expected))
      .toBe(false);
  });

  it("完整 Tool 集合变化会使固定摘要失效", () => {
    const original = definition();
    const expected = resumeMatchActionBehaviorDigest(original, ["校验工具"]);
    expect(
      matchesResumeMatchActionBehavior(original, ["校验工具", "额外工具"], expected),
    ).toBe(false);
  });
});
