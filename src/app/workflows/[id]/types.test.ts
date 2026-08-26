import { describe, expect, it } from "vitest";
import {
  actionPortSnapshots,
  sourceExitName,
  type ActionDto,
  type FlowNodeData,
} from "./types";

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
  skillIds: [],
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
