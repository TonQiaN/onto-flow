/** 设置写入口的纯校验；先注入内存库，避免模块加载触碰真实 data/ontoflow.db。 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema";

const sqlite = new Database(":memory:");
sqlite.exec(`
CREATE TABLE settings (
  id INTEGER PRIMARY KEY,
  document TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`);
(globalThis as unknown as { ontoflowDb?: unknown }).ontoflowDb = drizzle(sqlite, { schema });

const {
  DEFAULT_SETTINGS,
  parseSettings,
  readSettings,
  replaceSettingsIfCurrent,
  writeSettings,
} = await import("./settings");

beforeEach(() => {
  sqlite.exec("DELETE FROM settings;");
});

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

describe("设置比较替换", () => {
  it("当前文档仍是临时版本时原子恢复冒烟前设置", () => {
    const temporary = { ...DEFAULT_SETTINGS, disabledTools: ["bash"] };
    expect(writeSettings(temporary).ok).toBe(true);

    expect(replaceSettingsIfCurrent(temporary, DEFAULT_SETTINGS)).toBe(true);
    expect(readSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("运行期间出现新保存时拒绝用旧快照覆盖", () => {
    const temporary = { ...DEFAULT_SETTINGS, disabledTools: ["bash"] };
    const userVersion = {
      ...temporary,
      credentialRefs: [{ name: "TEAM_API_KEY", purpose: "用户运行期间新增" }],
    };
    expect(writeSettings(temporary).ok).toBe(true);
    expect(writeSettings(userVersion).ok).toBe(true);

    expect(replaceSettingsIfCurrent(temporary, DEFAULT_SETTINGS)).toBe(false);
    expect(readSettings()).toEqual(userVersion);
  });
});

describe("搜索开关", () => {
  it("缺省即关：旧文档与只发部分字段的调用方都不会把搜索悄悄打开", () => {
    const result = parseSettings({});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.webSearchEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.webSearchEnabled).toBe(false);
  });

  it("布尔值原样进出，非布尔值 400", () => {
    expect(writeSettings({ ...DEFAULT_SETTINGS, webSearchEnabled: true }).ok).toBe(true);
    expect(readSettings().webSearchEnabled).toBe(true);

    for (const bad of ["true", 1, null, {}]) {
      const result = parseSettings({ ...DEFAULT_SETTINGS, webSearchEnabled: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.error).toContain("webSearchEnabled 必须是布尔值");
      }
    }
  });
});
