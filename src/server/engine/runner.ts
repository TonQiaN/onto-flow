/**
 * 运行编排：startRun（校验 + 建 run + 异步执行）与 executeRun（拓扑序串行）。
 *
 * 一次运行 = 一个独立工作区 + 一个 harness 子进程（ADR-0007）。executeRun 建工作区、
 * 物化文件输入、起子进程，然后按拓扑序驱动节点，最后无论成败都把子进程收束到静止。
 *
 * - 输入节点 → outputs = { value: 用户输入 }；输出节点 → 上游值透传为 outputs；
 *   Action 节点 → runActionNode（在子进程里开一个会话）。
 * - 节点失败 → run_nodes.error + 下游全部 skipped + run failed；全部成功 → run success。
 * - cancelRun 是人为中止：取消在跑会话 + 节点 cancelled + 下游 skipped + run cancelled，
 *   是区别于 failed 的独立终态（run.error 留空）。
 * - 任何异常都落到 run / run_nodes.error，绝不留 running 悬挂。
 */
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db, runNodes, runs } from "@/db";
import {
  classifyEdges,
  downstreamOf,
  validateGraph,
  type ResolvedNode,
  type ValidationIssue,
} from "@/lib/graph";
import { MAX_FILE_INPUT_BYTES, type PortValue } from "@/lib/values";
import { DATA_DIR, isWithinData, resolveWithinData, safeBasename } from "@/server/fs-safety";
import { claimsPdf, hasPdfSignature, preprocessPdfInput } from "@/server/pdf-input";
import { launchRun } from "@/server/harness/launch";
import type { RunProcess } from "@/server/harness/runtime";
import {
  createRunWorkspace,
  WORKSPACE_INPUTS_SUBDIR,
  type RunWorkspace,
} from "@/server/harness/workspace";
import { resolveWorkflow, type ResolvedWorkflow } from "@/server/resolve";
import { readSettings } from "@/server/settings";
import { runActionNode } from "./action";
import { collectCapabilities, materializeToolPlugins } from "./capabilities";
import { recordSessionEvent, type EventSinkContext } from "./events";

export type StartRunResult =
  | { ok: true; runId: string }
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 422; error: string; issues: ValidationIssue[] };

export type CancelRunResult =
  | { ok: true }
  | { ok: false; status: 404 | 409; error: string };

/**
 * 进程级取消标记。executeRun 在每个节点开始前查它，已取消则停止调度剩余节点
 * （挂 globalThis 以免 HMR 重建模块时丢失正在跑的运行的标记）。
 */
interface RunnerGlobals {
  ontoflowCancelledRuns?: Set<string>;
  ontoflowRunProcesses?: Map<string, RunProcess>;
}
const g = globalThis as RunnerGlobals;
const cancelledRuns: Set<string> = g.ontoflowCancelledRuns ?? new Set();
g.ontoflowCancelledRuns = cancelledRuns;
/** 在跑运行的子进程句柄；cancelRun 要拿它去取消会话（挂 globalThis 以免 HMR 丢失）。 */
const runProcesses: Map<string, RunProcess> = g.ontoflowRunProcesses ?? new Map();
g.ontoflowRunProcesses = runProcesses;

export function isRunCancelled(runId: string): boolean {
  return cancelledRuns.has(runId);
}

/** PortValue 形态校验（前端传入的运行输入不可信） */
function isPortValue(value: unknown): value is PortValue {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.kind === "text") return typeof v.text === "string";
  if (v.kind === "json") return "json" in v;
  if (v.kind === "file") {
    const file = v.file as Record<string, unknown> | undefined;
    return (
      !!file &&
      typeof file.path === "string" &&
      typeof file.name === "string" &&
      typeof file.mime === "string"
    );
  }
  return false;
}

export async function startRun(
  workflowId: string,
  inputs: Record<string, unknown>,
): Promise<StartRunResult> {
  const resolved = await resolveWorkflow(workflowId);
  if (!resolved) return { ok: false, status: 404, error: "工作流不存在" };

  const issues = validateGraph(resolved.nodes, resolved.edges);

  // 每个输入节点都要有值，且 PortValue.kind 与节点 Object Type 的 kind 一致
  const runInputs: Record<string, PortValue> = {};
  for (const node of resolved.nodes) {
    if (node.kind !== "input") continue;
    const port = node.outputs[0];
    const value = inputs[node.id];
    if (value === undefined || value === null) {
      issues.push({
        nodeId: node.id,
        message: `输入节点「${node.label}」缺少运行输入`,
      });
      continue;
    }
    if (!isPortValue(value)) {
      issues.push({
        nodeId: node.id,
        message: `输入节点「${node.label}」的输入值不是合法的 PortValue`,
      });
      continue;
    }
    if (value.kind !== port.kind) {
      issues.push({
        nodeId: node.id,
        message: `输入节点「${node.label}」需要 ${port.kind} 类型的值，收到 ${value.kind}`,
      });
      continue;
    }
    // file 输入的 path 来自不可信请求体，必须约束在 data/ 内（防目录穿越）
    if (value.kind === "file" && !isWithinData(value.file.path)) {
      issues.push({
        nodeId: node.id,
        message: `输入节点「${node.label}」的文件路径非法（越界 data/ 目录）`,
      });
      continue;
    }
    runInputs[node.id] = value;
  }

  if (issues.length > 0) {
    return { ok: false, status: 422, error: "工作流校验未通过", issues };
  }

  const runId = crypto.randomUUID();
  db.insert(runs)
    .values({
      id: runId,
      workflowId,
      // 冗余快照：工作流后续改名，历史运行仍显示当时的名字
      workflowName: resolved.workflow.name,
      status: "running",
      startedAt: new Date(),
    })
    .run();
  for (const node of resolved.nodes) {
    db.insert(runNodes)
      .values({ runId, nodeId: node.id, label: node.label, status: "pending" })
      .run();
  }

  // 异步执行，立即返回 runId
  void executeRun(runId, resolved, runInputs).catch((err) => {
    failWholeRun(runId, err instanceof Error ? err.message : String(err));
  });

  return { ok: true, runId };
}

/** 一次运行内同时执行的 Action 上限。扇出宽了也不会把并发无限放大。 */
const MAX_CONCURRENT_NODES = 4;

type NodeStatus = "pending" | "running" | "success" | "failed" | "skipped" | "cancelled";

interface NodeState {
  node: ResolvedNode;
  status: NodeStatus;
  /** 已经执行过几轮；第 0 轮是首次执行 */
  round: number;
  outputs: Record<string, PortValue>;
  /** 完成时选中的出口名；undefined 表示还没跑完，null 表示默认出口 */
  selectedExit?: string | null;
}

/** 一条边的当前状态。dead 表示它的来源出口没有被选中，永远不会送来值。 */
type EdgeStatus = "pending" | "satisfied" | "dead";

/**
 * 图执行：就绪驱动、并行、按出口激活、按回边重入（ADR-0009）。
 *
 * 就绪判定只看**前向边**：环里的节点若同时等前驱和回边，第一轮永远等不齐。
 * 回边被满足时不参与就绪，而是触发目标节点的一次重入。
 */
async function executeRun(
  runId: string,
  resolved: ResolvedWorkflow,
  rawInputs: Record<string, PortValue>,
): Promise<void> {
  const { nodes, edges } = resolved;
  const { backEdgeIds } = classifyEdges(nodes, edges);
  const states = new Map<string, NodeState>(
    nodes.map((n) => [n.id, { node: n, status: "pending" as NodeStatus, round: 0, outputs: {} }]),
  );
  const edgeStatus = new Map<string, EdgeStatus>(edges.map((e) => [e.id, "pending"]));
  let firstError: string | null = null;
  let cancelled = false;

  // 工作区先建：它是这次运行全部 Action 的共同工作场所与唯一交流场所。
  // 技能以 symlink 指向全局库活目录，摘要写进 runs.imports（ADR-0007）。
  const capabilities = collectCapabilities(resolved);
  const workspace = await createRunWorkspace({
    workflowId: resolved.workflow.id,
    runId,
    instructions: workflowInstructions(resolved),
    skills: capabilities.skills,
  });
  db.update(runs)
    .set({
      runDir: path.relative(process.cwd(), workspace.runDir),
      imports: workspace.imports as unknown as Record<string, unknown>,
    })
    .where(eq(runs.id, runId))
    .run();

  // 文件输入落进工作区：模型的 cwd 是工作区，上传目录在它之外读不到。
  const runInputs = materializeFileInputs(rawInputs, workspace, nodes);

  // 每个 Action 在开跑前把自己的落库上下文登记进来，事件回调据此把 dsh 事件
  // 即时写成 run_events / node_usage。
  const sinks = new Map<string, EventSinkContext>();
  // 设置在运行启动时读一次：改设置在下一次运行生效，在跑的运行持有启动时刻的快照。
  const globalSettings = readSettings();
  const proc = await launchRun(workspace, {
    credentialRefs: globalSettings.credentialRefs.map((r) => r.name),
    composition: {
      deepseek: {
        apiKeyEnv: globalSettings.modelApiKeyEnv,
        ...(globalSettings.modelBaseUrl ? { baseURL: globalSettings.modelBaseUrl } : {}),
      },
      mcpServers: globalSettings.mcpServers,
      toolPlugins: materializeToolPlugins(workspace, capabilities.tools),
    },
    onCrash: (message) => {
      firstError ??= message;
    },
    onSessionEvent: (sessionId, event) => {
      const sink = sinks.get(sessionId);
      if (sink) recordSessionEvent(sink, event);
    },
  });
  runProcesses.set(runId, proc);

  /**
   * 一个入端口有没有前向入线。只被回边喂的端口（review-fix 里「意见」这种）
   * 第一轮本来就没有值，不能参与就绪判定，否则整个环第一轮就死锁。
   */
  const portHasForward = (nodeId: string, portName: string): boolean =>
    edges.some(
      (e) => !backEdgeIds.has(e.id) && e.targetNodeId === nodeId && e.targetPort === portName,
    );

  /**
   * 某个输入端口是否可以开跑：全部前向入线都已结算（satisfied 或 dead），
   * 且至少有一条 satisfied。
   *
   * 「全部结算」这一半是汇总的命根子：一个端口接六条入线时，只要有一条还没
   * 结算就不能开跑，否则节点会抢在其余上游之前启动、只读到已经落盘的那几份产物。
   * 实测中汇总节点正是这样漏读了一位评委的结论——六份产物都在磁盘上，它只读到五份。
   */
  const portFed = (nodeId: string, portName: string): boolean => {
    const forward = edges.filter(
      (e) => !backEdgeIds.has(e.id) && e.targetNodeId === nodeId && e.targetPort === portName,
    );
    if (forward.length === 0) return false;
    if (forward.some((e) => edgeStatus.get(e.id) === "pending")) return false;
    return forward.some((e) => edgeStatus.get(e.id) === "satisfied");
  };

  /** 某个输入端口是否已经没救：全部前向入线都 dead。 */
  const portDead = (nodeId: string, portName: string): boolean => {
    const forward = edges.filter(
      (e) => !backEdgeIds.has(e.id) && e.targetNodeId === nodeId && e.targetPort === portName,
    );
    return forward.length > 0 && forward.every((e) => edgeStatus.get(e.id) === "dead");
  };

  /**
   * 汇集一个节点各输入端口的值。一个端口可以接多条入线（那就是汇总），
   * 所以每个端口拿到的是一个**列表**——下游要读齐全部上游产物，不是只读一份。
   * 顺序按边 id 稳定，重跑时提示里的文件顺序不会晃。
   */
  const gatherInputs = (state: NodeState): Record<string, PortValue[]> => {
    const out: Record<string, PortValue[]> = {};
    const sorted = [...edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const port of state.node.inputs) {
      const values: PortValue[] = [];
      for (const e of sorted) {
        if (e.targetNodeId !== state.node.id || e.targetPort !== port.name) continue;
        if (edgeStatus.get(e.id) !== "satisfied") continue;
        const value = states.get(e.sourceNodeId)?.outputs[e.sourcePort];
        if (value) values.push(value);
      }
      if (values.length > 0) out[port.name] = values;
    }
    return out;
  };

  /** 节点完成后：按选中的出口把出线标 satisfied，其余标 dead。 */
  const settleOutgoing = (state: NodeState): void => {
    for (const e of edges) {
      if (e.sourceNodeId !== state.node.id) continue;
      const port = state.node.outputs.find((p) => p.name === e.sourcePort);
      const exitName = port?.exitName ?? null;
      const taken = state.selectedExit === undefined || exitName === state.selectedExit;
      edgeStatus.set(e.id, taken && state.outputs[e.sourcePort] ? "satisfied" : "dead");
    }
  };

  /** 出线全 dead 的节点被跳过，并把 dead 继续往下传。 */
  const propagateSkips = (): void => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const state of states.values()) {
        if (state.status !== "pending") continue;
        if (!state.node.inputs.some((p) => portDead(state.node.id, p.name))) continue;
        state.status = "skipped";
        updateRunNode(runId, state.node.id, { status: "skipped", finishedAt: new Date() });
        for (const e of edges) {
          if (e.sourceNodeId === state.node.id) edgeStatus.set(e.id, "dead");
        }
        changed = true;
      }
    }
  };

  /** 回边被满足：把目标节点连同它的前向下游重置，进入下一轮。 */
  const reenter = (target: NodeState): boolean => {
    const limit = target.node.maxReentries ?? 0;
    if (target.round >= limit) {
      if ((target.node.onExhausted ?? "fail") === "fail") {
        target.status = "failed";
        const message = `节点「${target.node.label}」重入次数已达上限 ${limit}`;
        updateRunNode(runId, target.node.id, {
          status: "failed",
          error: message,
          finishedAt: new Date(),
        });
        firstError ??= message;
      }
      // accept：保留最后一轮的成功结果，回边不再跟进，循环自然收束。
      return false;
    }
    const affected = downstreamOf(target.node.id, edges, backEdgeIds);
    affected.add(target.node.id);
    // 整个环体一起进下一轮：只给被回流的节点加轮次的话，环里其他节点会用
    // 同一个产物路径把上一轮的东西覆盖掉，逐轮回看就没了依据。
    const nextRound = target.round + 1;
    for (const id of affected) {
      const state = states.get(id);
      if (!state) continue;
      state.status = "pending";
      state.selectedExit = undefined;
      state.round = nextRound;
      updateRunNode(runId, id, { status: "pending", error: null, finishedAt: null });
      for (const e of edges) {
        // 目标节点的入线要保留刚满足的那条回边，其余下游的边重新变回 pending。
        if (affected.has(e.targetNodeId) && e.targetNodeId !== target.node.id) {
          edgeStatus.set(e.id, "pending");
        }
      }
    }
    return true;
  };

  /** 一个节点跑完（成功）后的统一收尾：落库、结算出线、传播跳过、处理回边。 */
  const onNodeSuccess = (state: NodeState): void => {
    updateRunNode(runId, state.node.id, {
      status: "success",
      outputs: state.outputs,
      finishedAt: new Date(),
    });
    state.status = "success";
    settleOutgoing(state);
    propagateSkips();
    for (const e of edges) {
      if (!backEdgeIds.has(e.id)) continue;
      if (e.sourceNodeId !== state.node.id) continue;
      if (edgeStatus.get(e.id) !== "satisfied") continue;
      const target = states.get(e.targetNodeId);
      if (target) reenter(target);
    }
  };

  /** 挑出此刻可以开跑的节点。 */
  const pickReady = (): NodeState[] => {
    const ready: NodeState[] = [];
    for (const state of states.values()) {
      if (state.status !== "pending") continue;
      if (state.node.kind === "input") {
        ready.push(state);
        continue;
      }
      const blocking = state.node.inputs.filter((p) => portHasForward(state.node.id, p.name));
      if (blocking.every((p) => portFed(state.node.id, p.name))) ready.push(state);
    }
    return ready.sort((a, b) => (a.node.id < b.node.id ? -1 : 1));
  };

  const runOne = async (state: NodeState): Promise<void> => {
    const nodeId = state.node.id;
    if (state.node.kind === "input") {
      updateRunNode(runId, nodeId, { status: "running", startedAt: new Date() });
      const value = runInputs[nodeId];
      if (!value) throw new Error("输入节点缺少运行输入");
      state.outputs = { value };
      onNodeSuccess(state);
      return;
    }

    const nodeInputs = gatherInputs(state);
    for (const port of state.node.inputs) {
      // 只被回边喂的端口第一轮没有值是正常的，不算缺输入。
      if (!portHasForward(nodeId, port.name)) continue;
      if (!nodeInputs[port.name]?.length) {
        throw new Error(`输入端口「${port.name}」没有可用的上游值`);
      }
    }
    updateRunNode(runId, nodeId, {
      status: "running",
      startedAt: new Date(),
      inputs: nodeInputs,
      error: null,
    });

    if (state.node.kind === "output") {
      // 输出节点只有一个 value 口，透传第一份（多条入线的输出节点没有意义）。
      state.outputs = { value: nodeInputs.value[0] };
      onNodeSuccess(state);
      return;
    }

    const nodeRow = resolved.nodeRows.get(nodeId);
    if (!nodeRow?.actionId) throw new Error("Action 节点缺少 actionId");
    const result = await runActionNode({
      runId,
      node: state.node,
      actionId: nodeRow.actionId,
      inputs: nodeInputs,
      proc,
      workspace,
      sinks,
      round: state.round,
      disabledTools: globalSettings.disabledTools,
    });
    state.outputs = result.outputs;
    state.selectedExit = result.selectedExit;
    onNodeSuccess(state);
  };

  try {
    const running = new Map<string, Promise<void>>();
    for (;;) {
      if (isRunCancelled(runId)) {
        cancelled = true;
        break;
      }
      // 有节点失败后不再启动新节点，但已在跑的等它们自己收束。
      if (firstError === null) {
        for (const state of pickReady()) {
          if (running.size >= MAX_CONCURRENT_NODES) break;
          state.status = "running";
          const task = runOne(state)
            .catch((err) => {
              if (isRunCancelled(runId)) {
                state.status = "cancelled";
                updateRunNode(runId, state.node.id, {
                  status: "cancelled",
                  finishedAt: new Date(),
                });
                cancelled = true;
                return;
              }
              const message = err instanceof Error ? err.message : String(err);
              state.status = "failed";
              updateRunNode(runId, state.node.id, {
                status: "failed",
                error: message,
                finishedAt: new Date(),
              });
              firstError ??= `节点「${state.node.label}」失败：${message}`;
              for (const e of edges) {
                if (e.sourceNodeId === state.node.id) edgeStatus.set(e.id, "dead");
              }
              propagateSkips();
            })
            .finally(() => {
              running.delete(state.node.id);
            });
          running.set(state.node.id, task);
        }
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
    }
    await Promise.allSettled(running.values());
  } finally {
    // 无论成败都把子进程收束到静止：一个运行的进程树不许活过它的运行。
    runProcesses.delete(runId);
    try {
      await proc.dispose();
    } catch (err) {
      console.error("[engine] 子进程收束失败", runId, err);
    }
  }

  // 终态判定：cancelled 与 failed 是两个独立终态，取消不算失败、run.error 留空
  const now = new Date();
  if (cancelled || isRunCancelled(runId)) {
    db.update(runNodes)
      .set({ status: "skipped", finishedAt: now })
      .where(and(eq(runNodes.runId, runId), eq(runNodes.status, "pending")))
      .run();
    db.update(runs)
      .set({ status: "cancelled", error: null, finishedAt: now })
      .where(eq(runs.id, runId))
      .run();
  } else {
    db.update(runNodes)
      .set({ status: "skipped", finishedAt: now })
      .where(and(eq(runNodes.runId, runId), eq(runNodes.status, "pending")))
      .run();
    // 输出节点标记的是工作流级最终产出。分支图里没走到的输出节点被跳过是正常的，
    // 但一个都没走到就说明这次运行什么都没产出——那不叫成功。循环按 accept 收束
    // 却始终没走出通过分支，就会落到这里。
    const outputNodes = nodes.filter((n) => n.kind === "output");
    const producedAny = outputNodes.some((n) => states.get(n.id)?.status === "success");
    if (firstError === null && outputNodes.length > 0 && !producedAny) {
      firstError = "运行结束时没有任何输出节点产出：图上所有通往输出的分支都没有走到";
    }
    db.update(runs)
      .set(
        firstError
          ? { status: "failed", error: firstError, finishedAt: now }
          : { status: "success", finishedAt: now },
      )
      .where(eq(runs.id, runId))
      .run();
  }
  cancelledRuns.delete(runId);
}

/**
 * 取消运行：取消子进程里所有 running 节点的会话，把它们标 cancelled、
 * 未开始的节点标 skipped、run 标 cancelled。同时立进程级取消标记，让
 * executeRun 在下一个节点开始前停止调度。HTTP 入口在阶段二接。
 */
export async function cancelRun(runId: string): Promise<CancelRunResult> {
  const run = db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId))
    .get();
  if (!run) return { ok: false, status: 404, error: "运行不存在" };
  if (run.status !== "running") {
    return { ok: false, status: 409, error: "该运行已结束，无法取消" };
  }

  // 先立标记：即使下面的 abort 慢，executeRun 也不会再启动新节点
  cancelledRuns.add(runId);

  const running = db
    .select({ nodeId: runNodes.nodeId, sessionId: runNodes.sessionId })
    .from(runNodes)
    .where(and(eq(runNodes.runId, runId), eq(runNodes.status, "running")))
    .all();

  const proc = runProcesses.get(runId);
  for (const node of running) {
    if (!node.sessionId || !proc) continue;
    try {
      await proc.cancel(node.sessionId);
    } catch (err) {
      // 子进程可能已随崩溃退出；取消的权威结果是下面写下的终态，不是这次调用。
      console.error("[engine] 取消会话失败", node.sessionId, err);
    }
  }

  const now = new Date();
  db.update(runNodes)
    .set({ status: "cancelled", finishedAt: now })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.status, "running")))
    .run();
  db.update(runNodes)
    .set({ status: "skipped", finishedAt: now })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.status, "pending")))
    .run();
  db.update(runs)
    .set({ status: "cancelled", error: null, finishedAt: now })
    .where(eq(runs.id, runId))
    .run();

  return { ok: true };
}

function updateRunNode(
  runId: string,
  nodeId: string,
  patch: Partial<typeof runNodes.$inferInsert>,
): void {
  db.update(runNodes)
    .set(patch)
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)))
    .run();
}

/** 兜底：executeRun 自身抛出的异常也不留 running 悬挂 */
function failWholeRun(runId: string, message: string): void {
  try {
    cancelledRuns.delete(runId);
    // 已经写过终态（含被取消）的运行不覆盖：取消不是失败
    const run = db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .get();
    if (!run || run.status !== "running") return;

    db.update(runNodes)
      .set({ status: "failed", error: message, finishedAt: new Date() })
      .where(
        and(eq(runNodes.runId, runId), eq(runNodes.status, "running")),
      )
      .run();
    db.update(runNodes)
      .set({ status: "skipped", finishedAt: new Date() })
      .where(
        and(
          eq(runNodes.runId, runId),
          inArray(runNodes.status, ["pending"]),
        ),
      )
      .run();
    db.update(runs)
      .set({ status: "failed", error: message, finishedAt: new Date() })
      .where(eq(runs.id, runId))
      .run();
  } catch (err) {
    console.error("[engine] 运行失败状态落库失败", err);
  }
}

/**
 * 工作流级共同指令，物化为工作区的 AGENTS.md。
 * 上游 agent-instructions 从会话 cwd 向上发现它，因此这次运行的每个 Action
 * 都无条件读到同一份（对应「在项目文件夹里起 agent」的体验）。
 */
function workflowInstructions(resolved: ResolvedWorkflow): string {
  const lines = [
    `# ${resolved.workflow.name}`,
    "",
    "你是这个工作流里的一个 Action。本目录是本次运行的工作区，也是各 Action 之间",
    "唯一的交流场所：实质内容一律写成文件，读上游的东西也一律读文件。",
    "",
    "- 只在本目录内读写，不要访问工作区以外的路径。",
    "- 结构化输出只用来报告产物路径，不要往里塞长文本。",
    "- 声明了的产物必须真的写出来：文件不存在，本节点即判失败。",
  ];
  if (resolved.workflow.description) {
    lines.splice(2, 0, resolved.workflow.description, "");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 把文件类运行输入拷进工作区的 inputs/ 并改写它的 PortValue 路径。
 * 上传目录在工作区之外，模型的 cwd 是工作区，不搬进来它根本读不到。
 */
function materializeFileInputs(
  inputs: Record<string, PortValue>,
  workspace: RunWorkspace,
  nodes: readonly ResolvedNode[],
): Record<string, PortValue> {
  const out: Record<string, PortValue> = {};
  for (const [nodeId, value] of Object.entries(inputs)) {
    if (value.kind !== "file") {
      out[nodeId] = value;
      continue;
    }
    const name = safeBasename(value.file.name || value.file.path);
    const destDir = path.join(workspace.workspaceDir, WORKSPACE_INPUTS_SUBDIR, nodeId);
    const sourceDir = path.join(destDir, "source");
    fs.mkdirSync(sourceDir, { recursive: true });
    const dest = path.join(sourceDir, name);
    const source = resolveWithinData(value.file.path);
    if (fs.statSync(source).size > MAX_FILE_INPUT_BYTES) {
      throw new Error(`输入节点「${nodeId}」的文件超过 32 MiB`);
    }
    fs.copyFileSync(source, dest);
    const node = nodes.find((candidate) => candidate.id === nodeId);
    const filePreprocessor = node?.kind === "input" ? node.outputs[0]?.filePreprocessor : null;
    let preprocessed: Extract<PortValue, { kind: "file" }>["file"]["preprocessed"];
    if (filePreprocessor === "pdf") {
      const pdf = hasPdfSignature(dest);
      if (!pdf && claimsPdf(name, value.file.mime)) {
        throw new Error(`输入节点「${node?.label ?? nodeId}」收到的文件不是合法 PDF`);
      }
      if (pdf) {
        const derived = preprocessPdfInput(dest, path.join(destDir, "derived"));
        preprocessed = {
          kind: "pdf",
          pageCount: derived.pageCount,
          textPath: path.relative(DATA_DIR, derived.textPath),
          pageImagePaths: derived.pageImagePaths.map((page) => path.relative(DATA_DIR, page)),
        };
      }
    }
    out[nodeId] = {
      kind: "file",
      file: {
        path: path.relative(DATA_DIR, dest),
        name,
        mime: value.file.mime,
        ...(preprocessed === undefined ? {} : { preprocessed }),
      },
    };
  }
  return out;
}
