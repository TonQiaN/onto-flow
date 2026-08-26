/** dsh 事件映射测试：tool/result 只带 callId，工具名必须关联先前的 tool/call。 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
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
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL,
  UNIQUE(session_id, message_id)
);
`);
(globalThis as unknown as { ontoflowDb?: unknown }).ontoflowDb = drizzle(sqlite, { schema });

const { recordSessionEvent } = await import("./events");
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
});

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
