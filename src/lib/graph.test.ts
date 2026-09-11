import { describe, expect, it } from "vitest";
import {
  classifyEdges,
  connectionProblem,
  downstreamOf,
  exitsOf,
  hasNamedExits,
  validateGraph,
  type GraphEdge,
  type ResolvedNode,
} from "./graph";

const TYPE_A = { objectTypeId: "t-a", objectTypeName: "甲", kind: "text" as const };
const TYPE_B = { objectTypeId: "t-b", objectTypeName: "乙", kind: "text" as const };

describe("候选连线与整图规则一致", () => {
  const nodes: ResolvedNode[] = [
    { id: "in", kind: "input", label: "输入", inputs: [], outputs: [{ name: "value", ...TYPE_A }] },
    {
      id: "draft",
      kind: "action",
      label: "起草",
      maxReentries: 2,
      inputs: [
        { name: "x", ...TYPE_A },
        { name: "feedback", ...TYPE_A },
      ],
      outputs: [{ name: "y", ...TYPE_A }],
    },
    {
      id: "review",
      kind: "action",
      label: "评审",
      inputs: [{ name: "x", ...TYPE_A }],
      outputs: [{ name: "y", ...TYPE_A }],
    },
    {
      id: "wrong",
      kind: "output",
      label: "异型",
      inputs: [{ name: "value", ...TYPE_B }],
      outputs: [],
    },
  ];
  const initial = [
    edge("first", "in", "value", "draft", "x"),
    edge("second", "draft", "y", "review", "x"),
  ];

  it("未连齐的图仍可添加扇出与同口汇总，不把已有连线当作占用", () => {
    expect(
      connectionProblem(nodes, initial, edge("synthesis", "in", "value", "review", "x")),
    ).toBeUndefined();
  });

  it("合法回边可添加，零上限的回边指出要修改的节点", () => {
    const back = edge("back", "review", "y", "draft", "feedback");
    expect(connectionProblem(nodes, initial, back)).toBeUndefined();
    expect(
      connectionProblem(
        nodes.map((n) => ({ ...n, maxReentries: 0 })),
        initial,
        back,
      ),
    ).toMatchObject({
      nodeId: "draft",
      edgeId: "back",
      message: expect.stringContaining("重入上限"),
    });
  });

  it("拒绝重复、异型与失效端口，原因来自共享校验", () => {
    for (const [candidate, message] of [
      [edge("duplicate", "in", "value", "draft", "x"), "已经有连线"],
      [edge("mismatch", "in", "value", "wrong", "value"), "类型不匹配"],
      [edge("missing", "in", "missing", "draft", "x"), "没有输出端口"],
    ] as const) {
      expect(connectionProblem(nodes, initial, candidate)?.message).toContain(message);
      expect(
        validateGraph(nodes, [...initial, candidate]).some(
          (issue) => issue.edgeId === candidate.id && issue.message.includes(message),
        ),
      ).toBe(true);
    }
  });

  it("新增正向边把已有边变成非法回边时同样拒绝", () => {
    const prior = [initial[0], edge("return", "review", "y", "draft", "feedback")];
    const noLimit = nodes.map((n) => ({ ...n, maxReentries: 0 }));
    expect(connectionProblem(noLimit, prior, initial[1])?.message).toContain("重入上限");
  });
});

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
    const edges = [edge("e1", "in", "value", "a1", "x"), edge("e2", "a1", "y", "out", "value")];
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
    const nodes = [actionNode("a1", [{ name: "x", type: TYPE_A }], [{ name: "y", type: TYPE_A }])];
    const issues = validateGraph(nodes, []);
    expect(issues.some((i) => i.message.includes("未连线"))).toBe(true);
  });

  it("允许一个输入端口接多条入线——那就是汇总", () => {
    const nodes = [
      inputNode("in1", TYPE_A),
      inputNode("in2", TYPE_A),
      actionNode("a", [{ name: "x", type: TYPE_A }], [{ name: "y", type: TYPE_A }]),
      outputNode("out", TYPE_A),
    ];
    const edges = [
      edge("e1", "in1", "value", "a", "x"),
      edge("e2", "in2", "value", "a", "x"),
      edge("e3", "a", "y", "out", "value"),
    ];
    expect(validateGraph(nodes, edges)).toEqual([]);
  });

  it("允许回边，只要被回流的节点声明了重入上限", () => {
    const fix = actionNode("fix", [{ name: "x", type: TYPE_A }], [{ name: "y", type: TYPE_A }]);
    fix.maxReentries = 3;
    fix.onExhausted = "fail";
    const review = actionNode(
      "review",
      [{ name: "x", type: TYPE_A }],
      [
        { name: "通过", type: TYPE_A },
        { name: "打回", type: TYPE_A },
      ],
    );
    review.outputs[0].exitName = "通过";
    review.outputs[1].exitName = "打回";
    const nodes = [inputNode("in", TYPE_A), fix, review, outputNode("out", TYPE_A)];
    const edges = [
      edge("e1", "in", "value", "fix", "x"),
      edge("e2", "fix", "y", "review", "x"),
      edge("e3", "review", "打回", "fix", "x"),
      edge("e4", "review", "通过", "out", "value"),
    ];
    expect(validateGraph(nodes, edges)).toEqual([]);
  });

  it("回边的目标没有重入上限时报错", () => {
    const fix = actionNode("fix", [{ name: "x", type: TYPE_A }], [{ name: "y", type: TYPE_A }]);
    const review = actionNode(
      "review",
      [{ name: "x", type: TYPE_A }],
      [{ name: "y", type: TYPE_A }],
    );
    const nodes = [inputNode("in", TYPE_A), fix, review];
    const edges = [
      edge("e1", "in", "value", "fix", "x"),
      edge("e2", "fix", "y", "review", "x"),
      edge("e3", "review", "y", "fix", "x"),
    ];
    const issues = validateGraph(nodes, edges);
    expect(issues.some((i) => i.message.includes("重入上限"))).toBe(true);
  });

  it("具名出口必须全有或全无", () => {
    const a = actionNode(
      "a",
      [{ name: "x", type: TYPE_A }],
      [
        { name: "p", type: TYPE_A },
        { name: "q", type: TYPE_A },
      ],
    );
    a.outputs[0].exitName = "通过";
    const nodes = [inputNode("in", TYPE_A), a];
    const edges = [edge("e1", "in", "value", "a", "x")];
    const issues = validateGraph(nodes, edges);
    expect(issues.some((i) => i.message.includes("要么都归属"))).toBe(true);
  });

  it("拒绝指向不存在端口的连线", () => {
    const nodes = [inputNode("in", TYPE_A), actionNode("a1", [{ name: "x", type: TYPE_A }], [])];
    const edges = [edge("e1", "in", "nope", "a1", "x")];
    const issues = validateGraph(nodes, edges);
    expect(issues.some((i) => i.message.includes("没有输出端口"))).toBe(true);
  });
});

describe("classifyEdges", () => {
  it("把指向仍在栈上的节点的边判为回边，且判定稳定", () => {
    const nodes = [
      inputNode("in", TYPE_A),
      actionNode("fix", [{ name: "x", type: TYPE_A }], [{ name: "y", type: TYPE_A }]),
      actionNode("review", [{ name: "x", type: TYPE_A }], [{ name: "y", type: TYPE_A }]),
    ];
    const edges = [
      edge("e1", "in", "value", "fix", "x"),
      edge("e2", "fix", "y", "review", "x"),
      edge("e3", "review", "y", "fix", "x"),
    ];
    const first = classifyEdges(nodes, edges).backEdgeIds;
    expect([...first]).toEqual(["e3"]);
    // 边的输入顺序不影响判定结果
    const shuffled = classifyEdges(nodes, [edges[2], edges[0], edges[1]]).backEdgeIds;
    expect([...shuffled]).toEqual(["e3"]);
  });

  it("无环图没有回边", () => {
    const nodes = [
      inputNode("in", TYPE_A),
      actionNode("a", [{ name: "x", type: TYPE_A }], [{ name: "y", type: TYPE_A }]),
      outputNode("out", TYPE_A),
    ];
    const edges = [edge("e1", "in", "value", "a", "x"), edge("e2", "a", "y", "out", "value")];
    expect(classifyEdges(nodes, edges).backEdgeIds.size).toBe(0);
  });
});

describe("exitsOf", () => {
  it("默认出口在前，具名出口按名字排序", () => {
    const node = actionNode(
      "a",
      [],
      [
        { name: "p", type: TYPE_A },
        { name: "q", type: TYPE_A },
      ],
    );
    node.outputs[0].exitName = "打回";
    node.outputs[1].exitName = "通过";
    expect(exitsOf(node).map((e) => e.name)).toEqual(["打回", "通过"]);
    expect(hasNamedExits(node)).toBe(true);
  });

  it("没有具名出口时归入唯一的默认出口", () => {
    const node = actionNode(
      "a",
      [],
      [
        { name: "p", type: TYPE_A },
        { name: "q", type: TYPE_A },
      ],
    );
    const exits = exitsOf(node);
    expect(exits).toHaveLength(1);
    expect(exits[0].name).toBeNull();
    expect(exits[0].ports).toHaveLength(2);
    expect(hasNamedExits(node)).toBe(false);
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
