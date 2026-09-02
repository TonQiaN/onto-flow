/** dsh 事件映射测试：tool/result 只带 callId，工具名必须关联先前的 tool/call。 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";
import { usageCostCny } from "../pricing";

const sqlite = new Database(":memory:");
sqlite.exec(`
CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, node_id TEXT,
  ts INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT
);
CREATE TABLE node_usage (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
  session_id TEXT NOT NULL, message_id TEXT NOT NULL, provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL, variant TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0, finish TEXT, ts INTEGER NOT NULL,
  UNIQUE(run_id, session_id, message_id)
);
`);
(globalThis as unknown as { ontoflowDb?: unknown }).ontoflowDb = drizzle(sqlite, { schema });

const {
  clearUnpersistedUsageForSession,
  recordSessionEvent,
  unpersistedUsageForSession,
} = await import("./events");
const context = {
  runId: "run-1",
  nodeId: "node-1",
  sessionId: "session-1",
  providerId: "deepseek-official",
  modelId: "test-model",
  reasoningEffort: "low",
};

beforeEach(() => {
  sqlite.exec("DELETE FROM node_usage; DELETE FROM run_events;");
  clearUnpersistedUsageForSession(context);
});

afterEach(() => clearUnpersistedUsageForSession(context));

describe("工具结果事件关联", () => {
  it("结果乱序到达时仍按 toolCallId 还原各自工具名", () => {
    recordSessionEvent(context, {
      type: "tool/call",
      data: { callId: "call-image", name: "read_image", arguments: "{}" },
    });
    recordSessionEvent(context, {
      type: "tool/call",
      data: { callId: "call-read", name: "read", arguments: "{}" },
    });
    recordSessionEvent(context, {
      type: "tool/result",
      data: {
        message: {
          content: [
            {
              type: "tool-result",
              toolCallId: "call-read",
              content: [{ type: "text", text: "read ok" }],
            },
          ],
        },
      },
    });
    recordSessionEvent(context, {
      type: "tool/result",
      data: {
        message: {
          content: [
            {
              type: "tool-result",
              toolCallId: "call-image",
              content: [{ type: "text", text: "image ok" }],
            },
          ],
        },
      },
    });

    const results = sqlite
      .prepare(
        "select json_extract(payload, '$.tool') as tool, json_extract(payload, '$.status') as status, json_extract(payload, '$.callId') as callId from run_events where json_extract(payload, '$.status') = 'ok' order by id",
      )
      .all();
    expect(results).toEqual([
      { tool: "read", status: "ok", callId: "call-read" },
      { tool: "read_image", status: "ok", callId: "call-image" },
    ]);
  });
});

describe("用量明细写入失败兜底", () => {
  it("保留失败条目，并在同键重放成功后清除内存副本", () => {
    sqlite.exec(`
      CREATE TRIGGER fail_usage_insert
      BEFORE INSERT ON node_usage
      BEGIN SELECT RAISE(ABORT, 'forced usage failure'); END;
    `);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const event = {
      type: "assistant/chunk",
      time: Date.UTC(2026, 7, 31, 2),
      data: {
        turn: 1,
        step: 1,
        chunk: {
          type: "usage",
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            reasoningTokens: 7,
            cacheReadTokens: 3,
            cacheWriteTokens: 4,
          },
        },
      },
    };

    try {
      recordSessionEvent(
        { ...context, modelId: "deepseek-v4-flash" },
        event,
      );
    } finally {
      sqlite.exec("DROP TRIGGER fail_usage_insert;");
      log.mockRestore();
    }

    expect(sqlite.prepare("select count(*) as count from node_usage").get()).toEqual({ count: 0 });
    expect(unpersistedUsageForSession(context)).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      chunks: 1,
    });

    recordSessionEvent({ ...context, modelId: "deepseek-v4-flash" }, event);
    expect(sqlite.prepare("select count(*) as count from node_usage").get()).toEqual({ count: 1 });
    expect(unpersistedUsageForSession(context).chunks).toBe(0);
  });
});

describe("上下文压缩记账", () => {
  // 2026-08-30 是周日，北京时间 10:00 属空闲时段；摘要费用必须按事件到达时刻取半价。
  const summaryTime = Date.UTC(2026, 7, 30, 2);
  const summaryEvent = {
    type: "compaction/summary",
    seq: 9,
    time: summaryTime,
    data: {
      compactionId: "c-1",
      summary: [{ type: "text", text: "摘要正文" }],
      rawOutput: [{ type: "text", text: "摘要正文" }],
      llmStreamCall: true,
      shadowedRange: { start: 2, end: 6 },
      shadowedSeqs: [2, 4, 6],
      shadowedTokenCount: 1200,
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      maxTokens: 8192,
      usage: { inputTokens: 1000, outputTokens: 100, reasoningTokens: 20, cacheReadTokens: 500 },
    },
  };

  it("摘要用量落成一条 node_usage 明细并按到达时刻计价，重放不重复计费", () => {
    recordSessionEvent(context, summaryEvent);
    recordSessionEvent(context, summaryEvent);

    const rows = sqlite
      .prepare(
        "select message_id as messageId, provider_id as providerId, model_id as modelId, variant, input_tokens as inputTokens, output_tokens as outputTokens, reasoning_tokens as reasoningTokens, cache_read_tokens as cacheReadTokens, cost from node_usage",
      )
      .all() as Array<Record<string, unknown>>;
    const expectedCost = usageCostCny(
      "deepseek-official",
      "deepseek-v4-flash",
      { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500 },
      new Date(summaryTime),
    );
    expect(expectedCost).toBeGreaterThan(0);
    expect(rows).toEqual([
      {
        messageId: "compaction:9",
        providerId: "deepseek-official",
        modelId: "deepseek-v4-flash",
        variant: "compaction",
        inputTokens: 1000,
        outputTokens: 100,
        reasoningTokens: 20,
        cacheReadTokens: 500,
        cost: expectedCost,
      },
    ]);
    expect(unpersistedUsageForSession(context).chunks).toBe(0);

    const events = sqlite
      .prepare("select type, payload from run_events order by id")
      .all() as Array<{ type: string; payload: string }>;
    expect(events.map((row) => row.type)).toEqual(["compaction", "compaction"]);
    const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({
      op: "summary",
      status: "ok",
      compactionId: "c-1",
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      summaryChars: 4,
      shadowedNodes: 3,
      shadowedTokenCount: 1200,
      inputTokens: 1000,
      outputTokens: 100,
      reasoningTokens: 20,
      cacheReadTokens: 500,
      cacheWriteTokens: 0,
      costCny: Math.round(expectedCost * 1e6) / 1e6,
    });
    expect(events[0]!.payload).not.toContain("摘要正文");
  });

  it("压缩开始与失败关闭各落一条事件；不带 usage 的摘要回退到会话路由且不落明细", () => {
    recordSessionEvent(context, {
      type: "compaction/start",
      seq: 8,
      time: summaryTime,
      data: { compactionId: "c-2", turn: 3 },
    });
    recordSessionEvent(context, {
      type: "compaction/summary",
      seq: 9,
      time: summaryTime,
      data: {
        compactionId: "c-2",
        summary: [{ type: "text", text: "无用量的摘要" }],
        shadowedRange: { start: 2, end: 2 },
        shadowedSeqs: [2],
        shadowedTokenCount: 300,
        provider: "",
        model: "",
      },
    });
    recordSessionEvent(context, {
      type: "compaction/end",
      seq: 11,
      time: summaryTime,
      data: { compactionId: "c-2", turn: 3 },
    });
    recordSessionEvent(context, {
      type: "compaction/end",
      seq: 12,
      time: summaryTime,
      data: { compactionId: "c-2", turn: 3, error: "summary is not smaller than the shadowed content" },
    });

    expect(sqlite.prepare("select count(*) as count from node_usage").get()).toEqual({ count: 0 });
    const payloads = (
      sqlite.prepare("select payload from run_events order by id").all() as Array<{ payload: string }>
    ).map((row) => JSON.parse(row.payload) as Record<string, unknown>);
    expect(payloads).toEqual([
      { op: "summary", status: "running", compactionId: "c-2", turn: 3 },
      {
        op: "summary",
        status: "ok",
        compactionId: "c-2",
        provider: "deepseek-official",
        model: "test-model",
        summaryChars: 6,
        shadowedNodes: 1,
        shadowedTokenCount: 300,
        usageReported: false,
      },
      {
        op: "summary",
        status: "error",
        compactionId: "c-2",
        error: "summary is not smaller than the shadowed content",
      },
    ]);
  });

  it("裁剪替换的 tool/result 不重复落工具事件，compaction/prune 落一条裁剪事件", () => {
    recordSessionEvent(context, {
      type: "tool/call",
      seq: 3,
      data: { callId: "call-1", name: "read", arguments: "{}" },
    });
    recordSessionEvent(context, {
      type: "tool/result",
      seq: 4,
      surfaceOp: "append",
      data: {
        message: {
          content: [
            { type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "原始结果" }] },
          ],
        },
      },
    });
    recordSessionEvent(context, {
      type: "compaction/prune",
      seq: 5,
      data: { shadowedRange: { start: 4, end: 4 }, shadowedSeqs: [4], shadowedTokenCount: 900 },
    });
    recordSessionEvent(context, {
      type: "tool/result",
      seq: 6,
      surfaceOp: { op: "replace", start: 4, end: 4 },
      sourceEventSeqs: [4],
      data: {
        message: {
          content: [
            { type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "[已裁剪]" }] },
          ],
        },
      },
    });

    const rows = (
      sqlite.prepare("select type, payload from run_events order by id").all() as Array<{
        type: string;
        payload: string;
      }>
    ).map((row) => ({ type: row.type, payload: JSON.parse(row.payload) as Record<string, unknown> }));
    expect(rows).toEqual([
      { type: "tool", payload: expect.objectContaining({ tool: "read", status: "running" }) },
      { type: "tool", payload: expect.objectContaining({ tool: "read", status: "ok", output: "原始结果" }) },
      {
        type: "compaction",
        payload: { op: "prune", status: "ok", shadowedNodes: 1, shadowedTokenCount: 900 },
      },
    ]);
  });
});
