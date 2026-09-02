import {
  RESUME_MATCH_ACTION_BEHAVIOR_SHA256,
  resumeMatchActionBehaviorSha256,
} from "@/lib/resume-match";
import type { ResolvedActionDefinition } from "@/server/resolve";

/**
 * 把受理快照中的完整模型行为压成可与 seed pin 比较的稳定摘要。
 * toolPublicNames 是本 Action 可见的 Tool 公名（resolve 的 toolNamesByActionId）。
 */
export function resumeMatchActionBehaviorDigest(
  definition: ResolvedActionDefinition,
  toolPublicNames: readonly string[],
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
    preloadSkillNames: definition.preloads.map((skill) => skill.name),
    toolPublicNames,
  });
}

export function matchesResumeMatchActionBehavior(
  definition: ResolvedActionDefinition,
  toolPublicNames: readonly string[],
  expectedSha256: string,
): boolean {
  return resumeMatchActionBehaviorDigest(definition, toolPublicNames) === expectedSha256;
}

/** 专用入口只受理 seed 明确审查过的 Action 行为，不把同名可编辑 Action 当成同一契约。 */
export function isAuthoritativeResumeMatchActionBehavior(
  expectedName: string,
  definition: ResolvedActionDefinition,
  toolPublicNames: readonly string[],
): boolean {
  const expectedSha256 = RESUME_MATCH_ACTION_BEHAVIOR_SHA256[expectedName];
  return (
    definition.action.name === expectedName &&
    typeof expectedSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(expectedSha256) &&
    matchesResumeMatchActionBehavior(definition, toolPublicNames, expectedSha256)
  );
}
