import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { tools } from "@/db";
import type { RunWorkspace } from "@/server/harness/workspace";
import { materializeToolPlugins, toolFilterForAction } from "./capabilities";

const temporaryRoots: string[] = [];

function tool(id: string, name: string, code = `export const name = ${JSON.stringify(name)};`) {
  const now = new Date(0);
  return {
    id,
    name,
    description: "测试工具",
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
  it("中文展示名不会进入插件文件名或组合 entry id", () => {
    const ws = workspace();
    const code = 'export const name = "生成采购单";';
    const [entry] = materializeToolPlugins(ws, [tool("abc-123", "生成采购单", code)]);

    expect(entry.id).toBe("tool-abc-123");
    expect(entry.modulePath).toBe(path.join(ws.pluginsDir, "tool-abc-123.ts"));
    expect(entry.modulePath).toMatch(/^[\x00-\x7f]+$/);
    expect(fs.readFileSync(entry.modulePath, "utf8")).toBe(code);
  });

  it("非 ASCII 工具 id 响亮失败，不会进入组合路径", () => {
    const ws = workspace();
    expect(() => materializeToolPlugins(ws, [tool("中文-id", "展示名")])).toThrow(
      "只允许字母数字开头",
    );
  });

  it("A 引用的 Tool 对未引用它的 B 不可见，同时叠加全局停用清单", () => {
    const custom = tool("tool-a", "dangerous_tool");
    const capabilities = {
      tools: [custom],
      toolNamesByActionId: new Map<string, readonly string[]>([
        ["action-a", [custom.name]],
        ["action-b", []],
      ]),
    };

    expect(toolFilterForAction(capabilities, "action-a", ["bash"])).toEqual({
      deny: ["bash"],
    });
    expect(toolFilterForAction(capabilities, "action-b", ["bash"])).toEqual({
      deny: ["bash", "dangerous_tool"],
    });
  });
});
