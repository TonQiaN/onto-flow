/**
 * opencode server 单例（HMR 安全）与进程级事件路由。
 *
 * - createOpencodeServer 固定 127.0.0.1:4977，config 为两个白名单模型定义
 *   low/medium/high/max variants（variant 是 v2 prompt 唯一的思考强度机制）。
 * - spawn 前设置 FLOWFORGE_DB_PATH / FLOWFORGE_DATA_DIR（custom tools 依赖）。
 * - 事件流按 directory 作用域隔离，因此每个会话按其工作区目录单独起事件泵，
 *   sessionID→(runId,nodeId) 路由，text delta 合并节流（≥500ms 或 ≥500 字符），
 *   ToolPart 状态逐条落 run_events，节点结束时 abort。
 * - message.updated 捕获 assistant 消息的 token/费用明细落 node_usage，
 *   并重算 run_nodes 的会话级用量汇总。
 */
import { createOpencodeServer, type ServerOptions } from "@opencode-ai/sdk";
import {
  createOpencodeClient,
  type AssistantMessage,
  type OpencodeClient,
  type Event,
} from "@opencode-ai/sdk/v2/client";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { db, nodeUsage, runEvents, runNodes } from "@/db";

const HOSTNAME = "127.0.0.1";
const PORT = 4977;
const DATA_DIR = path.join(process.cwd(), "data");

const effortVariants = {
  low: { reasoningEffort: "low" },
  medium: { reasoningEffort: "medium" },
  high: { reasoningEffort: "high" },
  max: { reasoningEffort: "max" },
};

/** 为两个白名单模型定义四档 variants（typed Config 未声明 variants 字段，运行时合并生效） */
const opencodeConfig = {
  provider: {
    deepseek: {
      models: { "deepseek-v4-flash": { variants: effortVariants } },
    },
    newapi: {
      models: { "openai/gpt-5.6-luna": { variants: effortVariants } },
    },
  },
} as unknown as ServerOptions["config"];

export interface SessionRoute {
  runId: string;
  nodeId: string;
}

interface TextBuffer {
  text: string;
  lastFlush: number;
}

interface OpencodeGlobals {
  flowforgeOpencodeServer?: Promise<{ url: string; close(): void }>;
  flowforgeSessionRoutes?: Map<string, SessionRoute>;
  flowforgeTextBuffers?: Map<string, TextBuffer>;
  flowforgeSessionErrors?: Map<string, unknown>;
  flowforgeSessionPumps?: Map<string, AbortController>;
}

const g = globalThis as OpencodeGlobals;

const sessionRoutes: Map<string, SessionRoute> =
  g.flowforgeSessionRoutes ?? new Map();
g.flowforgeSessionRoutes = sessionRoutes;

const textBuffers: Map<string, TextBuffer> = g.flowforgeTextBuffers ?? new Map();
g.flowforgeTextBuffers = textBuffers;

const sessionErrors: Map<string, unknown> =
  g.flowforgeSessionErrors ?? new Map();
g.flowforgeSessionErrors = sessionErrors;

const sessionPumps: Map<string, AbortController> =
  g.flowforgeSessionPumps ?? new Map();
g.flowforgeSessionPumps = sessionPumps;

const BASE_URL = `http://${HOSTNAME}:${PORT}`;

/** 端口上是否已经有一个活着的 opencode server（1 秒探活） */
async function probeExisting(): Promise<boolean> {
  try {
    const res = await fetch(new URL("/doc", BASE_URL), {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

/**
 * 启动（或复用）opencode server 单例，返回 baseUrl。
 *
 * 端口上已有存活实例时直接复用，不再尝试自己 spawn——Next 进程重启（dev 热重启、
 * 崩溃拉起）后，上一个进程 spawn 的 opencode 往往还占着 4977，此时 createOpencodeServer
 * 会以 ServerError 失败，整台引擎就此瘫掉直到人工 kill 掉孤儿进程。复用是正确语义：
 * 这本来就是一台机器共用一个 server（会话级隔离由 session + 工作区目录保证）。
 */
export async function getOpencodeUrl(): Promise<string> {
  if (!g.flowforgeOpencodeServer) {
    // custom tools 在 opencode（bun）运行时里靠这两个环境变量定位数据库与备份目录
    process.env.FLOWFORGE_DB_PATH = path.join(DATA_DIR, "flowforge.db");
    process.env.FLOWFORGE_DATA_DIR = DATA_DIR;
    g.flowforgeOpencodeServer = (async () => {
      if (await probeExisting()) {
        console.log(`[opencode] 复用已在 ${BASE_URL} 运行的 server`);
        return { url: BASE_URL, close: () => {} };
      }
      return createOpencodeServer({
        hostname: HOSTNAME,
        port: PORT,
        timeout: 30_000,
        config: opencodeConfig,
      });
    })().catch((err) => {
      g.flowforgeOpencodeServer = undefined;
      throw err;
    });
  }
  const server = await g.flowforgeOpencodeServer;
  return server.url;
}

/** 取绑定到指定工作区目录的 v2 客户端 */
export async function getOpencodeClient(
  directory?: string,
): Promise<OpencodeClient> {
  const url = await getOpencodeUrl();
  return createOpencodeClient({ baseUrl: url, directory });
}

/**
 * 注册 session → (runId, nodeId) 路由并启动该工作区的事件泵。
 * opencode 的事件流按 directory 作用域隔离（全局订阅收不到其他工作区的事件），
 * 因此每个会话按其工作区目录单独订阅，节点结束时 abort。
 */
export function registerSession(
  sessionID: string,
  route: SessionRoute,
  directory: string,
): void {
  sessionRoutes.set(sessionID, route);
  const controller = new AbortController();
  sessionPumps.set(sessionID, controller);
  void pumpEvents(directory, controller.signal);
}

/** 节点结束时调用：flush 残余文本增量、停掉事件泵并解除路由 */
export function releaseSession(sessionID: string): void {
  flushText(sessionID);
  sessionPumps.get(sessionID)?.abort();
  sessionPumps.delete(sessionID);
  sessionRoutes.delete(sessionID);
  textBuffers.delete(sessionID);
  sessionErrors.delete(sessionID);
}

/** 引擎在 parts 为空时用它取 session.error 事件里的 provider 错误详情 */
export function getLastSessionError(sessionID: string): unknown {
  return sessionErrors.get(sessionID);
}

async function pumpEvents(
  directory: string,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const url = await getOpencodeUrl();
      const client = createOpencodeClient({ baseUrl: url });
      const result = await client.event.subscribe({ directory }, { signal });
      for await (const ev of result.stream as AsyncGenerator<Event>) {
        if (signal.aborted) return;
        try {
          handleEvent(ev);
        } catch (err) {
          console.error("[opencode] 事件处理失败", err);
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      console.error("[opencode] 事件流中断，1 秒后重连", err);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function handleEvent(ev: Event): void {
  switch (ev.type) {
    case "message.part.delta": {
      const { sessionID, field, delta } = ev.properties;
      if (field !== "text") return;
      if (!sessionRoutes.has(sessionID)) return;
      const buf = textBuffers.get(sessionID) ?? {
        text: "",
        lastFlush: Date.now(),
      };
      buf.text += delta;
      textBuffers.set(sessionID, buf);
      if (buf.text.length >= 500 || Date.now() - buf.lastFlush >= 500) {
        flushText(sessionID);
      }
      return;
    }
    case "message.part.updated": {
      const { sessionID, part } = ev.properties;
      const route = sessionRoutes.get(sessionID);
      if (!route || part.type !== "tool") return;
      const state = part.state;
      insertRunEvent(route, "tool", {
        tool: part.tool,
        callID: part.callID,
        status: state.status,
        title: "title" in state ? (state.title ?? null) : null,
        input:
          "input" in state ? truncate(safeJson(state.input)) : null,
        output: state.status === "completed" ? truncate(state.output) : null,
        error: state.status === "error" ? truncate(state.error) : null,
      });
      return;
    }
    case "message.updated": {
      const { sessionID, info } = ev.properties;
      const route = sessionRoutes.get(sessionID);
      if (!route || info.role !== "assistant" || !info.tokens) return;
      recordUsage(route, sessionID, info);
      return;
    }
    case "session.error": {
      const sessionID = ev.properties.sessionID;
      if (!sessionID) return;
      sessionErrors.set(sessionID, ev.properties.error ?? null);
      const route = sessionRoutes.get(sessionID);
      if (!route) return;
      flushText(sessionID);
      insertRunEvent(route, "session.error", {
        error: (ev.properties.error ?? null) as unknown as Record<
          string,
          unknown
        > | null,
      });
      return;
    }
    case "session.idle": {
      const sessionID = ev.properties.sessionID;
      const route = sessionRoutes.get(sessionID);
      if (!route) return;
      flushText(sessionID);
      insertRunEvent(route, "session.idle", {});
      return;
    }
    default:
      return;
  }
}

function flushText(sessionID: string): void {
  const buf = textBuffers.get(sessionID);
  if (!buf || buf.text.length === 0) return;
  const route = sessionRoutes.get(sessionID);
  if (route) insertRunEvent(route, "text", { text: buf.text });
  textBuffers.set(sessionID, { text: "", lastFlush: Date.now() });
}

/**
 * assistant 消息的用量落库。
 *
 * 同一条消息会随生成过程多次 message.updated（tokens 逐步补全），因此明细按
 * (sessionId, messageId) upsert；run_nodes 的六个汇总字段用 SUM **重算**而不是
 * 累加——累加会把同一条消息数很多遍。
 */
function recordUsage(
  route: SessionRoute,
  sessionID: string,
  info: AssistantMessage,
): void {
  const usage = {
    providerId: info.providerID ?? "",
    modelId: info.modelID ?? "",
    variant: info.variant ?? null,
    finish: info.finish ?? null,
    inputTokens: info.tokens.input ?? 0,
    outputTokens: info.tokens.output ?? 0,
    reasoningTokens: info.tokens.reasoning ?? 0,
    cacheReadTokens: info.tokens.cache?.read ?? 0,
    cacheWriteTokens: info.tokens.cache?.write ?? 0,
    cost: info.cost ?? 0,
    ts: new Date(info.time.completed ?? info.time.created),
  };

  try {
    db.insert(nodeUsage)
      .values({
        runId: route.runId,
        nodeId: route.nodeId,
        sessionId: sessionID,
        messageId: info.id,
        ...usage,
      })
      .onConflictDoUpdate({
        target: [nodeUsage.sessionId, nodeUsage.messageId],
        set: usage,
      })
      .run();
    rollupNodeUsage(route);
  } catch (err) {
    console.error("[opencode] node_usage 写入失败", err);
  }
}

/** 重算该 (runId,nodeId) 下全部 node_usage 的合计，写回 run_nodes */
function rollupNodeUsage(route: SessionRoute): void {
  const totals = db
    .select({
      inputTokens: sql<number>`coalesce(sum(${nodeUsage.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${nodeUsage.outputTokens}), 0)`,
      reasoningTokens: sql<number>`coalesce(sum(${nodeUsage.reasoningTokens}), 0)`,
      cacheReadTokens: sql<number>`coalesce(sum(${nodeUsage.cacheReadTokens}), 0)`,
      cacheWriteTokens: sql<number>`coalesce(sum(${nodeUsage.cacheWriteTokens}), 0)`,
      cost: sql<number>`coalesce(sum(${nodeUsage.cost}), 0)`,
    })
    .from(nodeUsage)
    .where(
      and(
        eq(nodeUsage.runId, route.runId),
        eq(nodeUsage.nodeId, route.nodeId),
      ),
    )
    .get();
  if (!totals) return;
  db.update(runNodes)
    .set(totals)
    .where(
      and(eq(runNodes.runId, route.runId), eq(runNodes.nodeId, route.nodeId)),
    )
    .run();
}

function insertRunEvent(
  route: SessionRoute,
  type: string,
  payload: Record<string, unknown>,
): void {
  try {
    db.insert(runEvents)
      .values({
        runId: route.runId,
        nodeId: route.nodeId,
        ts: new Date(),
        type,
        payload,
      })
      .run();
  } catch (err) {
    console.error("[opencode] run_events 写入失败", err);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function truncate(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
}
