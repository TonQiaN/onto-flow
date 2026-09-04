import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, runNodes, runs } from "@/db";
import { handle, jsonError } from "@/lib/http";
import { readAgentTrajectory } from "@/server/harness/trajectory";
import { readLatestRoundSnapshot } from "@/server/run-rounds";

export const dynamic = "force-dynamic";

/**
 * 节点快照里的技能集：slug → 展示名。会话日志里的预载注入只带 slug，轨迹面板
 * 要靠这张表把它标成「预载技能：<名>」。快照读该节点仍留着快照的最大一轮——技能集在
 * 受理时冻结、各轮同源。历史快照缺字段、或快照被事件清理置空时给空表，面板退回显示 slug。
 */
function snapshotSkillNames(snapshot: unknown): Record<string, string> {
  const names: Record<string, string> = {};
  const skills =
    snapshot && typeof snapshot === "object"
      ? (snapshot as { skills?: unknown }).skills
      : undefined;
  if (!Array.isArray(skills)) return names;
  for (const item of skills) {
    if (!item || typeof item !== "object") continue;
    const { slug, name } = item as { slug?: unknown; name?: unknown };
    if (typeof slug === "string" && typeof name === "string") names[slug] = name;
  }
  return names;
}

/** GET /api/runs/[id]/nodes/[nodeId]/trajectory — 单个 Action 的逐轮会话轨迹。 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  return handle(async () => {
    const { id, nodeId } = await params;
    const run = db.select().from(runs).where(eq(runs.id, id)).get();
    if (!run) return jsonError(404, "运行不存在");
    const node = db
      .select()
      .from(runNodes)
      .where(and(eq(runNodes.runId, id), eq(runNodes.nodeId, nodeId)))
      .get();
    if (!node) return jsonError(404, "运行节点不存在");

    const trajectory = readAgentTrajectory({
      runDir: run.runDir,
      nodeId,
      activeSessionId:
        run.status === "running" && node.status === "running" ? node.sessionId : null,
      skillNames: snapshotSkillNames(readLatestRoundSnapshot(id, nodeId)),
    });
    return NextResponse.json(trajectory);
  });
}
