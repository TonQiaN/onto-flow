/**
 * 回放的时间模型（ADR-0018）：一条运行的全部事实 + 一个时间光标 `t`，推出那一刻
 * 每个节点处于哪一轮、什么状态、当下在干什么，以及每条连线是否已激活。
 *
 * 规则（DESIGN-V3 第 3 批）：
 * - 节点取**在 `t` 之前最后开始的那一轮**（同一毫秒开始的取轮次号大的）：`startedAt > t` 等待、
 *   `startedAt ≤ t < finishedAt` 运行中、`finishedAt ≤ t` 取该轮终态；
 *   没有任何轮次行的节点恒为等待（早于轮次表的运行整张图都是等待）。
 * - 在此之上叠加**节点终态覆盖**：**该节点有轮次行**、`run_nodes` 为 failed / cancelled 且其
 *   `finishedAt ≤ t` 时按该终态画——重入耗尽（最后一轮成功、节点在耗尽时刻翻失败）、整运行
 *   失败、取消都落在这条规则上，它们不属于任何一轮。「有轮次行」是前提：早于轮次表的运行
 *   一行轮次都没有，覆盖会把当时失败的运行画成失败、当时成功的运行画成等待，同一条历史被
 *   分成两副面孔；一律等待才是同一条规则。
 * - 连线在上游那一轮已成功收束、且该轮 `exitName` 与连线源端口的出口一致时激活；
 *   轮次没有具名出口（含输入节点）时该节点的全部输出端口生效。
 * - 活动只认 `session_id` 属于当前轮、且 `ts ≤ t` 的事件；事件被清理后退化为轮次级。
 *
 * 纯函数：不读 Date.now()、不碰 DOM，页面把光标喂进来。
 */
import type {
  CanvasEdgeVisual,
  CanvasNodeVisual,
  CanvasVisuals,
  EdgeFlowState,
  NodeActivity,
} from "@/components/canvas/node-visuals";
import { EMPTY_RUN_GRAPH } from "@/lib/run-graph";
import {
  sumTokens,
  toMillis,
  type NodeStatus,
  type RunEventRow,
  type RunNodeRoundRow,
  type RunNodeRow,
  type RunRow,
} from "../lib";

export interface VisualsAtInput {
  /** run.graph 是受理时冻结的图，已在数据边界（use-run-stream）过 parseRunGraph */
  run: RunRow | null;
  /** run_nodes：节点的最新状态行，只用于终态覆盖与用量 */
  nodes: RunNodeRow[];
  rounds: RunNodeRoundRow[];
  events: RunEventRow[];
  /** 时间光标（毫秒） */
  t: number;
}

/** 概要栏的总计：状态分布随光标走，token 与费用是整条运行的账，不随光标变 */
export interface RunVisualTotals {
  nodes: number;
  byStatus: Record<NodeStatus, number>;
  /** 已收束（success / failed / cancelled / skipped）的节点数 */
  done: number;
  tokens: number;
  cost: number;
}

export interface RunVisualsAt extends CanvasVisuals {
  totals: RunVisualTotals;
}

const EMPTY_ACTIVITY: NodeActivity = {
  chars: 0,
  reasoningChars: 0,
  tool: null,
  toolStatus: null,
  lastKind: null,
  updatedAt: 0,
};

function emptyByStatus(): Record<NodeStatus, number> {
  return { pending: 0, running: 0, success: 0, failed: 0, skipped: 0, cancelled: 0 };
}

/**
 * 轮次行按开始时刻排序；同一毫秒开始的两行按轮次号取大的——零时长的 skipped 行与紧接着
 * 的重入行可能落在同一毫秒，取小的会让回放停在已经翻过去的那一轮。
 */
function sortRounds(rounds: RunNodeRoundRow[]): RunNodeRoundRow[] {
  return [...rounds].sort((a, b) => {
    const ta = toMillis(a.startedAt) ?? 0;
    const tb = toMillis(b.startedAt) ?? 0;
    return ta === tb ? a.round - b.round : ta - tb;
  });
}

/**
 * 光标落在这个节点的哪一轮：在 `t` 之前最后开始的那一轮；都还没开始就是 null。
 * 抽屉的三个页签、时间轴的选中段与这里同一条规则，不各算一套。
 */
export function currentRoundOf(
  rounds: RunNodeRoundRow[],
  nodeId: string,
  t: number,
): RunNodeRoundRow | null {
  let hit: RunNodeRoundRow | null = null;
  for (const row of sortRounds(rounds.filter((r) => r.nodeId === nodeId))) {
    const started = toMillis(row.startedAt);
    if (started == null || started > t) break;
    hit = row;
  }
  return hit;
}

/** 该轮截至光标时刻的活动；轮次没有会话（输入/输出/跳过节点）或事件已清理时为 null */
function activityIn(events: RunEventRow[] | undefined, t: number): NodeActivity | null {
  if (!events) return null;
  let activity: NodeActivity | null = null;
  for (const event of events) {
    const at = toMillis(event.ts);
    if (at == null || at > t) continue;
    // 标注类型打断控制流推断的自引用：base 由上一轮的 activity 派生
    const base: NodeActivity = activity ?? EMPTY_ACTIVITY;
    const payload = event.payload ?? {};
    const text = typeof payload.text === "string" ? payload.text : "";
    if (event.type === "text") {
      activity = { ...base, chars: base.chars + text.length, lastKind: "text", updatedAt: at };
    } else if (event.type === "reasoning") {
      activity = {
        ...base,
        reasoningChars: base.reasoningChars + text.length,
        lastKind: "reasoning",
        updatedAt: at,
      };
    } else if (event.type === "tool") {
      activity = {
        ...base,
        tool: typeof payload.tool === "string" ? payload.tool : base.tool,
        toolStatus: typeof payload.status === "string" ? payload.status : null,
        lastKind: "tool",
        updatedAt: at,
      };
    } else if (event.type === "session.idle") {
      activity = { ...base, lastKind: "idle", updatedAt: at };
    } else if (event.type === "session.error") {
      activity = { ...base, lastKind: "error", updatedAt: at };
    }
  }
  return activity;
}

export function visualsAt({ run, nodes, rounds, events, t }: VisualsAtInput): RunVisualsAt {
  // 早于 ADR-0018 的运行是空图：同一条渲染路径，画布上没有节点，时间轴仍有行
  const graph = run?.graph ?? EMPTY_RUN_GRAPH;
  const nodeRows = new Map(nodes.map((row) => [row.nodeId, row]));
  const nodeIds = new Set<string>([...graph.nodes.map((n) => n.id), ...nodeRows.keys()]);

  /** 源端口 → 它归属的出口名，判定连线是否走通只看这一对 */
  const portExit = new Map<string, string | null>();
  for (const node of graph.nodes) {
    for (const port of node.outputs) {
      portExit.set(`${node.id}:${port.name}`, port.exitName ?? null);
    }
  }

  // 事件按会话分桶一次：光标每动一次都要重算，逐节点全表扫会随事件量线性变慢
  const eventsBySession = new Map<string, RunEventRow[]>();
  for (const event of events) {
    if (!event.sessionId) continue;
    const list = eventsBySession.get(event.sessionId);
    if (list) list.push(event);
    else eventsBySession.set(event.sessionId, [event]);
  }

  // 有没有轮次行是终态覆盖的前提，先收一遍：早于轮次表的运行一行都没有，整张图恒为等待
  const nodesWithRounds = new Set(rounds.map((round) => round.nodeId));

  const visuals: Record<string, CanvasNodeVisual> = {};
  const currentRounds = new Map<string, RunNodeRoundRow | null>();
  const byStatus = emptyByStatus();
  let done = 0;

  for (const nodeId of nodeIds) {
    const current = currentRoundOf(rounds, nodeId, t);
    currentRounds.set(nodeId, current);
    const row = nodeRows.get(nodeId);

    const startedAt = current ? toMillis(current.startedAt) : null;
    const finishedAt = current ? toMillis(current.finishedAt) : null;
    const roundEnded = finishedAt != null && finishedAt <= t;

    let status: NodeStatus = "pending";
    let error: string | null = null;
    if (current) {
      status = roundEnded ? current.status : "running";
      error = roundEnded ? current.error : null;
    }

    // 节点终态覆盖：取消、整运行失败、重入耗尽都不属于任何一轮，按 run_nodes 的终态与时刻叠加。
    // 只对有轮次行的节点生效——没有轮次行的节点恒为等待，否则早于轮次表的失败运行会被画成
    // 失败、成功运行却画成等待，同一批历史两副面孔。
    const nodeFinished = row ? toMillis(row.finishedAt) : null;
    if (
      row &&
      nodesWithRounds.has(nodeId) &&
      (row.status === "failed" || row.status === "cancelled") &&
      nodeFinished != null &&
      nodeFinished <= t
    ) {
      status = row.status;
      error = row.error ?? error;
    }

    // 用量是整个节点各轮的累计，只在节点已收束时给出，免得中途显示未来的账
    const settled = nodeFinished != null && nodeFinished <= t;
    visuals[nodeId] = {
      status,
      round: current?.round ?? null,
      startedAt,
      finishedAt: roundEnded ? finishedAt : null,
      error,
      activity: current?.sessionId ? activityIn(eventsBySession.get(current.sessionId), t) : null,
      tokens: settled && row ? sumTokens(row) : null,
      cost: settled && row ? row.cost : null,
    };

    byStatus[status] += 1;
    if (status !== "pending" && status !== "running") done += 1;
  }

  const edges: Record<string, CanvasEdgeVisual> = {};
  for (const edge of graph.edges) {
    const round = currentRounds.get(edge.sourceNodeId) ?? null;
    const finishedAt = round ? toMillis(round.finishedAt) : null;
    let state: EdgeFlowState = "idle";
    if (round && finishedAt != null && finishedAt <= t) {
      if (round.status !== "success") {
        state = "blocked";
      } else {
        const exit = portExit.get(`${edge.sourceNodeId}:${edge.sourcePort}`) ?? null;
        // 轮次没有具名出口（含输入节点）时全部输出端口生效；有则只认同名出口
        const taken = round.exitName == null || round.exitName === exit;
        if (!taken) state = "blocked";
        else state = visuals[edge.targetNodeId]?.status === "running" ? "flowing" : "flowed";
      }
    }
    edges[edge.id] = { state };
  }

  const usage = nodes.reduce(
    (acc, row) => ({ tokens: acc.tokens + sumTokens(row), cost: acc.cost + (row.cost ?? 0) }),
    { tokens: 0, cost: 0 },
  );

  return {
    t,
    nodes: visuals,
    edges,
    totals: {
      nodes: nodeIds.size,
      byStatus,
      done,
      tokens: usage.tokens,
      cost: usage.cost,
    },
  };
}
