/**
 * dsh 会话事件 → run_events / node_usage 落库。
 *
 * 运行详情页与监控台的日志面都只读数据库（两条 SSE 端点各自轮询 SQLite，
 * 进程内没有 pubsub），所以事件必须在到达的当下就写进去，页面才有实时感。
 *
 * 事件词汇：text / reasoning / tool / session.idle / session.error 五种沿用既有，
 * compaction 记录上下文压缩（摘要与工具结果裁剪）；上游 dsh 的事件种类远多于这些，
 * 只有能落到这六种上的才记，其余丢弃——完整的会话记录本来就在运行目录的
 * sessions/*.jsonl 里，这里只是给人看的摘要。本模块是 run_events 唯一的写入者：
 * 用量不再另落事件，逐 chunk 明细在 node_usage、节点累计在 run_nodes，两处就是全部账目。
 *
 * 压缩摘要那次模型调用不经过 agent-loop，因此没有 assistant/chunk 的 usage chunk；
 * 它的用量只挂在 compaction/summary 事件上。这里把它落成 node_usage 一条明细，
 * messageId 取 `compaction:<seq>`——会话内 seq 唯一，不会与 `turnN-stepM` 撞键，
 * 同一事件重放也只落一行；action.ts 按会话对 node_usage 求和，摘要费用随之进入节点累计。
 * 例外：摘要在提交阶段失败（中止、表层被并发改动、commit 抛错）时上游只写 compaction/end
 * 的 error，不写带 usage 的 summary 事件，那一次已经付费的调用无法计费——这是上游事件模型的
 * 限制，本站的用量汇总会少算，不要把这里说成完整计费。
 */
import { sql } from "drizzle-orm";
import { db, nodeUsage, runEvents } from "@/db";
import { usageCostCny } from "@/server/pricing";

/** 上游 SessionEvent 的结构在 wire 上是开放的，这里只narrow 出用得上的形状。 */
interface RawEvent {
  type?: string;
  seq?: number;
  time?: number;
  data?: Record<string, unknown>;
  /** 只有表层事件带；`{ op: "replace" }` 表示这条消息顶替了更早的表层节点。 */
  surfaceOp?: unknown;
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

export interface UsageSessionKey {
  runId: string;
  nodeId: string;
  sessionId: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  chunks: number;
}

interface UnpersistedUsage extends UsageSessionKey, UsageTotals {
  messageId: string;
}

/** 一条要落进 node_usage 的明细；provider/model 允许与会话路由不同（摘要可走别的模型）。 */
interface UsageDetail {
  messageId: string;
  providerId: string;
  modelId: string;
  variant: string;
  usage: Record<string, number>;
}

/** 压缩摘要的用量明细在 variant 列上的标记：它不经过思考强度 waterfall，不能冒充会话的档位。 */
const COMPACTION_VARIANT = "compaction";

// 明细写入偶发失败时不能把已经发生的付费用量一起丢掉。这里只保留失败条目，
// 成功落库仍以 node_usage 为事实源；挂在 globalThis 上避免 HMR 丢失待结算条目。
const usageStore = globalThis as typeof globalThis & {
  ontoflowUnpersistedUsage?: Map<string, UnpersistedUsage>;
};
const unpersistedUsage = usageStore.ontoflowUnpersistedUsage ?? new Map<string, UnpersistedUsage>();
usageStore.ontoflowUnpersistedUsage = unpersistedUsage;

/** 返回本会话没有写进 node_usage 的紧凑汇总，供 Action 最终结算补入。 */
export function unpersistedUsageForSession(key: UsageSessionKey): UsageTotals {
  const total = emptyUsageTotals();
  for (const usage of unpersistedUsage.values()) {
    if (
      usage.runId !== key.runId ||
      usage.nodeId !== key.nodeId ||
      usage.sessionId !== key.sessionId
    ) {
      continue;
    }
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.reasoningTokens += usage.reasoningTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheWriteTokens += usage.cacheWriteTokens;
    total.cost += usage.cost;
    total.chunks += 1;
  }
  return total;
}

/** run_nodes 已成功吸收兜底用量后释放内存；失败则保留，不能提前销账。 */
export function clearUnpersistedUsageForSession(key: UsageSessionKey): void {
  for (const [id, usage] of unpersistedUsage) {
    if (
      usage.runId === key.runId &&
      usage.nodeId === key.nodeId &&
      usage.sessionId === key.sessionId
    ) {
      unpersistedUsage.delete(id);
    }
  }
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
      // 表层替换的 tool/result 是裁剪后的副本（紧随 compaction/prune），原始结果
      // 已经落库；再记一行会让同一个 callId 在日志里出现两次完成。
      if (isReplaceOp(raw.surfaceOp)) return;
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
      const reason = data.reason as { kind?: string; error?: { message?: string } } | undefined;
      if (reason?.kind === "error") {
        insert(ctx, ts, "session.error", {
          error: reason.error?.message ?? "回合以错误结束",
        });
      }
      insert(ctx, ts, "session.idle", { reason: str(reason?.kind) });
      return;
    }
    case "assistant/chunk": {
      const chunk = data.chunk as { type?: string; usage?: Record<string, number> } | undefined;
      if (chunk?.type !== "usage" || !chunk.usage) return;
      persistUsageDetail(ctx, ts, {
        messageId: `turn${num(data.turn)}-step${num(data.step)}`,
        providerId: ctx.providerId,
        modelId: ctx.modelId,
        variant: ctx.reasoningEffort,
        usage: chunk.usage,
      });
      return;
    }
    case "compaction/start": {
      insert(ctx, ts, "compaction", {
        op: "summary",
        status: "running",
        compactionId: str(data.compactionId),
        turn: typeof data.turn === "number" ? data.turn : null,
      });
      return;
    }
    case "compaction/summary": {
      recordCompactionSummary(ctx, ts, raw, data);
      return;
    }
    case "compaction/end": {
      // 正常关闭只是释放锁，摘要事件已经说明压缩完成；只有带 error 的关闭值得记。
      if (typeof data.error !== "string") return;
      insert(ctx, ts, "compaction", {
        op: "summary",
        status: "error",
        compactionId: str(data.compactionId),
        error: data.error,
      });
      return;
    }
    case "compaction/prune": {
      insert(ctx, ts, "compaction", {
        op: "prune",
        status: "ok",
        shadowedNodes: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : 0,
        shadowedTokenCount: num(data.shadowedTokenCount),
      });
      return;
    }
    default:
      return;
  }
}

/**
 * 摘要落地：先按事件自带的 provider/model 计价落 node_usage，再落一条 compaction 事件。
 * 事件载荷只放摘要长度与用量，不放摘要正文——正文在 sessions/*.jsonl 与轨迹面板里。
 */
function recordCompactionSummary(
  ctx: EventSinkContext,
  ts: Date,
  raw: RawEvent,
  data: Record<string, unknown>,
): void {
  const providerId = str(data.provider) || ctx.providerId;
  const modelId = str(data.model) || ctx.modelId;
  const usage = isUsage(data.usage) ? data.usage : undefined;
  const summaryChars = Array.isArray(data.summary)
    ? (data.summary as ContentBlock[]).reduce(
        (total, block) => total + (typeof block?.text === "string" ? block.text.length : 0),
        0,
      )
    : 0;
  let billed: Record<string, unknown> = { usageReported: false };
  if (usage !== undefined) {
    const cost = persistUsageDetail(ctx, ts, {
      messageId: `compaction:${
        Number.isSafeInteger(raw.seq) ? String(raw.seq) : str(data.compactionId) || "unknown"
      }`,
      providerId,
      modelId,
      variant: COMPACTION_VARIANT,
      usage,
    });
    billed = {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      costCny: Math.round(cost * 1e6) / 1e6,
    };
  }
  insert(ctx, ts, "compaction", {
    op: "summary",
    status: "ok",
    compactionId: str(data.compactionId),
    provider: providerId,
    model: modelId,
    summaryChars,
    shadowedNodes: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : 0,
    shadowedTokenCount: num(data.shadowedTokenCount),
    ...billed,
  });
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
      // sessionId 把事件归到轮：回放据此把刻度落在时间轴上正确的那一段（ADR-0018）。
      .values({ runId: ctx.runId, nodeId: ctx.nodeId, sessionId: ctx.sessionId, ts, type, payload })
      .run();
  } catch (err) {
    // 日志写不进去不该让运行失败：运行本身的权威记录是 runs/run_nodes。
    console.error("[engine] 事件落库失败", ctx.runId, ctx.nodeId, err);
  }
}

/**
 * 一条用量明细。上游一个 step 只发一条 usage chunk 且不累积，按
 * (runId, sessionId, messageId) 唯一化去重——会话 id 是画布节点 id，
 * 同一工作流的多次运行会撞出相同 (sessionId, messageId)，必须由 runId 区分。
 * 冲突目标显式声明，只吞同键重放，不吞其他约束错误。费用按这条明细的到达时刻计峰谷。
 * @returns 这条明细的人民币费用（未知模型为 0）
 */
function persistUsageDetail(ctx: EventSinkContext, ts: Date, detail: UsageDetail): number {
  const { messageId, providerId, modelId, variant, usage } = detail;
  const key = usageKey(ctx, messageId);
  const sample: UnpersistedUsage = {
    runId: ctx.runId,
    nodeId: ctx.nodeId,
    sessionId: ctx.sessionId,
    messageId,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    cost: usageCostCny(
      providerId,
      modelId,
      {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
      },
      ts,
    ),
    chunks: 1,
  };
  try {
    db.insert(nodeUsage)
      .values({
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        sessionId: ctx.sessionId,
        messageId,
        providerId,
        modelId,
        variant,
        inputTokens: sample.inputTokens,
        outputTokens: sample.outputTokens,
        reasoningTokens: sample.reasoningTokens,
        cacheReadTokens: sample.cacheReadTokens,
        cacheWriteTokens: sample.cacheWriteTokens,
        cost: sample.cost,
        ts,
      })
      .onConflictDoNothing({
        target: [nodeUsage.runId, nodeUsage.sessionId, nodeUsage.messageId],
      })
      .run();
    // 写入成功或同键已经存在都说明持久层拥有这条明细，清除先前失败的重放副本。
    unpersistedUsage.delete(key);
  } catch (err) {
    unpersistedUsage.set(key, sample);
    console.error("[engine] 用量落库失败", ctx.runId, ctx.nodeId, err);
  }
  return sample.cost;
}

function usageKey(ctx: UsageSessionKey, messageId: string): string {
  return `${ctx.runId}\u0000${ctx.nodeId}\u0000${ctx.sessionId}\u0000${messageId}`;
}

function emptyUsageTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    chunks: 0,
  };
}

function isReplaceOp(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && (value as { op?: unknown }).op === "replace"
  );
}

function isUsage(value: unknown): value is Record<string, number> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { inputTokens?: unknown }).inputTokens === "number" &&
    typeof (value as { outputTokens?: unknown }).outputTokens === "number"
  );
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
