/**
 * 进程启动时的孤儿运行对账。
 *
 * run 的终态只在启动 executeRun 的那个进程内保证（内存里的 promise catch）。
 * 若进程在运行中途退出，runs 会永久停在 running、run_nodes 停在 running/pending，
 * 且 SSE 的结束条件（status !== running）永假、无限轮询。单用户本地工作台同一时刻
 * 只有一个进程，因此启动时凡是 running 的 run 必是上次进程遗留的孤儿，一律失败化。
 */
import { and, eq, inArray } from "drizzle-orm";
import { db, runNodes, runs } from "@/db";

export function reconcileOrphanRuns(): void {
  const orphans = db.select({ id: runs.id }).from(runs).where(eq(runs.status, "running")).all();
  if (orphans.length === 0) return;

  const ids = orphans.map((r) => r.id);
  const now = new Date();
  db.update(runs)
    .set({ status: "failed", error: "进程重启，运行被中断", finishedAt: now })
    .where(inArray(runs.id, ids))
    .run();
  db.update(runNodes)
    .set({ status: "failed", error: "进程重启，运行被中断", finishedAt: now })
    .where(and(inArray(runNodes.runId, ids), eq(runNodes.status, "running")))
    .run();
  db.update(runNodes)
    .set({ status: "skipped" })
    .where(and(inArray(runNodes.runId, ids), eq(runNodes.status, "pending")))
    .run();
  console.log(`[reconcile] 已失败化 ${ids.length} 个中断的运行`);
}
