/** 冻结图的构造与校验（ADR-0018）：坐标与实体引用来自节点行，端口来自解析结果。 */
import { describe, expect, it } from "vitest";
import { buildRunGraph, EMPTY_RUN_GRAPH, parseRunGraph, type RunGraph } from "./run-graph";
import type { ResolvedWorkflow } from "@/server/resolve";

function resolved(): ResolvedWorkflow {
  const now = new Date(0);
  const textPort = {
    name: "value",
    objectTypeId: "type-text",
    objectTypeName: "文本",
    kind: "text" as const,
  };
  return {
    workflow: {
      id: "workflow-1",
      name: "冻结图",
      description: "",
      instructions: "",
      settings: { toggles: {}, mcpServers: [] },
      createdAt: now,
      updatedAt: now,
    },
    settings: { toggles: {}, mcpServers: [] },
    subsetIssues: [],
    nodes: [
      { id: "input-node", kind: "input", label: "题目", inputs: [], outputs: [textPort] },
      {
        id: "action-node",
        kind: "action",
        label: "写码",
        inputs: [{ ...textPort, name: "题目" }],
        outputs: [
          { ...textPort, name: "定稿", exitName: "通过", artifactPath: "final.md" },
          { ...textPort, name: "意见", exitName: "不通过", artifactPath: "notes.md" },
        ],
        maxReentries: 1,
        onExhausted: "fail",
      },
      { id: "output-node", kind: "output", label: "产出", inputs: [textPort], outputs: [] },
    ],
    edges: [
      {
        id: "e1",
        sourceNodeId: "input-node",
        sourcePort: "value",
        targetNodeId: "action-node",
        targetPort: "题目",
      },
      {
        id: "e2",
        sourceNodeId: "action-node",
        sourcePort: "定稿",
        targetNodeId: "output-node",
        targetPort: "value",
      },
    ],
    nodeRows: new Map([
      [
        "input-node",
        {
          id: "input-node",
          workflowId: "workflow-1",
          kind: "input" as const,
          actionId: null,
          objectTypeId: "type-text",
          label: "题目",
          x: 10,
          y: 20,
        },
      ],
      [
        "action-node",
        {
          id: "action-node",
          workflowId: "workflow-1",
          kind: "action" as const,
          actionId: "action-1",
          objectTypeId: null,
          label: "写码",
          x: 200,
          y: 40,
        },
      ],
    ]),
    objectTypes: new Map(),
    actionDefinitions: new Map(),
    capabilities: { skills: [], tools: [], toolNamesByActionId: new Map() },
  };
}

describe("buildRunGraph", () => {
  it("坐标与实体引用取节点行，端口与出口名取解析结果", () => {
    const graph = buildRunGraph(resolved());

    expect(graph.version).toBe(1);
    expect(graph.nodes.map((n) => n.id)).toEqual(["input-node", "action-node", "output-node"]);

    const input = graph.nodes[0];
    expect(input).toMatchObject({ kind: "input", label: "题目", x: 10, y: 20 });
    expect(input.actionId).toBeNull();
    expect(input.objectTypeId).toBe("type-text");

    const action = graph.nodes[1];
    expect(action).toMatchObject({ kind: "action", actionId: "action-1", x: 200, y: 40 });
    expect(action.outputs.map((p) => [p.name, p.exitName, p.artifactPath])).toEqual([
      ["定稿", "通过", "final.md"],
      ["意见", "不通过", "notes.md"],
    ]);
    // 输入端口没有出口与产物路径，归一成 null 而不是缺席，序列化形状才稳定。
    expect(action.inputs[0]).toEqual({
      name: "题目",
      objectTypeId: "type-text",
      objectTypeName: "文本",
      kind: "text",
      exitName: null,
      artifactPath: null,
      jsonSchema: null,
    });

    // 图里没有对应节点行的节点仍然进图，只是没有坐标可画。
    expect(graph.nodes[2]).toMatchObject({ kind: "output", x: 0, y: 0, objectTypeId: null });
    expect(graph.edges.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("构造出的图能原样通过校验，且往返 JSON 不变形", () => {
    const graph = buildRunGraph(resolved());
    expect(parseRunGraph(JSON.parse(JSON.stringify(graph)))).toEqual(graph);
  });

  it("JSON 契约跟随受理端口冻结，往返持久化后不丢失", () => {
    const workflow = resolved();
    const port = workflow.nodes[1].outputs[0];
    port.kind = "json";
    port.jsonSchema = '{"type":"object","required":["items"]}';
    const graph = buildRunGraph(workflow);
    port.jsonSchema = '{"type":"array"}';
    const restored = parseRunGraph(JSON.parse(JSON.stringify(graph)));
    expect(restored.nodes[1].outputs[0].jsonSchema).toBe('{"type":"object","required":["items"]}');
  });
});

describe("parseRunGraph", () => {
  it("冻结图遗漏契约字段时拒绝读取，不解释成无契约", () => {
    const graph = buildRunGraph(resolved());
    delete graph.nodes[1].outputs[0].jsonSchema;
    expect(() => parseRunGraph(graph)).toThrow("缺少冻结的 jsonSchema 字段");
  });

  it("空图合法：早于本列的运行就是这张图，没有旧数据分支", () => {
    expect(parseRunGraph(EMPTY_RUN_GRAPH)).toEqual(EMPTY_RUN_GRAPH);
    expect(parseRunGraph(JSON.parse('{"version":1,"nodes":[],"edges":[]}'))).toEqual(
      EMPTY_RUN_GRAPH,
    );
  });

  const bad: Array<[string, unknown]> = [
    ["不是对象", 42],
    ["是数组", []],
    ["版本不是 1", { version: 2, nodes: [], edges: [] }],
    ["nodes 不是数组", { version: 1, nodes: {}, edges: [] }],
    ["edges 不是数组", { version: 1, nodes: [], edges: null }],
    [
      "节点 kind 非法",
      { version: 1, nodes: [{ id: "a", kind: "group", label: "", x: 0, y: 0 }], edges: [] },
    ],
    [
      "节点坐标不是数字",
      {
        version: 1,
        nodes: [
          {
            id: "a",
            kind: "input",
            label: "",
            x: "0",
            y: 0,
            actionId: null,
            objectTypeId: null,
            inputs: [],
            outputs: [],
          },
        ],
        edges: [],
      },
    ],
    [
      "端口 kind 非法",
      {
        version: 1,
        nodes: [
          {
            id: "a",
            kind: "input",
            label: "",
            x: 0,
            y: 0,
            actionId: null,
            objectTypeId: null,
            inputs: [],
            outputs: [{ name: "value", objectTypeId: "t", objectTypeName: "文本", kind: "binary" }],
          },
        ],
        edges: [],
      },
    ],
    ["连线缺字段", { version: 1, nodes: [], edges: [{ id: "e1", sourceNodeId: "a" }] }],
  ];

  it.each(bad)("坏数据抛错而不是画出半张图：%s", (_name, value) => {
    expect(() => parseRunGraph(value)).toThrow();
  });

  it("端口的出口与产物路径缺席时补 null，契约字段明确提供", () => {
    const parsed: RunGraph = parseRunGraph({
      version: 1,
      nodes: [
        {
          id: "a",
          kind: "output",
          label: "产出",
          x: 1,
          y: 2,
          actionId: null,
          objectTypeId: "t",
          inputs: [
            {
              name: "value",
              objectTypeId: "t",
              objectTypeName: "文本",
              kind: "text",
              jsonSchema: null,
            },
          ],
          outputs: [],
        },
      ],
      edges: [],
    });
    expect(parsed.nodes[0].inputs[0]).toEqual({
      name: "value",
      objectTypeId: "t",
      objectTypeName: "文本",
      kind: "text",
      exitName: null,
      artifactPath: null,
      jsonSchema: null,
    });
  });
});
