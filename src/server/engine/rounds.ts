/**
 * `run_node_rounds` 的唯一写入面（ADR-0018）。
 *
 * 一个节点的每一次执行是一行：Action 的一轮由 action.ts 在会话开始时 begin、收束时 settle；
 * 输入 / 输出 / 被跳过的节点从不进 action.ts，直接 settle 成零时长的一行。取消、整运行失败与
 * 启动对账不属于任何一轮，它们只做两件事——把仍 running 的行收口成终态、给仍 pending 的节点
 * 补一行零时长 skipped——否则回放里会留下一段永远在跑的会话，或末尾一批永远在等待的节点。
 *
 * 轮次号由调度侧给：回边重入把整个环体的轮次一起推进（ADR-0009），所以同一节点的
 * 「上一轮」和「这一轮」是两行，抽屉才能按光标所在轮读输入输出与快照。收口路径没有内存
 * 状态可问，轮次号取该节点已有的最大轮次 + 1。
 */
import { and, eq, inArray, max } from "drizzle-orm";
import { db, runNodeRounds } from "@/db";
import type { ArtifactValidation } from "@/lib/artifact-contract";

export type RoundStatus = "running" | "success" | "failed" | "cancelled" | "skipped";

/** `db` 或 `db.transaction` 的 tx：轮次行与 run_nodes 的落态尽量落在同一事务里。 */
export type RoundWriter = Pick<typeof db, "insert" | "update" | "select">;

/** 一轮的定位键：(run_id, node_id, round) 是唯一索引。 */
export interface RoundKey {
  runId: string;
  nodeId: string;
  round: number;
}

type JsonMap = Record<string, unknown>;

export interface RoundStart extends RoundKey {
  startedAt: Date;
  sessionId?: string | null;
  inputs?: JsonMap | null;
  snapshot?: JsonMap | null;
}

export interface RoundSettle extends RoundKey {
  status: RoundStatus;
  finishedAt: Date;
  exitName?: string | null;
  error?: string | null;
  /** 只有一次落态就走完全程的节点（输入 / 输出）在这里补自己的输入，Action 在 begin 时已写 */
  inputs?: JsonMap | null;
  outputs?: JsonMap | null;
}

const CONFLICT_TARGET = [runNodeRounds.runId, runNodeRounds.nodeId, runNodeRounds.round];

/**
 * 一轮开始：running 行加这一轮自己的输入与快照。
 *
 * 同键重开即整行改写（复杂图里两条回边可能把同一节点推到同一轮次），残留的终态列一并清空，
 * 否则新一次执行会顶着上一次的 finishedAt 与出口回放。
 */
export function beginRound(start: RoundStart, writer: RoundWriter = db): void {
  const sessionId = start.sessionId ?? null;
  const inputs = start.inputs ?? null;
  const snapshot = start.snapshot ?? null;
  writer
    .insert(runNodeRounds)
    .values({
      runId: start.runId,
      nodeId: start.nodeId,
      round: start.round,
      sessionId,
      status: "running",
      startedAt: start.startedAt,
      finishedAt: null,
      exitName: null,
      error: null,
      inputs,
      outputs: null,
      snapshot,
      artifactValidation: null,
    })
    .onConflictDoUpdate({
      target: CONFLICT_TARGET,
      set: {
        sessionId,
        status: "running",
        startedAt: start.startedAt,
        finishedAt: null,
        exitName: null,
        error: null,
        inputs,
        outputs: null,
        snapshot,
        artifactValidation: null,
      },
    })
    .run();
}

/**
 * 补上这一轮的快照。快照要等提示渲染完才有，而 begin 必须早于一切会抛的准备步骤
 *（校验产物路径、读技能投影），否则「会话还没开就失败」的那一轮在时间轴上根本不存在。
 */
export function attachRoundSnapshot(
  key: RoundKey,
  snapshot: JsonMap,
  writer: RoundWriter = db,
): void {
  writer.update(runNodeRounds).set({ snapshot }).where(roundWhere(key)).run();
}

/** 记录契约通过与失败的证据；不改变调度终态，也不把失败文件发布给下游。 */
export function attachArtifactValidation(
  key: RoundKey,
  artifactValidation: ArtifactValidation,
): void {
  db.update(runNodeRounds).set({ artifactValidation }).where(roundWhere(key)).run();
}

function roundWhere(key: RoundKey) {
  return and(
    eq(runNodeRounds.runId, key.runId),
    eq(runNodeRounds.nodeId, key.nodeId),
    eq(runNodeRounds.round, key.round),
  );
}

/**
 * 一轮落态：只写终态相关的列，begin 时写下的会话、输入与快照原样保留。
 *
 * 可选列一律不传即保持，只有终态与 `finishedAt` 无条件改写：Action 收束时已记下的出口与产物
 * 是这一轮真跑出来的事实，随后落下的取消只该改终态，不该顺手把它们清成 null。
 *
 * 行不存在就补一行零时长的（`startedAt` = `finishedAt`）：输入节点、输出节点与被跳过的
 * 节点没有 begin 这一步，它们同样要在时间轴上占一行，否则回放到末尾这些节点还是等待。
 */
export function settleRound(settle: RoundSettle, writer: RoundWriter = db): void {
  writer
    .insert(runNodeRounds)
    .values({
      runId: settle.runId,
      nodeId: settle.nodeId,
      round: settle.round,
      sessionId: null,
      status: settle.status,
      startedAt: settle.finishedAt,
      finishedAt: settle.finishedAt,
      exitName: settle.exitName ?? null,
      error: settle.error ?? null,
      inputs: settle.inputs ?? null,
      outputs: settle.outputs ?? null,
      snapshot: null,
    })
    .onConflictDoUpdate({
      target: CONFLICT_TARGET,
      set: {
        status: settle.status,
        finishedAt: settle.finishedAt,
        ...(settle.exitName === undefined ? {} : { exitName: settle.exitName }),
        ...(settle.error === undefined ? {} : { error: settle.error }),
        ...(settle.inputs === undefined ? {} : { inputs: settle.inputs }),
        ...(settle.outputs === undefined ? {} : { outputs: settle.outputs }),
      },
    })
    .run();
}

/**
 * 每个节点下一个未用的轮次号（已有轮次行的最大值 + 1，没有行则 0）。
 * 收口路径没有内存状态可问，只能回库看这个节点已经留下过哪几轮。
 */
function nextRoundNumbers(
  runId: string,
  nodeIds: readonly string[],
  writer: RoundWriter = db,
): Map<string, number> {
  const next = new Map<string, number>(nodeIds.map((nodeId) => [nodeId, 0]));
  if (nodeIds.length === 0) return next;
  for (const row of writer
    .select({ nodeId: runNodeRounds.nodeId, round: max(runNodeRounds.round) })
    .from(runNodeRounds)
    .where(and(eq(runNodeRounds.runId, runId), inArray(runNodeRounds.nodeId, [...nodeIds])))
    .groupBy(runNodeRounds.nodeId)
    .all()) {
    next.set(row.nodeId, (row.round ?? -1) + 1);
  }
  return next;
}

/**
 * 收口一轮，但**只在这一行仍是 running 时**写。
 *
 * 取消可能在 Action 正等最后一次 sessionOutput / closeSession 时到达：`cancelRun` 先把这一行
 * 写成 cancelled，Action 侧随后再无条件写 success 就把取消覆盖掉了。先到的终态赢。
 * 与 `settleRound` 的另一个区别是它从不补行——调用它的路径一定先 `beginRound` 过；
 * 可选列的规则与 `settleRound` 相同：不传即保持。
 */
export function settleRoundIfRunning(settle: RoundSettle, writer: RoundWriter = db): void {
  writer
    .update(runNodeRounds)
    .set({
      status: settle.status,
      finishedAt: settle.finishedAt,
      ...(settle.exitName === undefined ? {} : { exitName: settle.exitName }),
      ...(settle.error === undefined ? {} : { error: settle.error }),
      ...(settle.inputs === undefined ? {} : { inputs: settle.inputs }),
      ...(settle.outputs === undefined ? {} : { outputs: settle.outputs }),
    })
    .where(and(roundWhere(settle), eq(runNodeRounds.status, "running")))
    .run();
}

/** 把该运行里仍 running 的轮次行一律收口成终态；取消 / 整运行失败 / 启动对账共用。 */
export function closeRunningRounds(
  runId: string,
  status: Extract<RoundStatus, "failed" | "cancelled">,
  at: Date,
  error: string | null,
  writer: RoundWriter = db,
): void {
  writer
    .update(runNodeRounds)
    .set({ status, finishedAt: at, error })
    .where(and(eq(runNodeRounds.runId, runId), eq(runNodeRounds.status, "running")))
    .run();
}

/**
 * 给这些节点各补一行零时长 skipped 轮次。轮次号取该节点已有的最大轮次 + 1：
 * 收口路径没有内存状态可问，而被重入重置过的节点已经留下了前几轮的行。
 */
export function recordSkippedRounds(
  runId: string,
  nodeIds: readonly string[],
  at: Date,
  writer: RoundWriter = db,
): void {
  const next = nextRoundNumbers(runId, nodeIds, writer);
  for (const nodeId of nodeIds) {
    settleRound(
      { runId, nodeId, round: next.get(nodeId) ?? 0, status: "skipped", finishedAt: at },
      writer,
    );
  }
}
