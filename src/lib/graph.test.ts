import { describe, expect, it } from "vitest";
import {
  downstreamOf,
  topologicalOrder,
  validateGraph,
  type GraphEdge,
  type ResolvedNode,
} from "./graph";

const TYPE_A = { objectTypeId: "t-a", objectTypeName: "甲", kind: "text" as const };
const TYPE_B = { objectTypeId: "t-b", objectTypeName: "乙", kind: "text" as const };

function actionNode(
  id: string,
  inputs: Array<{ name: string; type: typeof TYPE_A }>,
  outputs: Array<{ name: string; type: typeof TYPE_A }>,
): ResolvedNode {
  return {
    id,
    kind: "action",
    label: id,
    inputs: inputs.map((p) => ({ name: p.name, ...p.type })),
    outputs: outputs.map((p) => ({ name: p.name, ...p.type })),
  };
}

function inputNode(id: string, type: typeof TYPE_A): ResolvedNode {
  return {
    id,
    kind: "input",
    label: id,
    inputs: [],
    outputs: [{ name: "value", ...type }],
  };
}

function outputNode(id: string, type: typeof TYPE_A): ResolvedNode {
  return {
    id,
    kind: "output",
    label: id,
    inputs: [{ name: "value", ...type }],
    outputs: [],
  };
}

function edge(
  id: string,
  source: string,
  sourcePort: string,
  target: string,
  targetPort: string,
): GraphEdge {
  return { id, sourceNodeId: source, sourcePort, targetNodeId: target, targetPort };
}

describe("validateGraph", () => {
  it("接受类型匹配的合法链路", () => {
    const nodes = [
      inputNode("in", TYPE_A),
      actionNode("a1", [{ name: "x", type: TYPE_A }], [{ name: "y", type: TYPE_B }]),
      outputNode("out", TYPE_B),
    ];
    const edges = [
      edge("e1", "in", "value", "a1", "x"),
      edge("e2", "a1", "y", "out", "value"),
    ];
    expect(validateGraph(nodes, edges)).toEqual([]);
  });

  it("拒绝不同 Object Type 的连线（nominal typing）", () => {
    const nodes = [
      inputNode("in", TYPE_A),
      actionNode("a1", [{ name: "x", type: TYPE_B }], [{ name: "y", type: TYPE_B }]),
    ];
    const edges = [edge("e1", "in", "value", "a1", "x")];
    const issues = validateGraph(nodes, edges);
    expect(issues.some((i) => i.message.includes("类型不匹配"))).toBe(true);
  });

  it("拒绝未连线的输入端口", () => {
    const nodes = [
      actionNode("a1", [{ name: "x", type: TYPE_A }], [{ name: "y", type: TYPE_A }]),
    ];
    const issues = validateGraph(nodes, []);
    expect(issues.some((i) => i.message.includes("未连线"))).toBe(true);
  });

  it("拒绝一个输入端口多条入线", () => {
    const nodes = [
      inputNode("in1", TYPE_A),
      inputNode("in2", TYPE_A),
      actionNode("a1", [{ name: "x", type: TYPE_A }], []),
    ];
    const edges = [
      edge("e1", "in1", "value", "a1", "x"),
      edge("e2", "in2", "value", "a1", "x"),
    ];
    const issues = validateGraph(nodes, edges);
    expect(issues.some((i) => i.message.includes("最多 1 条"))).toBe(true);
  });

  it("拒绝环路", () => {
    const nodes = [
      actionNode("a1", [{ name: "x", type: TYPE_A }], [{ name: "y", type: TYPE_A }]),
      actionNode("a2", [{ name: "x", type: TYPE_A }], [{ name: "y", type: TYPE_A }]),
    ];
    const edges = [
      edge("e1", "a1", "y", "a2", "x"),
      edge("e2", "a2", "y", "a1", "x"),
    ];
    const issues = validateGraph(nodes, edges);
    expect(issues.some((i) => i.message.includes("环路"))).toBe(true);
  });

  it("拒绝指向不存在端口的连线", () => {
    const nodes = [
      inputNode("in", TYPE_A),
      actionNode("a1", [{ name: "x", type: TYPE_A }], []),
    ];
    const edges = [edge("e1", "in", "nope", "a1", "x")];
    const issues = validateGraph(nodes, edges);
    expect(issues.some((i) => i.message.includes("没有输出端口"))).toBe(true);
  });
});

describe("topologicalOrder", () => {
  it("按依赖顺序返回，同层按 id 稳定排序", () => {
    const nodes = [
      inputNode("b-in", TYPE_A),
      inputNode("a-in", TYPE_A),
      actionNode("mid", [
        { name: "x", type: TYPE_A },
        { name: "z", type: TYPE_A },
      ], [{ name: "y", type: TYPE_A }]),
      outputNode("out", TYPE_A),
    ];
    const edges = [
      edge("e1", "a-in", "value", "mid", "x"),
      edge("e2", "b-in", "value", "mid", "z"),
      edge("e3", "mid", "y", "out", "value"),
    ];
    expect(topologicalOrder(nodes, edges)).toEqual([
      "a-in",
      "b-in",
      "mid",
      "out",
    ]);
  });
});

describe("downstreamOf", () => {
  it("返回传递闭包", () => {
    const edges = [
      edge("e1", "a", "y", "b", "x"),
      edge("e2", "b", "y", "c", "x"),
      edge("e3", "d", "y", "c", "x"),
    ];
    expect(downstreamOf("a", edges)).toEqual(new Set(["b", "c"]));
    expect(downstreamOf("c", edges)).toEqual(new Set());
  });
});
