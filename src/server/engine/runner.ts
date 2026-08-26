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
  downstreamOf,
  topologicalOrder,
  validateGraph,
  type ValidationIssue,
} from "@/lib/graph";
import type { PortValue } from "@/lib/values";
import { DATA_DIR, isWithinData, safeBasename } from "@/server/fs-safety";
import { launchRun } from "@/server/harness/launch";
import type { RunProcess } from "@/server/harness/runtime";
import {
  createRunWorkspace,
  WORKSPACE_INPUTS_SUBDIR,
  type RunWorkspace,
} from "@/server/harness/workspace";
import { resolveWorkflow, type ResolvedWorkflow } from "@/server/resolve";
import { runActionNode } from "./action";
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

async function executeRun(
  runId: string,
  resolved: ResolvedWorkflow,
  rawInputs: Record<string, PortValue>,
): Promise<void> {
  const { nodes, edges } = resolved;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const order = topologicalOrder(nodes, edges);
  const outputsByNode = new Map<string, Record<string, PortValue>>();
  const skipped = new Set<string>();
  let firstError: string | null = null;
  let cancelled = false;

  // 工作区先建：它是这次运行全部 Action 的共同工作场所与唯一交流场所。
  const workspace = await createRunWorkspace({
    workflowId: resolved.workflow.id,
    runId,
    instructions: workflowInstructions(resolved),
  });
  db.update(runs)
    .set({
      runDir: path.relative(process.cwd(), workspace.runDir),
      imports: workspace.imports as unknown as Record<string, unknown>,
    })
    .where(eq(runs.id, runId))
    .run();

  // 文件输入落进工作区：模型的 cwd 是工作区，上传目录在它之外读不到。
  const runInputs = materializeFileInputs(rawInputs, workspace);

  // 会话 id 就是节点 id；每个 Action 在开跑前把自己的落库上下文登记进来，
  // 事件回调据此把 dsh 事件即时写成 run_events / node_usage。
  const sinks = new Map<string, EventSinkContext>();
  const proc = await launchRun(workspace, {
    onCrash: (message) => {
      firstError ??= message;
    },
    onSessionEvent: (sessionId, event) => {
      const sink = sinks.get(sessionId);
      if (sink) recordSessionEvent(sink, event);
    },
  });
  runProcesses.set(runId, proc);

  try {
    for (const nodeId of order) {
      // 取消是人为中止：立刻停止调度剩余节点（收尾由下方终态判定统一处理）
      if (isRunCancelled(runId)) {
        cancelled = true;
        break;
      }

      const node = nodeById.get(nodeId);
      if (!node) continue;

      if (skipped.has(nodeId)) {
        updateRunNode(runId, nodeId, {
          status: "skipped",
          finishedAt: new Date(),
        });
        continue;
      }

      try {
        if (node.kind === "input") {
          updateRunNode(runId, nodeId, {
            status: "running",
            startedAt: new Date(),
          });
          const value = runInputs[nodeId];
          if (!value) throw new Error("输入节点缺少运行输入");
          const outs: Record<string, PortValue> = { value };
          outputsByNode.set(nodeId, outs);
          updateRunNode(runId, nodeId, {
            status: "success",
            outputs: outs,
            finishedAt: new Date(),
          });
          continue;
        }

        // 汇集上游输入
        const nodeInputs: Record<string, PortValue> = {};
        for (const port of node.inputs) {
          const edge = edges.find(
            (e) => e.targetNodeId === nodeId && e.targetPort === port.name,
          );
          const value = edge
            ? outputsByNode.get(edge.sourceNodeId)?.[edge.sourcePort]
            : undefined;
          if (!value) {
            throw new Error(`输入端口「${port.name}」没有可用的上游值`);
          }
          nodeInputs[port.name] = value;
        }

        updateRunNode(runId, nodeId, {
          status: "running",
          startedAt: new Date(),
          inputs: nodeInputs,
        });

        let outs: Record<string, PortValue>;
        if (node.kind === "output") {
          // 输出节点：上游值直接透传
          outs = { value: nodeInputs.value };
        } else {
          const nodeRow = resolved.nodeRows.get(nodeId);
          if (!nodeRow?.actionId) {
            throw new Error("Action 节点缺少 actionId");
          }
          outs = await runActionNode({
            runId,
            node,
            actionId: nodeRow.actionId,
            inputs: nodeInputs,
            proc,
            workspace,
            sinks,
          });
        }
        // 节点跑完时运行已被取消：cancelRun 已把它标 cancelled，不再翻回 success
        if (isRunCancelled(runId)) {
          cancelled = true;
          break;
        }
        outputsByNode.set(nodeId, outs);
        updateRunNode(runId, nodeId, {
          status: "success",
          outputs: outs,
          finishedAt: new Date(),
        });
      } catch (err) {
        // session.abort 会让正在跑的 prompt 抛错——那是被取消而不是失败，不记 error
        if (isRunCancelled(runId)) {
          updateRunNode(runId, nodeId, {
            status: "cancelled",
            finishedAt: new Date(),
          });
          cancelled = true;
          break;
        }
        const message = err instanceof Error ? err.message : String(err);
        updateRunNode(runId, nodeId, {
          status: "failed",
          error: message,
          finishedAt: new Date(),
        });
        firstError ??= `节点「${node.label}」失败：${message}`;
        for (const id of downstreamOf(nodeId, edges)) skipped.add(id);
      }
    }

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
): Record<string, PortValue> {
  const out: Record<string, PortValue> = {};
  for (const [nodeId, value] of Object.entries(inputs)) {
    if (value.kind !== "file") {
      out[nodeId] = value;
      continue;
    }
    const name = safeBasename(value.file.name || value.file.path);
    const destDir = path.join(workspace.workspaceDir, WORKSPACE_INPUTS_SUBDIR, nodeId);
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, name);
    fs.copyFileSync(path.join(DATA_DIR, value.file.path), dest);
    out[nodeId] = {
      kind: "file",
      file: { ...value.file, path: path.relative(DATA_DIR, dest), name },
    };
  }
  return out;
}
