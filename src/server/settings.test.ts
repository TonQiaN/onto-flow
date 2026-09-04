/** 设置写入口的纯校验；先注入内存库，避免模块加载触碰真实 data/ontoflow.db。 */
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, resetTestDb } from "./writers/test-db";

const { sqlite } = await createTestDb();

const {
  DEFAULT_INSTRUCTIONS,
  DEFAULT_SETTINGS,
  parseSettings,
  readSettings,
  replaceSettingsIfCurrent,
  writeSettings,
} = await import("./settings");

beforeEach(() => {
  resetTestDb(sqlite);
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

describe("插件开关", () => {
  it("缺省取出厂值：搜索关、其余开；只发部分键时其它键不受影响", () => {
    const result = parseSettings({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.toggles).toEqual({
        webSearch: false,
        fsSearch: true,
        strReplaceEditor: true,
        todo: true,
        compaction: true,
      });
    }
    const partial = parseSettings({ toggles: { webSearch: true } });
    expect(partial.ok).toBe(true);
    if (partial.ok) {
      expect(partial.data.toggles.webSearch).toBe(true);
      expect(partial.data.toggles.todo).toBe(true);
    }
  });

  it("布尔值原样进出，非布尔值与非对象 400", () => {
    const toggles = { ...DEFAULT_SETTINGS.toggles, webSearch: true, todo: false };
    expect(writeSettings({ ...DEFAULT_SETTINGS, toggles }).ok).toBe(true);
    expect(readSettings().toggles).toEqual(toggles);

    for (const bad of ["true", 1, null, {}]) {
      const result = parseSettings({ ...DEFAULT_SETTINGS, toggles: { compaction: bad } });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.error).toContain("toggles.compaction 必须是布尔值");
      }
    }
    const notObject = parseSettings({ ...DEFAULT_SETTINGS, toggles: [] });
    expect(notObject.ok).toBe(false);
    if (!notObject.ok) expect(notObject.error).toContain("toggles 必须是对象");
  });
});

describe("默认指令", () => {
  it("缺省取出厂四条约定；显式空串也接受", () => {
    const result = parseSettings({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.defaultInstructions).toBe(DEFAULT_INSTRUCTIONS);
      expect(result.data.defaultInstructions).toContain("声明了的产物必须真的写出来");
    }
    const empty = parseSettings({ defaultInstructions: "" });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.data.defaultInstructions).toBe("");
  });

  it("非字符串 400，超过 64 KiB 400，正常正文原样进出", () => {
    for (const bad of [1, null, {}, []]) {
      const result = parseSettings({ ...DEFAULT_SETTINGS, defaultInstructions: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("defaultInstructions 必须是字符串");
    }
    const huge = parseSettings({ ...DEFAULT_SETTINGS, defaultInstructions: "字".repeat(30_000) });
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.error).toContain("64 KiB");

    const text = "# 团队约定\n\n先读再写。\n";
    expect(writeSettings({ ...DEFAULT_SETTINGS, defaultInstructions: text }).ok).toBe(true);
    expect(readSettings().defaultInstructions).toBe(text);
  });
});
