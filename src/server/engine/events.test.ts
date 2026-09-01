/** dsh 事件映射测试：tool/result 只带 callId，工具名必须关联先前的 tool/call。 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";

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
