/** collectCapabilities 只消费 resolve 时快照，证明运行启动不会回读共享能力库。 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedWorkflow } from "@/server/resolve";

const { collectCapabilities, toolFilterForAction } = await import("./capabilities");
const { SKILL_LIBRARY_DIR } = await import("@/server/skill-library");

describe("工作流技能集与 Tool 集归属", () => {
  it("取工作流快照时技能按 slug 导入、Tool 全量保留，并保留 A/B 的可见差异", () => {
    const now = new Date(0);
    const tool = {
      id: "tool-1",
      name: "危险工具",
      publicName: "dangerous_tool",
      description: "测试",
      parameters: { type: "object" },
      output: null,
      timeoutMs: null,
      code: "export default async () => ({})",
      createdAt: now,
      updatedAt: now,
    };
    const skill = { id: "skill-1", name: "核对", slug: "skill-abc" };
    const resolved = {
      capabilities: {
        skills: [skill],
        tools: [tool],
        toolNamesByActionId: new Map<string, readonly string[]>([
          ["action-a", ["dangerous_tool"]],
          ["action-b", []],
        ]),
      },
    } as unknown as ResolvedWorkflow;
    const capabilities = collectCapabilities(resolved);

    expect(capabilities.skills).toEqual([
      { name: "skill-abc", sourceDir: path.join(SKILL_LIBRARY_DIR, "skill-abc") },
    ]);
    expect(capabilities.skillRefs).toEqual([skill]);
    expect(capabilities.tools.map((tool) => tool.publicName)).toEqual(["dangerous_tool"]);
    expect(capabilities.toolNamesByActionId.get("action-a")).toEqual(["dangerous_tool"]);
    expect(capabilities.toolNamesByActionId.get("action-b")).toEqual([]);
    expect(toolFilterForAction(capabilities, "action-a", [])).toBeUndefined();
    expect(toolFilterForAction(capabilities, "action-b", [])).toEqual({
      deny: ["dangerous_tool"],
    });
  });
});
