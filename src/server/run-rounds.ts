/**
 * 轮次行的读取契约：骨架与重载荷的分界只在这里定义一次（ADR-0018）。
 *
 * 骨架（轮次、会话、起止、终态、出口、错误）每行几十字节，运行详情与 SSE 的 snapshot 帧
 * 全量带它——回放要靠它逐帧推状态。重载荷（`inputs` / `outputs` / `snapshot` / `artifactValidation`）是这一轮的
 * 端口值与整份运行快照（含 prompt、rule、渲染后的提示与技能正文），循环运行会成倍复制，
 * 跟着每 500ms 一帧的 snapshot 走就是把同一份大对象反复推给页面，所以按轮单独取。
 */
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import { db, runNodeRounds, runNodes } from "@/db";
import type { ArtifactValidation } from "@/lib/artifact-contract";

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
  artifactValidation: ArtifactValidation | null;
}

/**
 * 一次运行的全部节点行（各节点的最新状态与用量累计），按开始时刻排序。
 * `run_nodes` 本身已经没有重载荷列，整行就是骨架，不需要再挑列。
 */
export function listNodeSkeletons(runId: string) {
  return db
    .select()
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
      artifactValidation: runNodeRounds.artifactValidation,
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
    artifactValidation: row.artifactValidation ?? null,
  };
}

/**
 * 某个节点**最后一轮成功**的产物。评审循环里输出节点会在被打回那轮记 skipped、在通过那轮
 * 记 success，取最大轮次而不看终态会把空产物顶替成最终结果（专用入口的完成门禁读它）。
 */
export function readLatestSuccessfulOutputs(
  runId: string,
  nodeId: string,
): Record<string, unknown> | null {
  return (
    db
      .select({ outputs: runNodeRounds.outputs })
      .from(runNodeRounds)
      .where(
        and(
          eq(runNodeRounds.runId, runId),
          eq(runNodeRounds.nodeId, nodeId),
          eq(runNodeRounds.status, "success"),
        ),
      )
      .orderBy(desc(runNodeRounds.round))
      .limit(1)
      .get()?.outputs ?? null
  );
}

/**
 * 某个节点仍留着快照的最大一轮。技能集在受理时冻结、各轮同源，取哪一轮的映射都一样；
 * 被事件清理置空的轮跳过，全被置空时返回 null，轨迹面板退回显示 slug（AGENTS.md 已承认的代价）。
 */
export function readLatestRoundSnapshot(
  runId: string,
  nodeId: string,
): Record<string, unknown> | null {
  return (
    db
      .select({ snapshot: runNodeRounds.snapshot })
      .from(runNodeRounds)
      .where(
        and(
          eq(runNodeRounds.runId, runId),
          eq(runNodeRounds.nodeId, nodeId),
          isNotNull(runNodeRounds.snapshot),
        ),
      )
      .orderBy(desc(runNodeRounds.round))
      .limit(1)
      .get()?.snapshot ?? null
  );
}
