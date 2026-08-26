/** 设置写入口的纯校验；先注入内存库，避免模块加载触碰真实 data/ontoflow.db。 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import * as schema from "../db/schema";

(globalThis as unknown as { ontoflowDb?: unknown }).ontoflowDb = drizzle(
  new Database(":memory:"),
  { schema },
);

const { parseSettings } = await import("./settings");

function httpServer(headers: unknown) {
  return {
    mcpServers: [
      {
        name: "test-http",
        enabled: true,
        transport: "streamable-http",
        url: "https://example.invalid/mcp",
        headers,
      },
    ],
  };
}

describe("MCP HTTP headers 校验", () => {
  it.each([null, [], ["x"]])("拒绝非普通对象：%j", (headers) => {
    const result = parseSettings(httpServer(headers));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toContain("headers 必须是对象");
    }
  });

  it("只接受空对象，非空 header 不会进入会落盘的组合", () => {
    const empty = parseSettings(httpServer({}));
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.data.mcpServers[0]?.headers).toEqual({});

    for (const headers of [
      { "X-Tenant": "development" },
      { "X-Retry": 3 },
      { Authorization: "Bearer secret" },
    ]) {
      const result = parseSettings(httpServer(headers));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("暂不支持自定义 headers");
    }
  });
});
