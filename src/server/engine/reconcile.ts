/**
 * 进程启动时的孤儿运行对账。
 *
 * run 的终态只在启动 executeRun 的那个进程内保证（内存里的 promise catch）。
 * 若进程在运行中途退出，runs 会永久停在 running、run_nodes 停在 running/pending，
 * 且 SSE 的结束条件（status !== running）永假、无限轮询。单用户本地工作台同一时刻
 * 只有一个进程，因此启动时凡是 running 的 run 必是上次进程遗留的孤儿，一律失败化。
 *
 * 轮次行同样要收口（ADR-0018）：留下 running 的行，回放里就有一段永远在跑的会话；
 * 被批量改成 skipped 的 pending 节点也各补一行零时长 skipped，否则回放到末尾它们还是等待。
 */
import { and, eq, inArray } from "drizzle-orm";
import { db, runNodes, runs } from "@/db";
import { closeRunningRounds, recordSkippedRounds } from "./rounds";

const ORPHAN_ERROR = "进程重启，运行被中断";

export function reconcileOrphanRuns(): void {
  const orphans = db.select({ id: runs.id }).from(runs).where(eq(runs.status, "running")).all();
  if (orphans.length === 0) return;

  const ids = orphans.map((r) => r.id);
  const now = new Date();
  db.transaction((tx) => {
    // 节点清单必须在批量改写之前取：改完就分不出哪些节点是这次被跳过的。
    const pending = tx
      .select({ runId: runNodes.runId, nodeId: runNodes.nodeId })
      .from(runNodes)
      .where(and(inArray(runNodes.runId, ids), eq(runNodes.status, "pending")))
      .all();
    tx.update(runs)
      .set({ status: "failed", error: ORPHAN_ERROR, finishedAt: now })
      .where(inArray(runs.id, ids))
      .run();
    tx.update(runNodes)
      .set({ status: "failed", error: ORPHAN_ERROR, finishedAt: now })
      .where(and(inArray(runNodes.runId, ids), eq(runNodes.status, "running")))
      .run();
    tx.update(runNodes)
      .set({ status: "skipped" })
      .where(and(inArray(runNodes.runId, ids), eq(runNodes.status, "pending")))
      .run();
    for (const id of ids) {
      closeRunningRounds(id, "failed", now, ORPHAN_ERROR, tx);
      recordSkippedRounds(
        id,
        pending.filter((row) => row.runId === id).map((row) => row.nodeId),
        now,
        tx,
      );
    }
  });
  console.log(`[reconcile] 已失败化 ${ids.length} 个中断的运行`);
}
