/**
 * 运行编排：startRun（校验 + 建 run + 异步执行）与 executeRun（拓扑序串行）。
 *
 * - 输入节点 → outputs = { value: 用户输入 }；输出节点 → 上游值透传为 outputs；
 *   Action 节点 → runActionNode。
 * - 节点失败 → run_nodes.error + 下游全部 skipped + run failed；全部成功 → run success。
 * - 任何异常都落到 run / run_nodes.error，绝不留 running 悬挂。
 */
import { and, eq, inArray } from "drizzle-orm";
import { db, runNodes, runs } from "@/db";
import {
  downstreamOf,
  topologicalOrder,
  validateGraph,
  type ValidationIssue,
} from "@/lib/graph";
import type { PortValue } from "@/lib/values";
import { isWithinData } from "@/server/fs-safety";
import { resolveWorkflow, type ResolvedWorkflow } from "@/server/resolve";
import { runActionNode } from "./action";

export type StartRunResult =
  | { ok: true; runId: string }
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 422; error: string; issues: ValidationIssue[] };

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
    .values({ id: runId, workflowId, status: "running", startedAt: new Date() })
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
  runInputs: Record<string, PortValue>,
): Promise<void> {
  const { nodes, edges } = resolved;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const order = topologicalOrder(nodes, edges);
  const outputsByNode = new Map<string, Record<string, PortValue>>();
  const skipped = new Set<string>();
  let firstError: string | null = null;

  for (const nodeId of order) {
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
        });
      }
      outputsByNode.set(nodeId, outs);
      updateRunNode(runId, nodeId, {
        status: "success",
        outputs: outs,
        finishedAt: new Date(),
      });
    } catch (err) {
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

  db.update(runs)
    .set(
      firstError
        ? { status: "failed", error: firstError, finishedAt: new Date() }
        : { status: "success", finishedAt: new Date() },
    )
    .where(eq(runs.id, runId))
    .run();
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
