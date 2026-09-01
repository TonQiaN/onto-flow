/** collectCapabilities 只消费 resolve 时快照，证明运行启动不会回读共享能力库。 */
import { describe, expect, it } from "vitest";
import type { ResolvedWorkflow } from "@/server/resolve";

const { collectCapabilities, toolFilterForAction } = await import("./capabilities");

describe("Action Tool 引用归属", () => {
  it("取工作流快照并集时仍保留 A/B 的引用差异", () => {
    const now = new Date(0);
    const tool = {
      id: "tool-1",
      name: "dangerous_tool",
      description: "测试",
      code: 'export const name="dangerous_tool"',
      createdAt: now,
      updatedAt: now,
    };
    const resolved = {
      capabilities: {
        skills: [],
        tools: [tool],
        toolNamesByActionId: new Map<string, readonly string[]>([
          ["action-a", ["dangerous_tool"]],
          ["action-b", []],
        ]),
      },
    } as unknown as ResolvedWorkflow;
    const capabilities = collectCapabilities(resolved);

    expect(capabilities.tools.map((tool) => tool.name)).toEqual(["dangerous_tool"]);
    expect(capabilities.toolNamesByActionId.get("action-a")).toEqual(["dangerous_tool"]);
    expect(capabilities.toolNamesByActionId.get("action-b")).toEqual([]);
    expect(toolFilterForAction(capabilities, "action-a", [])).toBeUndefined();
    expect(toolFilterForAction(capabilities, "action-b", [])).toEqual({
      deny: ["dangerous_tool"],
    });
  });
});
