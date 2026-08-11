import { and, asc, eq, gt } from "drizzle-orm";
import { db, runEvents, runNodes, runs } from "@/db";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

const POLL_MS = 500;

/**
 * SSE GET /api/runs/[id]/events
 * 连接即发 event: snapshot（{ run, nodes } 全量），之后 ~500ms 轮询 sqlite：
 * 新 run_events 逐条发 event: log；run/nodes 有变化再发 snapshot；
 * run 到终态且事件发完后发 event: end 并关闭。不依赖进程内 pubsub。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
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

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
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
        const run = db.select().from(runs).where(eq(runs.id, id)).get();
        const nodes = db
          .select()
          .from(runNodes)
          .where(eq(runNodes.runId, id))
          .orderBy(asc(runNodes.startedAt))
          .all();
        return { run, nodes };
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
          if (serialized !== lastSnapshot) {
            lastSnapshot = serialized;
            send("snapshot", snapshot);
          }
          // 终态且本轮没有新事件 → 事件已发完，结束
          if (
            snapshot.run &&
            snapshot.run.status !== "running" &&
            events.length === 0
          ) {
            send("end", {});
            cleanup();
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
