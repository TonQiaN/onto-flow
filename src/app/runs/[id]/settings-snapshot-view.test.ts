import { describe, expect, it } from "vitest";
import { asRunSettingsSnapshot } from "./settings-snapshot-view";

const full = {
  global: {
    toggles: { webSearch: false, fsSearch: true, strReplaceEditor: true, todo: true, compaction: true },
    mcpServers: ["filesystem", "github"],
    disabledTools: ["bash"],
    defaultInstructionsSha256: "a".repeat(64),
  },
  workflow: {
    settings: { toggles: { webSearch: true }, mcpServers: ["filesystem", "unregistered"] },
    instructionsSha256: "b".repeat(64),
    skills: [{ id: "s1", name: "集采计划编制规范", slug: "skill-1a2b3c" }],
    tools: [{ id: "t1", name: "归档采购计划", publicName: "save_purchase_plan" }],
  },
  effective: {
    toggles: { webSearch: true, fsSearch: true, strReplaceEditor: true, todo: true, compaction: true },
    mcpServers: ["filesystem"],
  },
};

describe("运行详情的设置快照解析", () => {
  it("三层齐全时原样还原：工作流只带写了覆盖的键，集合项保留名字与公名/slug", () => {
    const snap = asRunSettingsSnapshot(full);
    expect(snap).not.toBeNull();
    expect(snap?.effective.toggles.webSearch).toBe(true);
    expect(snap?.global.toggles.webSearch).toBe(false);
    expect(snap?.workflow.settings.toggles).toEqual({ webSearch: true });
    expect(snap?.workflow.settings.mcpServers).toEqual(["filesystem", "unregistered"]);
    expect(snap?.effective.mcpServers).toEqual(["filesystem"]);
    expect(snap?.workflow.skills).toEqual([
      { id: "s1", name: "集采计划编制规范", slug: "skill-1a2b3c" },
    ]);
    expect(snap?.workflow.tools).toEqual([
      { id: "t1", name: "归档采购计划", publicName: "save_purchase_plan" },
    ]);
    expect(snap?.global.disabledTools).toEqual(["bash"]);
    expect(snap?.workflow.instructionsSha256).toBe("b".repeat(64));
  });

  it("早于三层设置的运行（null）或缺层的对象都当作没有快照", () => {
    expect(asRunSettingsSnapshot(null)).toBeNull();
    expect(asRunSettingsSnapshot(undefined)).toBeNull();
    expect(asRunSettingsSnapshot("{}")).toBeNull();
    expect(asRunSettingsSnapshot({ global: full.global, workflow: full.workflow })).toBeNull();
  });

  it("字段形状不对时逐项退化而不是整体丢弃：非布尔开关按关、非字符串项被过滤", () => {
    const snap = asRunSettingsSnapshot({
      global: { toggles: { webSearch: "yes" }, mcpServers: ["a", 1, null], disabledTools: "bash" },
      workflow: { settings: { toggles: { fsSearch: "no" } }, skills: [{ id: 1 }], tools: "x" },
      effective: { toggles: null, mcpServers: null },
    });
    expect(snap?.global.toggles.webSearch).toBe(false);
    expect(snap?.global.mcpServers).toEqual(["a"]);
    expect(snap?.global.disabledTools).toEqual([]);
    expect(snap?.workflow.settings.toggles).toEqual({});
    expect(snap?.workflow.skills).toEqual([{ id: "", name: "", slug: "" }]);
    expect(snap?.workflow.tools).toEqual([]);
    expect(snap?.effective.toggles.compaction).toBe(false);
    expect(snap?.effective.mcpServers).toEqual([]);
  });
});
