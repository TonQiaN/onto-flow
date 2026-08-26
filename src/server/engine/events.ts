/**
 * dsh 会话事件 → run_events / node_usage 落库。
 *
 * 运行详情页与监控台的日志面都只读数据库（两条 SSE 端点各自轮询 SQLite，
 * 进程内没有 pubsub），所以事件必须在到达的当下就写进去，页面才有实时感。
 *
 * 事件词汇沿用既有的五种：text / reasoning / tool / session.idle / session.error；
 * 上游 dsh 的事件种类远多于这些，只有能落到这五种上的才记，其余丢弃——
 * 完整的会话记录本来就在运行目录的 sessions/*.jsonl 里，这里只是给人看的摘要。
 */
import { sql } from "drizzle-orm";
import { db, nodeUsage, runEvents } from "@/db";

/** 上游 SessionEvent 的结构在 wire 上是开放的，这里只narrow 出用得上的形状。 */
interface RawEvent {
  type?: string;
  time?: number;
  data?: Record<string, unknown>;
}

interface ContentBlock {
  type?: string;
  text?: string;
}

export interface EventSinkContext {
  runId: string;
  nodeId: string;
  sessionId: string;
  providerId: string;
  modelId: string;
  reasoningEffort: string;
}

/** 把一条 dsh 会话事件落成 run_events（可能零行、可能多行）与 node_usage。 */
export function recordSessionEvent(ctx: EventSinkContext, event: unknown): void {
  const raw = event as RawEvent;
  const ts = new Date(typeof raw.time === "number" ? raw.time : Date.now());
  const data = raw.data ?? {};

  switch (raw.type) {
    case "assistant/message": {
      const message = data.message as { content?: ContentBlock[] } | undefined;
      for (const block of message?.content ?? []) {
        if (typeof block.text !== "string" || block.text === "") continue;
        if (block.type === "reasoning") {
          insert(ctx, ts, "reasoning", { text: block.text });
        } else if (block.type === "text") {
          insert(ctx, ts, "text", { text: block.text });
        }
      }
      return;
    }
    case "tool/call": {
      insert(ctx, ts, "tool", {
        tool: str(data.name),
        status: "running",
        callId: str(data.callId),
        sessionId: ctx.sessionId,
        input: str(data.arguments),
      });
      return;
    }
    case "tool/result": {
      const message = data.message as
        | {
            content?: Array<{
              toolCallId?: unknown;
              isError?: boolean;
              content?: ContentBlock[];
            }>;
          }
        | undefined;
      const first = message?.content?.[0];
      const callId = str(first?.toolCallId);
      const output = (first?.content ?? [])
        .map((b) => (typeof b.text === "string" ? b.text : ""))
        .join("");
      const failed = first?.isError === true || data.error !== undefined;
      insert(ctx, ts, "tool", {
        // tool/result 本身没有 name；用 ToolResultBlock.toolCallId 关联同会话先落库的 call。
        tool: toolNameForCall(ctx, callId),
        status: failed ? "error" : "ok",
        callId,
        sessionId: ctx.sessionId,
        ...(failed ? { error: output } : { output }),
      });
      return;
    }
    case "turn/end": {
      const reason = data.reason as
        | { kind?: string; error?: { message?: string } }
        | undefined;
      if (reason?.kind === "error") {
        insert(ctx, ts, "session.error", {
          error: reason.error?.message ?? "回合以错误结束",
        });
      }
      insert(ctx, ts, "session.idle", { reason: str(reason?.kind) });
      return;
    }
    case "assistant/chunk": {
      const chunk = data.chunk as
        | { type?: string; usage?: Record<string, number> }
        | undefined;
      if (chunk?.type !== "usage" || !chunk.usage) return;
      recordUsage(ctx, ts, data, chunk.usage);
      return;
    }
    default:
      return;
  }
}

/** tool/call 先于 tool/result 到达；持久化关联让 HMR 与事件回放都不依赖进程内 Map。 */
function toolNameForCall(ctx: EventSinkContext, callId: string): string {
  if (!callId) return "";
  const row = db.get<{ tool: string | null }>(sql`
    select json_extract(payload, '$.tool') as tool
      from run_events
     where run_id = ${ctx.runId}
       and node_id = ${ctx.nodeId}
       and type = 'tool'
       and json_extract(payload, '$.status') = 'running'
       and json_extract(payload, '$.callId') = ${callId}
       and json_extract(payload, '$.sessionId') = ${ctx.sessionId}
     order by id desc
     limit 1
  `);
  return row?.tool ?? "";
}

function insert(
  ctx: EventSinkContext,
  ts: Date,
  type: string,
  payload: Record<string, unknown>,
): void {
  try {
    db.insert(runEvents)
      .values({ runId: ctx.runId, nodeId: ctx.nodeId, ts, type, payload })
      .run();
  } catch (err) {
    // 日志写不进去不该让运行失败：运行本身的权威记录是 runs/run_nodes。
    console.error("[engine] 事件落库失败", ctx.runId, ctx.nodeId, err);
  }
}

/**
 * 每个 step 一条用量明细。上游一个 step 只发一条 usage chunk 且不累积，
 * 所以直接按 (sessionId, turn:step) 唯一化即可——不存在同一条消息重复上报。
 */
function recordUsage(
  ctx: EventSinkContext,
  ts: Date,
  data: Record<string, unknown>,
  usage: Record<string, number>,
): void {
  const messageId = `turn${num(data.turn)}-step${num(data.step)}`;
  try {
    db.insert(nodeUsage)
      .values({
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        sessionId: ctx.sessionId,
        messageId,
        providerId: ctx.providerId,
        modelId: ctx.modelId,
        variant: ctx.reasoningEffort,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        reasoningTokens: usage.reasoningTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        ts,
      })
      .onConflictDoNothing()
      .run();
  } catch (err) {
    console.error("[engine] 用量落库失败", ctx.runId, ctx.nodeId, err);
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
