import {
  RESUME_MATCH_ACTION_BEHAVIOR_SHA256,
  resumeMatchActionBehaviorSha256,
} from "@/lib/resume-match";
import type { ResolvedActionDefinition } from "@/server/resolve";

/** 把受理快照中的完整模型行为压成可与 seed pin 比较的稳定摘要。 */
export function resumeMatchActionBehaviorDigest(
  definition: ResolvedActionDefinition,
  toolNames: readonly string[],
): string {
  return resumeMatchActionBehaviorSha256({
    name: definition.action.name,
    prompt: definition.action.prompt,
    rule: definition.action.rule,
    providerId: definition.model.providerId,
    modelId: definition.model.modelId,
    reasoningEffort: definition.action.reasoningEffort,
    maxReentries: definition.action.maxReentries,
    onExhausted: definition.action.onExhausted,
    skillNames: definition.skills.map((skill) => skill.name),
    toolNames,
  });
}

export function matchesResumeMatchActionBehavior(
  definition: ResolvedActionDefinition,
  toolNames: readonly string[],
  expectedSha256: string,
): boolean {
  return resumeMatchActionBehaviorDigest(definition, toolNames) === expectedSha256;
}

/** 专用入口只受理 seed 明确审查过的 Action 行为，不把同名可编辑 Action 当成同一契约。 */
export function isAuthoritativeResumeMatchActionBehavior(
  expectedName: string,
  definition: ResolvedActionDefinition,
  toolNames: readonly string[],
): boolean {
  const expectedSha256 = RESUME_MATCH_ACTION_BEHAVIOR_SHA256[expectedName];
  return (
    definition.action.name === expectedName &&
    typeof expectedSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(expectedSha256) &&
    matchesResumeMatchActionBehavior(definition, toolNames, expectedSha256)
  );
}
