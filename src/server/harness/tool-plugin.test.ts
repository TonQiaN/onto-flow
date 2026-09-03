/**
 * Tool 包装生成器（ADR-0017）：契约字段原样进包装、execute 模块原样落盘、
 * 路径与 env 白名单是字面量。真 boot 一个带包装的组合放在 composition-boot.test.ts。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { materializeToolPlugin, renderToolPlugin, type ToolPluginRow } from "./tool-plugin";
import { TOOL_RUN_DEFAULT_TIMEOUT_MS, TOOL_RUN_MAX_TIMEOUT_MS } from "./tool-contract";
import type { RunWorkspace } from "./workspace";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sampleTool(overrides: Partial<ToolPluginRow> = {}): ToolPluginRow {
  return {
    id: "sample-1",
    name: "样例工具",
    publicName: "sample_stamp",
    description: "返回收到的参数与工作区路径",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { label: { type: "string", description: "标签" } },
      required: ["label"],
    },
    output: null,
    timeoutMs: null,
    code: "export default async function execute(args, ctx) { return { args, cwd: ctx.cwd }; }",
    ...overrides,
  };
}

function workspace(): RunWorkspace {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ontoflow-tool-plugin-"));
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

const PATHS = {
  workspaceDir: "/runs/w/r/workspace",
  runDir: "/runs/w/r",
  tmpDir: "/runs/w/r/tmp",
  dataDir: "/repo/data",
  dbPath: "/repo/data/ontoflow.db",
};

describe("Tool 包装生成", () => {
  it("包装含公名、描述、参数 schema、路径字面量、env 白名单键名与 execute 模块的 file URL", () => {
    const source = renderToolPlugin(
      sampleTool(),
      PATHS,
      "/runs/w/r/plugins/tool-sample-1.execute.ts",
      {
        envKeys: ["DEEPSEEK_API_KEY", "TEAM_API_KEY", "DEEPSEEK_API_KEY", "ONTOFLOW_DB_PATH"],
      },
    );
    expect(source).toContain('export const name = "tool-sample-1";');
    expect(source).toContain('export const inject = ["tools", "shell", "sandboxPolicy"];');
    expect(source).toContain('"publicName":"sample_stamp"');
    expect(source).toContain('"description":"返回收到的参数与工作区路径"');
    expect(source).toContain(
      '"parameters":{"type":"object","additionalProperties":false,"properties":{"label":{"type":"string","description":"标签"}},"required":["label"]}',
    );
    expect(source).toContain('"output":null');
    expect(source).toContain('"timeoutMs":null');
    expect(source).toContain(`const PATHS = ${JSON.stringify(PATHS)} as const;`);
    // 白名单去重、只记键名；值在调用时从 process.env 取。
    expect(source).toContain(
      'const ENV_KEYS = ["DEEPSEEK_API_KEY","TEAM_API_KEY","ONTOFLOW_DB_PATH"] as const;',
    );
    expect(source).toContain(
      `const EXECUTE_MODULE_URL = ${JSON.stringify(pathToFileURL("/runs/w/r/plugins/tool-sample-1.execute.ts").href)};`,
    );
    expect(source).toContain(`const RUN_DEFAULT_TIMEOUT_MS = ${TOOL_RUN_DEFAULT_TIMEOUT_MS};`);
    expect(source).toContain(`const RUN_MAX_TIMEOUT_MS = ${TOOL_RUN_MAX_TIMEOUT_MS};`);
    // Tool 作者的代码不进包装，中文展示名也不进（它不是模型可见的名字）。
    expect(source).not.toContain("export default async function execute(args, ctx)");
    expect(source).not.toContain("样例工具");
  });

  it("声明了 output 与 timeoutMs 时原样进契约字面量", () => {
    const source = renderToolPlugin(
      sampleTool({
        output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        timeoutMs: 5_000,
      }),
      PATHS,
      "/runs/w/r/plugins/tool-sample-1.execute.ts",
      { envKeys: [] },
    );
    expect(source).toContain(
      '"output":{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}',
    );
    expect(source).toContain('"timeoutMs":5000');
  });

  it("公名不合法、工具 id 不安全、白名单键名非法都在生成时失败", () => {
    const executePath = "/runs/w/r/plugins/tool-x.execute.ts";
    expect(() =>
      renderToolPlugin(sampleTool({ publicName: "Bad-Name" }), PATHS, executePath, { envKeys: [] }),
    ).toThrow("公名「Bad-Name」不合法");
    expect(() =>
      renderToolPlugin(sampleTool({ id: "../escape" }), PATHS, executePath, { envKeys: [] }),
    ).toThrow("只允许字母数字开头");
    expect(() =>
      renderToolPlugin(sampleTool(), PATHS, executePath, { envKeys: ["lower case"] }),
    ).toThrow("形状非法");
  });

  it("物化写两个文件：execute 模块一字不差，包装指向它的绝对路径", () => {
    const ws = workspace();
    const tool = sampleTool();
    const entry = materializeToolPlugin(ws, tool, { envKeys: ["DEEPSEEK_API_KEY"] });
    expect(entry).toEqual({
      id: "tool-sample-1",
      modulePath: path.join(ws.pluginsDir, "tool-sample-1.ts"),
      executeModulePath: path.join(ws.pluginsDir, "tool-sample-1.execute.ts"),
    });
    expect(fs.readFileSync(entry.executeModulePath, "utf8")).toBe(tool.code);
    const wrapper = fs.readFileSync(entry.modulePath, "utf8");
    expect(wrapper).toContain(JSON.stringify(pathToFileURL(entry.executeModulePath).href));
    expect(wrapper).toContain(JSON.stringify(ws.workspaceDir));
    expect(wrapper).toContain(JSON.stringify(ws.tmpDir));
    expect(wrapper).toContain(JSON.stringify(path.join(process.cwd(), "data", "ontoflow.db")));
  });
});
