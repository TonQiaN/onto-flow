/** Next.js 启动钩子：仅 Node 运行时执行一次孤儿运行对账 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { reconcileOrphanRuns } = await import("@/server/engine/reconcile");
    reconcileOrphanRuns();
  }
}
