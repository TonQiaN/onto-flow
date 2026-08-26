/**
 * Next.js 启动钩子，仅 Node 运行时执行一次：
 * ① 孤儿运行对账；② 按数据库重建全局技能库的磁盘投影。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reconcileOrphanRuns } = await import("@/server/engine/reconcile");
  reconcileOrphanRuns();
  const { rebuildSkillLibrary } = await import("@/server/skill-library");
  rebuildSkillLibrary();
}
