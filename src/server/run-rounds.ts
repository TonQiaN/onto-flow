/**
 * 轮次行的读取契约：骨架与重载荷的分界只在这里定义一次（ADR-0018）。
 *
 * 骨架（轮次、会话、起止、终态、出口、错误）每行几十字节，运行详情与 SSE 的 snapshot 帧
 * 全量带它——回放要靠它逐帧推状态。重载荷（`inputs` / `outputs` / `snapshot`）是这一轮的
 * 端口值与整份运行快照（含 prompt、rule、渲染后的提示与技能正文），循环运行会成倍复制，
 * 跟着每 500ms 一帧的 snapshot 走就是把同一份大对象反复推给页面，所以按轮单独取。
 */
import { and, asc, eq } from "drizzle-orm";
import { db, runNodeRounds, runNodes } from "@/db";

/** 骨架列：`select` 时就不取重载荷，不是取回来再删 */
const SKELETON_COLUMNS = {
  id: runNodeRounds.id,
  runId: runNodeRounds.runId,
  nodeId: runNodeRounds.nodeId,
  round: runNodeRounds.round,
  sessionId: runNodeRounds.sessionId,
  status: runNodeRounds.status,
  startedAt: runNodeRounds.startedAt,
  finishedAt: runNodeRounds.finishedAt,
  exitName: runNodeRounds.exitName,
  error: runNodeRounds.error,
};

/** 一轮的重载荷；被事件清理置空的列是 null，与「这一轮本就没有」同一形状 */
export interface RoundPayload {
  inputs: Record<string, unknown> | null;
  outputs: Record<string, unknown> | null;
  snapshot: Record<string, unknown> | null;
}

/**
 * `run_nodes` 的骨架列。那三个重载荷列是**最新一轮**的副本，与轮次行上的同名列同一份内容：
 * 跟着每一帧 snapshot 下发等于把同一份大对象推两遍，抽屉又只认光标所在那一轮的值。
 * 服务端仍读得到（轨迹路由从 `node.snapshot` 取技能名），只是不出现在对外的运行详情里。
 */
const NODE_SKELETON_COLUMNS = {
  id: runNodes.id,
  runId: runNodes.runId,
  nodeId: runNodes.nodeId,
  label: runNodes.label,
  status: runNodes.status,
  sessionId: runNodes.sessionId,
  error: runNodes.error,
  startedAt: runNodes.startedAt,
  finishedAt: runNodes.finishedAt,
  inputTokens: runNodes.inputTokens,
  outputTokens: runNodes.outputTokens,
  reasoningTokens: runNodes.reasoningTokens,
  cacheReadTokens: runNodes.cacheReadTokens,
  cacheWriteTokens: runNodes.cacheWriteTokens,
  cost: runNodes.cost,
};

/** 一次运行的全部节点骨架（各节点的最新状态），按开始时刻排序 */
export function listNodeSkeletons(runId: string) {
  return db
    .select(NODE_SKELETON_COLUMNS)
    .from(runNodes)
    .where(eq(runNodes.runId, runId))
    .orderBy(asc(runNodes.startedAt))
    .all();
}

/** 一次运行的全部轮次骨架，按开始时刻排序 */
export function listRoundSkeletons(runId: string) {
  return db
    .select(SKELETON_COLUMNS)
    .from(runNodeRounds)
    .where(eq(runNodeRounds.runId, runId))
    .orderBy(asc(runNodeRounds.startedAt))
    .all();
}

/** 某个节点某一轮的重载荷；没有这一轮返回 null（由调用方答 404） */
export function readRoundPayload(
  runId: string,
  nodeId: string,
  round: number,
): RoundPayload | null {
  const row = db
    .select({
      inputs: runNodeRounds.inputs,
      outputs: runNodeRounds.outputs,
      snapshot: runNodeRounds.snapshot,
    })
    .from(runNodeRounds)
    .where(
      and(
        eq(runNodeRounds.runId, runId),
        eq(runNodeRounds.nodeId, nodeId),
        eq(runNodeRounds.round, round),
      ),
    )
    .get();
  if (!row) return null;
  return {
    inputs: row.inputs ?? null,
    outputs: row.outputs ?? null,
    snapshot: row.snapshot ?? null,
  };
}
