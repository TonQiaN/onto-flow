import { and, asc, eq, gt } from "drizzle-orm";
import { db, runEvents, runs } from "@/db";
import { jsonError } from "@/lib/http";
import { parseRunGraph } from "@/lib/run-graph";
import { listNodeSkeletons, listRoundSkeletons } from "@/server/run-rounds";

export const dynamic = "force-dynamic";

const POLL_MS = 500;
/**
 * 终态后的静默期（tick 数）：取消/失败会先把 run 写成终态，引擎的事件写入此刻还在收尾
 * （flush 残余 text、补 session.idle、重算最终 token/费用）。若「终态 + 本轮无新事件」
 * 就立刻 end，前端会丢掉最后一段日志与最终用量。要求连续 3 个 tick（约 1.5s）既无
 * 新事件、snapshot 指纹也不再变化，才认为收尾真的结束。
 */
const QUIET_TICKS = 3;

/**
 * SSE GET /api/runs/[id]/events
 * 连接即发 event: snapshot（{ run, nodes, rounds } 全量，与 GET /api/runs/[id] 同一形状），
 * 之后 ~500ms 轮询 sqlite：新 run_events 逐条发 event: log（行带 sessionId，据此归到轮）；
 * run / nodes / rounds 任一有变化就重发 snapshot（三者同一指纹）；
 * run 到终态且静默期内再无任何变化后发 event: end 并关闭。不依赖进程内 pubsub。
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const exists = db.select().from(runs).where(eq(runs.id, id)).get();
  if (!exists) return jsonError(404, "运行不存在");

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastEventId = 0;
      let lastSnapshot = "";
      /** 终态后连续「无新事件且 snapshot 未变」的 tick 数，攒够 QUIET_TICKS 才 end */
      let quietTicks = 0;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      };

      const readSnapshot = () => {
        const row = db.select().from(runs).where(eq(runs.id, id)).get();
        // 节点行同样只带骨架：那三个重载荷列是最新一轮的副本，抽屉只认光标所在那一轮的值。
        const nodes = listNodeSkeletons(id);
        // 轮次骨架也进快照与指纹：新的一轮开出来时页面必须立刻拿到，否则回放停在上一轮。
        // 只带骨架——重载荷（输入输出与快照）跟着每 500ms 一帧走等于把同一份大对象反复推送，
        // 抽屉按轮单取（`/api/runs/[id]/nodes/[nodeId]/rounds/[round]`）。
        const rounds = listRoundSkeletons(id);
        return { run: row ? { ...row, graph: parseRunGraph(row.graph) } : row, nodes, rounds };
      };

      const tick = () => {
        if (closed) return;
        try {
          const events = db
            .select()
            .from(runEvents)
            .where(and(eq(runEvents.runId, id), gt(runEvents.id, lastEventId)))
            .orderBy(asc(runEvents.id))
            .all();
          for (const event of events) {
            send("log", event);
            lastEventId = event.id;
          }
          const snapshot = readSnapshot();
          const serialized = JSON.stringify(snapshot);
          const changed = events.length > 0 || serialized !== lastSnapshot;
          if (serialized !== lastSnapshot) {
            lastSnapshot = serialized;
            send("snapshot", snapshot);
          }
          // 终态后进入静默期：只有连续 QUIET_TICKS 轮既无新事件、snapshot 指纹也不变，
          // 才说明事件写入的收尾（残余 text / session.idle / 最终用量）已经写完，可以结束
          if (snapshot.run && snapshot.run.status !== "running") {
            quietTicks = changed ? 0 : quietTicks + 1;
            if (quietTicks >= QUIET_TICKS) {
              send("end", {});
              cleanup();
            }
          } else {
            quietTicks = 0;
          }
        } catch (err) {
          console.error("[sse] 轮询失败", err);
          cleanup();
        }
      };

      // 连接即发全量 snapshot（事件从 id=0 起在首轮 tick 中逐条回放）
      const snapshot = readSnapshot();
      lastSnapshot = JSON.stringify(snapshot);
      send("snapshot", snapshot);

      timer = setInterval(tick, POLL_MS);
      request.signal.addEventListener("abort", cleanup);
      tick();
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
