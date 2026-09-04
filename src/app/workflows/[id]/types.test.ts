import { describe, expect, it } from "vitest";
import {
  actionNamesByEntity,
  actionPortSnapshots,
  fromToggleChoice,
  outsideSet,
  pickBySet,
  pruneToggles,
  skillTokenEstimate,
  toggleChoice,
  toggleId,
  toolTokenEstimate,
  type NodeDto,
} from "./types";
import { sourceExitName, type FlowNodeData } from "@/components/canvas/node-model";
import type { ActionDto } from "@/components/library";

const action: ActionDto = {
  id: "decision",
  name: "裁决",
  description: "",
  prompt: "",
  rule: "",
  modelId: "model",
  reasoningEffort: "low",
  maxReentries: 0,
  onExhausted: "fail",
  ports: [
    {
      id: "in",
      direction: "input",
      name: "草稿",
      objectTypeId: "document",
      objectTypeName: "文档",
      kind: "file",
      position: 0,
      artifactPath: null,
      exitName: null,
    },
    {
      id: "pass",
      direction: "output",
      name: "成品",
      objectTypeId: "document",
      objectTypeName: "文档",
      kind: "file",
      position: 0,
      artifactPath: "final.md",
      exitName: "通过",
    },
    {
      id: "reject",
      direction: "output",
      name: "意见",
      objectTypeId: "document",
      objectTypeName: "文档",
      kind: "file",
      position: 1,
      artifactPath: "feedback.md",
      exitName: "打回",
    },
  ],
  preloadSkillIds: [],
  toolIds: [],
};

describe("工作流出口标签", () => {
  it("把 Action 的具名出口保留到画布端口快照", () => {
    const snapshots = actionPortSnapshots(action);

    expect(snapshots.inputs[0]?.exitName).toBeNull();
    expect(snapshots.outputs.map((port) => [port.name, port.exitName])).toEqual([
      ["成品", "通过"],
      ["意见", "打回"],
    ]);
  });

  it("按连线的源端口派生情况名，普通出口不产生标签", () => {
    const snapshots = actionPortSnapshots(action);
    const data: FlowNodeData = {
      kind: "action",
      actionId: action.id,
      objectTypeId: null,
      label: action.name,
      inputs: snapshots.inputs,
      outputs: [
        ...snapshots.outputs,
        {
          name: "普通产物",
          objectTypeId: "document",
          objectTypeName: "文档",
          kind: "file",
          exitName: null,
        },
      ],
    };

    expect(sourceExitName(data, "成品")).toBe("通过");
    expect(sourceExitName(data, "意见")).toBe("打回");
    expect(sourceExitName(data, "普通产物")).toBeNull();
    expect(sourceExitName(data, "不存在")).toBeNull();
  });
});

describe("工作流设置的三态开关", () => {
  it("未写覆盖显示为继承，写了的按布尔映射并能原样还原", () => {
    expect(toggleChoice(undefined)).toBe("inherit");
    expect(toggleChoice(true)).toBe("on");
    expect(toggleChoice(false)).toBe("off");
    for (const choice of ["inherit", "on", "off"] as const) {
      expect(toggleChoice(fromToggleChoice(choice))).toBe(choice);
    }
  });

  it("载荷只保留写了覆盖的键，未知键与 undefined 一律丢弃", () => {
    const toggles = pruneToggles({
      webSearch: true,
      todo: undefined,
      compaction: false,
      ...({ bogus: true } as object),
    });
    expect(toggles).toEqual({ webSearch: true, compaction: false });
    expect(Object.keys(toggles)).not.toContain("bogus");
  });
});

describe("按工作流集合收窄候选", () => {
  const rows = [
    { id: "a", name: "甲" },
    { id: "b", name: "乙" },
    { id: "c", name: "丙" },
  ];

  it("候选按集合顺序排列，集合里库中已没有的 id 跳过", () => {
    expect(pickBySet(rows, ["c", "missing", "a"]).map((r) => r.name)).toEqual(["丙", "甲"]);
    expect(pickBySet(rows, [])).toEqual([]);
  });

  it("越出集合的已选项被点名，切换 id 保序不重复", () => {
    expect(outsideSet(["a", "c", "b"], ["a", "b"])).toEqual(["c"]);
    expect(outsideSet([], ["a"])).toEqual([]);
    expect(toggleId(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(toggleId(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });
});

describe("集合项旁的 token 估算", () => {
  it("技能按 SKILL.md 正文估算，Tool 按公名、描述与参数 schema 估算", () => {
    expect(skillTokenEstimate({ content: "" })).toBe(0);
    expect(skillTokenEstimate({ content: "abcdefgh" })).toBe(2);

    const bare = toolTokenEstimate({
      publicName: "run_python",
      description: "",
      parameters: {},
    });
    const described = toolTokenEstimate({
      publicName: "run_python",
      description: "在沙箱里执行一段 Python 脚本",
      parameters: { type: "object", properties: { code: { type: "string" } } },
    });
    expect(bare).toBeGreaterThan(0);
    expect(described).toBeGreaterThan(bare);
  });
});

describe("画布 Action 对集合项的使用", () => {
  it("按技能 / Tool 汇总预载与可见它的 Action 名，同一 Action 放多个节点只算一次", () => {
    const parse: ActionDto = {
      ...action,
      id: "parse",
      name: "解析",
      preloadSkillIds: ["s2"],
      toolIds: ["t1"],
    };
    const judge: ActionDto = {
      ...action,
      preloadSkillIds: ["s1", "s2"],
      toolIds: [],
    };
    const nodes: NodeDto[] = [
      { id: "n1", kind: "input", objectTypeId: "document", label: "", x: 0, y: 0 },
      { id: "n2", kind: "action", actionId: "decision", label: "", x: 0, y: 0 },
      { id: "n3", kind: "action", actionId: "decision", label: "", x: 0, y: 0 },
      { id: "n4", kind: "action", actionId: "parse", label: "", x: 0, y: 0 },
      { id: "n5", kind: "action", actionId: "deleted", label: "", x: 0, y: 0 },
    ];
    const actionById = new Map<string, ActionDto>([
      [judge.id, judge],
      [parse.id, parse],
    ]);

    const preloadedBy = actionNamesByEntity(nodes, actionById, "preloadSkillIds");
    expect(preloadedBy.get("s1")).toEqual(["裁决"]);
    expect(preloadedBy.get("s2")).toEqual(["裁决", "解析"]);
    expect(preloadedBy.has("t1")).toBe(false);

    const visibleTo = actionNamesByEntity(nodes, actionById, "toolIds");
    expect(visibleTo.get("t1")).toEqual(["解析"]);
    expect(visibleTo.size).toBe(1);
  });
});
