import {
  getLiveSessions,
  getLogsAfter,
  getMaxEventId,
  getOverview,
} from "@/server/monitor/metrics";

export const dynamic = "force-dynamic";

/** 推送节奏：2 秒一轮 */
const TICK_MS = 2000;
/** 单次查询的日志批大小 */
const LOG_BATCH = 200;
/**
 * 一轮 tick 允许追平的日志上限。并行运行的交错写入很容易超过单批：
 * 只推一批就停会让实时日志永久落后于写入速率，因此每拍分批追到没有新行
 * 或触到这个上限为止；上限防止一次巨量回补把响应流和事件循环都噎住。
 */
const LOG_MAX_PER_TICK = 2000;
/** 心跳（注释帧）间隔：30 秒，用来尽快发现半开连接 */
const PING_EVERY_TICKS = 15;

/**
 * SSE GET /api/monitor/stream — 全局监控流。
 *
 * 连接即发 event: overview 与 event: sessions（全量），随后每 2 秒轮询 sqlite：
 * 载荷 JSON 指纹变了才推（监控页多半长时间静止，别拿相同数据刷屏）；
 * event: logs 推自上次 id 之后的新 run_events（每轮最多 50 条，基线是连接时的 max(id)，
 * 不回放历史——历史走 /api/monitor/logs 的游标分页）。
 * 与运行详情页的 SSE 一样不依赖进程内 pubsub，只轮询 sqlite；客户端断开即结束。
 */
export async function GET(request: Request) {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastOverview = "";
      let lastSessions = "";
      let lastEventId = 0;
      let ticks = 0;

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

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };

      const ping = () => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          cleanup();
        }
      };

      const tick = () => {
        if (closed) return;
        try {
          const overview = getOverview();
          const overviewJson = JSON.stringify(overview);
          if (overviewJson !== lastOverview) {
            lastOverview = overviewJson;
            send("overview", overview);
          }

          const sessions = getLiveSessions();
          const sessionsJson = JSON.stringify(sessions);
          if (sessionsJson !== lastSessions) {
            lastSessions = sessionsJson;
            send("sessions", sessions);
          }

          let pulled = 0;
          for (;;) {
            const items = getLogsAfter(lastEventId, LOG_BATCH);
            if (items.length === 0) break;
            lastEventId = items[items.length - 1].id;
            send("logs", { items });
            pulled += items.length;
            if (items.length < LOG_BATCH || pulled >= LOG_MAX_PER_TICK) break;
          }

          ticks += 1;
          if (ticks % PING_EVERY_TICKS === 0) ping();
        } catch (err) {
          console.error("[monitor sse] 轮询失败", err);
          cleanup();
        }
      };

      // 连接即发全量；日志基线定在当前最大 id，只推之后产生的增量
      try {
        lastEventId = getMaxEventId();
        const overview = getOverview();
        lastOverview = JSON.stringify(overview);
        send("overview", overview);
        const sessions = getLiveSessions();
        lastSessions = JSON.stringify(sessions);
        send("sessions", sessions);
      } catch (err) {
        console.error("[monitor sse] 初始载荷失败", err);
        cleanup();
        return;
      }

      timer = setInterval(tick, TICK_MS);
      request.signal.addEventListener("abort", cleanup);
      // 连接在初始载荷期间就断了的话，abort 事件已经过去，这里补一次判断
      if (request.signal.aborted) cleanup();
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
