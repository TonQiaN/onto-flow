import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { tools } from "@/db";
import type { RunWorkspace } from "@/server/harness/workspace";
import { materializeToolPlugins, toolFilterForAction } from "./capabilities";

const temporaryRoots: string[] = [];

function tool(
  id: string,
  publicName: string,
  code = "export default async function execute() { return { ok: true }; }",
) {
  const now = new Date(0);
  return {
    id,
    name: `展示名·${publicName}`,
    publicName,
    description: "测试工具",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    output: null,
    timeoutMs: null,
    code,
    createdAt: now,
    updatedAt: now,
  } satisfies typeof tools.$inferSelect;
}

function workspace(): RunWorkspace {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ontoflow-capabilities-"));
  temporaryRoots.push(runDir);
  const pluginsDir = path.join(runDir, "plugins");
  fs.mkdirSync(pluginsDir);
  return {
    runId: "run",
    workflowId: "workflow",
    runDir,
    workspaceDir: path.join(runDir, "workspace"),
    logsDir: path.join(runDir, "logs"),
    homeDir: path.join(runDir, "home"),
    pluginsDir,
    tmpDir: path.join(runDir, "tmp"),
    compositionPath: path.join(runDir, "cordis.yml"),
    imports: { instructionsDigest: "", items: [] },
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("运行 Tool 能力", () => {
  it("Tool 集全部物化：execute 模块原样落盘，包装另成一文件，entry 以 id 派生", () => {
    const ws = workspace();
    const code = "export default async function execute() { return { plan: 1 }; }";
    const [entry] = materializeToolPlugins(ws, [tool("abc-123", "save_plan", code)], {
      envKeys: ["DEEPSEEK_API_KEY"],
    });

    expect(entry.id).toBe("tool-abc-123");
    expect(entry.modulePath).toBe(path.join(ws.pluginsDir, "tool-abc-123.ts"));
    expect(entry.executeModulePath).toBe(path.join(ws.pluginsDir, "tool-abc-123.execute.ts"));
    expect(entry.modulePath).toMatch(/^[\x00-\x7f]+$/);
    expect(fs.readFileSync(entry.executeModulePath, "utf8")).toBe(code);
    const wrapper = fs.readFileSync(entry.modulePath, "utf8");
    expect(wrapper).toContain('"publicName":"save_plan"');
    expect(wrapper).not.toContain("展示名");
  });

  it("非 ASCII 工具 id 响亮失败，不会进入组合路径", () => {
    const ws = workspace();
    expect(() =>
      materializeToolPlugins(ws, [tool("中文-id", "display_name")], { envKeys: [] }),
    ).toThrow("只允许字母数字开头");
  });

  it("deny = 全局停用 ∪（工作流 Tool 公名 − 本 Action 可见公名），按公名不按展示名", () => {
    const custom = tool("tool-a", "dangerous_tool");
    const harmless = tool("tool-b", "harmless_tool");
    const capabilities = {
      tools: [custom, harmless],
      toolNamesByActionId: new Map<string, readonly string[]>([
        ["action-a", [custom.publicName, harmless.publicName]],
        ["action-b", [harmless.publicName]],
        ["action-c", []],
      ]),
    };

    expect(toolFilterForAction(capabilities, "action-a", ["bash"])).toEqual({
      deny: ["bash"],
    });
    expect(toolFilterForAction(capabilities, "action-b", ["bash"])).toEqual({
      deny: ["bash", "dangerous_tool"],
    });
    expect(toolFilterForAction(capabilities, "action-c", [])).toEqual({
      deny: ["dangerous_tool", "harmless_tool"],
    });
    expect(toolFilterForAction(capabilities, "action-a", [])).toBeUndefined();
  });
});
