import { describe, expect, it } from "vitest";
import type { ResolvedPort } from "@/lib/graph";
import type { RunGraph, RunGraphNode } from "@/lib/run-graph";
import type { RunNodeRoundRow, RunNodeRow, RunRow } from "../lib";
import { currentRoundOf, visualsAt } from "./visuals-at";

const T0 = 1_700_000_000_000;
/** 秒 → 绝对毫秒，测试里所有时刻都写成「第几秒」 */
const at = (second: number): number => T0 + second * 1000;

function port(name: string, exitName: string | null = null): ResolvedPort {
  return {
    name,
    objectTypeId: `type-${name}`,
    objectTypeName: name,
    kind: "text",
    exitName,
    artifactPath: null,
  };
}

function graphNode(
  id: string,
  kind: RunGraphNode["kind"],
  outputs: ResolvedPort[] = [],
  inputs: ResolvedPort[] = [],
): RunGraphNode {
  return { id, kind, label: id, x: 0, y: 0, actionId: null, objectTypeId: null, inputs, outputs };
}

function graph(nodes: RunGraphNode[], edges: RunGraph["edges"] = []): RunGraph {
  return { version: 1, nodes, edges };
}

function edge(id: string, sourceNodeId: string, sourcePort: string, targetNodeId: string) {
  return { id, sourceNodeId, sourcePort, targetNodeId, targetPort: "value" };
}

function makeRun(g: RunGraph, overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-1",
    workflowId: "wf-1",
    workflowName: "工作流",
    status: "success",
    error: null,
    runDir: "data/runs/run-1",
    startedAt: at(0),
    finishedAt: at(60),
    graph: g,
    ...overrides,
  };
}

function nodeRow(nodeId: string, overrides: Partial<RunNodeRow> = {}): RunNodeRow {
  return {
    id: `rn-${nodeId}`,
    runId: "run-1",
    nodeId,
    label: nodeId,
    status: "success",
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    startedAt: at(0),
    finishedAt: at(10),
    ...overrides,
  };
}

function roundRow(
  nodeId: string,
  round: number,
  startedSecond: number,
  finishedSecond: number | null,
  overrides: Partial<RunNodeRoundRow> = {},
): RunNodeRoundRow {
  return {
    id: `${nodeId}-${round}`,
    runId: "run-1",
    nodeId,
    round,
    sessionId: round === 0 ? nodeId : `${nodeId}#${round + 1}`,
    status: "success",
    startedAt: at(startedSecond),
    finishedAt: finishedSecond == null ? null : at(finishedSecond),
    exitName: null,
    error: null,
    ...overrides,
  };
}

describe("visualsAt：节点在光标时刻的状态", () => {
  const g = graph(
    [graphNode("a", "action", [port("out")]), graphNode("b", "action", [], [port("value")])],
    [edge("e1", "a", "out", "b")],
  );
  const nodes = [
    nodeRow("a", { startedAt: at(0), finishedAt: at(10), outputTokens: 100, cost: 0.5 }),
    nodeRow("b", { startedAt: at(10), finishedAt: at(20), outputTokens: 50, cost: 0.25 }),
  ];
  const rounds = [roundRow("a", 0, 0, 10), roundRow("b", 0, 10, 20)];
  const base = { run: makeRun(g), nodes, rounds, events: [] };

  it("轮次还没开始就是等待，连线未激活", () => {
    const v = visualsAt({ ...base, t: at(-1) });
    expect(v.nodes.a!.status).toBe("pending");
    expect(v.nodes.a!.round).toBeNull();
    expect(v.nodes.b!.status).toBe("pending");
    expect(v.edges.e1!.state).toBe("idle");
    expect(v.totals.byStatus.pending).toBe(2);
    expect(v.totals.done).toBe(0);
  });

  it("光标落在轮次里是运行中，用量还不显示", () => {
    const v = visualsAt({ ...base, t: at(5) });
    expect(v.nodes.a!.status).toBe("running");
    expect(v.nodes.a!.round).toBe(0);
    expect(v.nodes.a!.finishedAt).toBeNull();
    expect(v.nodes.a!.tokens).toBeNull();
    expect(v.edges.e1!.state).toBe("idle");
  });

  it("上游收束、下游在跑时连线是流动态，收束后是已流过", () => {
    const flowing = visualsAt({ ...base, t: at(12) });
    expect(flowing.nodes.a!.status).toBe("success");
    expect(flowing.nodes.a!.tokens).toBe(100);
    expect(flowing.nodes.b!.status).toBe("running");
    expect(flowing.edges.e1!.state).toBe("flowing");

    const done = visualsAt({ ...base, t: at(30) });
    expect(done.nodes.b!.status).toBe("success");
    expect(done.edges.e1!.state).toBe("flowed");
    expect(done.totals.done).toBe(2);
    expect(done.totals.tokens).toBe(150);
    expect(done.totals.cost).toBeCloseTo(0.75);
  });
});

describe("visualsAt：出口与回边", () => {
  // 写作 w → 评审 r（出口 通过 / 打回）；打回回边指向 w，通过指向输出节点 out
  const g = graph(
    [
      graphNode("w", "action", [port("稿件")], [port("value")]),
      graphNode("r", "action", [port("通过", "通过"), port("打回", "打回")], [port("value")]),
      graphNode("out", "output", [], [port("value")]),
    ],
    [
      edge("e-w-r", "w", "稿件", "r"),
      edge("e-pass", "r", "通过", "out"),
      edge("e-back", "r", "打回", "w"),
    ],
  );
  const nodes = [
    nodeRow("w", { startedAt: at(10), finishedAt: at(15) }),
    nodeRow("r", { startedAt: at(15), finishedAt: at(20) }),
    nodeRow("out", { startedAt: at(20), finishedAt: at(20) }),
  ];
  const rounds = [
    roundRow("w", 0, 0, 5),
    roundRow("r", 0, 5, 10, { exitName: "打回" }),
    roundRow("out", 0, 10, 10, { status: "skipped", sessionId: null }),
    roundRow("w", 1, 10, 15),
    roundRow("r", 1, 15, 20, { exitName: "通过" }),
    roundRow("out", 1, 20, 20, { sessionId: null }),
  ];
  const base = { run: makeRun(g), nodes, rounds, events: [] };

  it("没走的出口那条线是断的，走了的那条才激活", () => {
    const v = visualsAt({ ...base, t: at(12) });
    expect(v.nodes.r!.round).toBe(0);
    expect(v.edges["e-back"]!.state).toBe("flowing"); // 打回后 w 正在跑第 2 轮
    expect(v.edges["e-pass"]!.state).toBe("blocked");
  });

  it("光标落在两轮之间时状态与连线都取第 1 轮", () => {
    const v = visualsAt({ ...base, t: at(12) });
    expect(v.nodes.w!.status).toBe("running");
    expect(v.nodes.w!.round).toBe(1);
    expect(v.nodes.out!.status).toBe("skipped");
    expect(v.nodes.out!.round).toBe(0);
  });

  it("评审循环里的输出节点第 2 轮成功", () => {
    const v = visualsAt({ ...base, t: at(25) });
    expect(v.nodes.out!.status).toBe("success");
    expect(v.nodes.out!.round).toBe(1);
    expect(v.edges["e-pass"]!.state).toBe("flowed");
    expect(v.edges["e-back"]!.state).toBe("blocked");
  });

  it("重入耗尽：最后一轮成功，节点在耗尽时刻翻成失败", () => {
    const exhausted = {
      ...base,
      nodes: [
        nodeRow("w", {
          status: "failed",
          startedAt: at(10),
          finishedAt: at(22),
          error: "重入次数已耗尽",
        }),
        ...nodes.slice(1),
      ],
    };
    const before = visualsAt({ ...exhausted, t: at(21) });
    expect(before.nodes.w!.status).toBe("success");
    const after = visualsAt({ ...exhausted, t: at(23) });
    expect(after.nodes.w!.status).toBe("failed");
    expect(after.nodes.w!.error).toBe("重入次数已耗尽");
  });
});

describe("visualsAt：取消与免费运行", () => {
  it("取消把进行中的轮收口成 cancelled，未开始的节点落成 skipped", () => {
    const g = graph(
      [graphNode("a", "action", [port("out")]), graphNode("b", "action", [], [port("value")])],
      [edge("e1", "a", "out", "b")],
    );
    const input = {
      run: makeRun(g, { status: "cancelled" as const, finishedAt: at(8) }),
      nodes: [
        nodeRow("a", { status: "cancelled", startedAt: at(0), finishedAt: at(8) }),
        nodeRow("b", { status: "skipped", startedAt: null, finishedAt: at(8) }),
      ],
      rounds: [
        roundRow("a", 0, 0, 8, { status: "cancelled" }),
        roundRow("b", 0, 8, 8, { status: "skipped", sessionId: null }),
      ],
      events: [],
    };
    const during = visualsAt({ ...input, t: at(5) });
    expect(during.nodes.a!.status).toBe("running");
    expect(during.nodes.b!.status).toBe("pending");

    const after = visualsAt({ ...input, t: at(9) });
    expect(after.nodes.a!.status).toBe("cancelled");
    expect(after.nodes.b!.status).toBe("skipped");
    expect(after.edges.e1!.state).toBe("blocked");
  });

  it("输入→输出的免费运行：两个节点各一行轮次，都成功，连线激活", () => {
    const g = graph(
      [graphNode("in", "input", [port("value")]), graphNode("out", "output", [], [port("value")])],
      [edge("e1", "in", "value", "out")],
    );
    const input = {
      run: makeRun(g, { finishedAt: at(1) }),
      nodes: [
        nodeRow("in", { startedAt: at(0), finishedAt: at(0) }),
        nodeRow("out", { startedAt: at(1), finishedAt: at(1) }),
      ],
      rounds: [
        roundRow("in", 0, 0, 0, { sessionId: null }),
        roundRow("out", 0, 1, 1, { sessionId: null }),
      ],
      events: [],
    };
    const v = visualsAt({ ...input, t: at(2) });
    expect(v.nodes.in!.status).toBe("success");
    expect(v.nodes.out!.status).toBe("success");
    expect(v.edges.e1!.state).toBe("flowed");
    expect(v.totals.done).toBe(2);
  });
});

describe("visualsAt：活动与退化", () => {
  const g = graph([graphNode("a", "action", [port("out")])]);
  const nodes = [nodeRow("a", { sessionId: "a", startedAt: at(0), finishedAt: at(10) })];
  const rounds = [roundRow("a", 0, 0, 10)];

  it("活动只认属于当前轮会话、且不晚于光标的事件", () => {
    const events = [
      {
        id: 1,
        runId: "run-1",
        nodeId: "a",
        sessionId: "a",
        ts: at(1),
        type: "text",
        payload: { text: "四个字" },
      },
      {
        id: 2,
        runId: "run-1",
        nodeId: "a",
        sessionId: "a",
        ts: at(2),
        type: "tool",
        payload: { tool: "bash", status: "running" },
      },
      {
        id: 3,
        runId: "run-1",
        nodeId: "a",
        sessionId: "a#2",
        ts: at(3),
        type: "text",
        payload: { text: "下一轮" },
      },
      {
        id: 4,
        runId: "run-1",
        nodeId: "a",
        sessionId: "a",
        ts: at(9),
        type: "text",
        payload: { text: "以后" },
      },
    ];
    const v = visualsAt({ run: makeRun(g), nodes, rounds, events, t: at(5) });
    expect(v.nodes.a!.activity).toEqual({
      chars: 3,
      reasoningChars: 0,
      tool: "bash",
      toolStatus: "running",
      lastKind: "tool",
      updatedAt: at(2),
    });
  });

  it("事件缺失（已清理或早于会话归属列）时退化为轮次级，活动为 null", () => {
    const cleaned = visualsAt({ run: makeRun(g), nodes, rounds, events: [], t: at(5) });
    expect(cleaned.nodes.a!.activity).toBeNull();
    expect(cleaned.nodes.a!.status).toBe("running");

    const legacy = visualsAt({
      run: makeRun(g),
      nodes,
      rounds,
      events: [
        { id: 1, runId: "run-1", nodeId: "a", ts: at(1), type: "text", payload: { text: "旧行" } },
      ],
      t: at(5),
    });
    expect(legacy.nodes.a!.activity).toBeNull();
  });

  it("早于轮次表的运行没有轮次行，节点恒为等待", () => {
    const v = visualsAt({
      run: makeRun(graph([])),
      nodes: [
        nodeRow("a", { startedAt: at(0), finishedAt: at(10) }),
        nodeRow("b", { startedAt: at(10), finishedAt: at(20) }),
      ],
      rounds: [],
      events: [],
      t: at(3600),
    });
    expect(v.nodes.a!.status).toBe("pending");
    expect(v.nodes.b!.status).toBe("pending");
    expect(v.totals.byStatus.pending).toBe(2);
    expect(v.totals.nodes).toBe(2);
  });
});

describe("currentRoundOf", () => {
  const rounds = [roundRow("a", 0, 0, 5), roundRow("a", 1, 10, 15), roundRow("b", 0, 5, 10)];

  it("取在光标之前最后开始的那一轮", () => {
    expect(currentRoundOf(rounds, "a", at(-1))).toBeNull();
    expect(currentRoundOf(rounds, "a", at(7))?.round).toBe(0);
    expect(currentRoundOf(rounds, "a", at(12))?.round).toBe(1);
    expect(currentRoundOf(rounds, "b", at(99))?.round).toBe(0);
  });

  it("同一毫秒开始的两行按轮次号取大的：零时长的 skipped 行与紧接着的重入行", () => {
    const sameInstant = [
      roundRow("x", 0, 10, 10, { status: "skipped", sessionId: null }),
      roundRow("x", 1, 10, 20),
    ];
    expect(currentRoundOf(sameInstant, "x", at(10))?.round).toBe(1);

    const v = visualsAt({
      run: makeRun(graph([graphNode("x", "action", [port("out")])])),
      nodes: [nodeRow("x", { startedAt: at(10), finishedAt: at(20) })],
      rounds: sameInstant,
      events: [],
      t: at(15),
    });
    expect(v.nodes.x!.round).toBe(1);
    expect(v.nodes.x!.status).toBe("running");
  });
});
