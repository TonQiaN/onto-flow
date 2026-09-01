/**
 * Action 执行边界测试：用内存 SQLite 与假的 harness 进程验证会话登记、端口漂移
 * 和回边累计，不发真实模型请求，也不触碰 data/ontoflow.db。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";
import type { ResolvedNode } from "../../lib/graph";
import type { ActionNodeContext } from "./action";

const sqlite = new Database(":memory:");
sqlite.exec(`
CREATE TABLE models (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
  display_name TEXT NOT NULL
);
CREATE TABLE actions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL, rule TEXT NOT NULL DEFAULT '', model_id TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL DEFAULT 'high', max_reentries INTEGER NOT NULL DEFAULT 0,
  on_exhausted TEXT NOT NULL DEFAULT 'fail', created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE object_types (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL
);
CREATE TABLE action_ports (
  id TEXT PRIMARY KEY, action_id TEXT NOT NULL, direction TEXT NOT NULL,
  name TEXT NOT NULL, object_type_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
  artifact_path TEXT, exit_name TEXT
);
CREATE TABLE action_skills (
  action_id TEXT NOT NULL, skill_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE run_nodes (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL, snapshot TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0, session_id TEXT
);
CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, node_id TEXT,
  ts INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT
);
CREATE TABLE node_usage (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
  session_id TEXT NOT NULL, message_id TEXT NOT NULL,
  provider_id TEXT NOT NULL DEFAULT '', model_id TEXT NOT NULL DEFAULT '',
  variant TEXT, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0, finish TEXT, ts INTEGER NOT NULL
);
`);
(globalThis as unknown as { ontoflowDb?: unknown }).ontoflowDb = drizzle(sqlite, {
  schema,
});

const { runActionNode } = await import("./action");
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ontoflow-action-test-"));

function resolvedNode(exitName: string | null = null): ResolvedNode {
  return {
    id: "node-1",
    kind: "action",
    label: "测试 Action",
    inputs: [
      {
        name: "source",
        objectTypeId: "type-input",
        objectTypeName: "PDF 输入",
        kind: "file",
      },
    ],
    outputs: [
      {
        name: "result",
        objectTypeId: "type-1",
        objectTypeName: "测试报告",
        kind: "file",
        artifactPath: "result.md",
        exitName,
      },
    ],
  };
}

function context(options?: {
  round?: number;
  runTurn?: (
    ...args: Parameters<ActionNodeContext["proc"]["runTurn"]>
  ) => Promise<void>;
  runTurnError?: Error;
  closeSession?: (sessionId: string) => Promise<void>;
  dispose?: () => Promise<void>;
  usage?: Record<string, number>;
  inputs?: ActionNodeContext["inputs"];
}): ActionNodeContext {
  const round = options?.round ?? 0;
  const sessionId = round === 0 ? "node-1" : `node-1#${round + 1}`;
  const proc = {
    runTurn: async (...args: Parameters<ActionNodeContext["proc"]["runTurn"]>) => {
      await options?.runTurn?.(...args);
      // 真实链路里用量由 events.ts 在 usage chunk 到达当下写进 node_usage；
      // 这里在回合收束前落一行等价明细，recordUsage 从库里求和。
      if (options?.usage) {
        sqlite
          .prepare(
            "insert into node_usage (id, run_id, node_id, session_id, message_id, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cost, ts) values (?, 'run-1', 'node-1', ?, 'turn1-step1', ?, ?, ?, ?, ?, ?)",
          )
          .run(
            `usage-${sessionId}`,
            sessionId,
            options.usage.inputTokens ?? 0,
            options.usage.outputTokens ?? 0,
            options.usage.reasoningTokens ?? 0,
            options.usage.cacheReadTokens ?? 0,
            options.usage.cost ?? 0,
            Date.now(),
          );
      }
      if (options?.runTurnError) throw options.runTurnError;
      return sessionId;
    },
    sessionOutput: async () => ({ captured: true, value: { result: "result.md" } }),
    closeSession: async (targetSessionId: string) => {
      await options?.closeSession?.(targetSessionId);
    },
    dispose: async () => {
      await options?.dispose?.();
      return { code: 0, signal: null, expected: true };
    },
  };
  return {
    runId: "run-1",
    node: resolvedNode(),
    actionId: "action-1",
    inputs: options?.inputs ?? {},
    proc: proc as unknown as ActionNodeContext["proc"],
    workspace: {
      runId: "run-1",
      workflowId: "workflow-1",
      runDir: workspaceRoot,
      workspaceDir: workspaceRoot,
      logsDir: workspaceRoot,
      homeDir: workspaceRoot,
      pluginsDir: workspaceRoot,
      compositionPath: path.join(workspaceRoot, "cordis.yml"),
      imports: { instructionsDigest: "", items: [] },
    },
    sinks: new Map(),
    round,
    toolFilter: undefined,
  };
}

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM run_nodes;
    DELETE FROM node_usage;
    DELETE FROM action_skills;
    DELETE FROM action_ports;
    DELETE FROM actions;
    DELETE FROM object_types;
    DELETE FROM models;
    INSERT INTO models VALUES ('model-1', 'deepseek-official', 'test-model', '测试模型');
    INSERT INTO object_types VALUES ('type-1', '测试报告', 'file');
    INSERT INTO object_types VALUES ('type-input', 'PDF 输入', 'file');
    INSERT INTO actions VALUES (
      'action-1', '测试 Action', '', '写报告', '', 'model-1', 'high', 0, 'fail', 1, 1
    );
    INSERT INTO action_ports VALUES (
      'port-input', 'action-1', 'input', 'source', 'type-input', 0, NULL, NULL
    );
    INSERT INTO action_ports VALUES (
      'port-1', 'action-1', 'output', 'result', 'type-1', 0, 'result.md', NULL
    );
    INSERT INTO run_nodes VALUES ('run-node-1', 'run-1', 'node-1', NULL, 0, 0, 0, 0, 0, NULL);
  `);
  fs.rmSync(path.join(workspaceRoot, "result.md"), { force: true });
  fs.rmSync(path.join(workspaceRoot, "rounds"), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  sqlite.close();
});

describe("Action 执行时边界", () => {
  it("runTurn 收束前已经把 sessionId 落库，取消入口能找到活跃会话", async () => {
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    fs.writeFileSync(path.join(workspaceRoot, "result.md"), "ok");

    const running = runActionNode(context({ runTurn: () => waiting }));
    await vi.waitFor(() => {
      const row = sqlite
        .prepare("select session_id as sessionId from run_nodes where run_id = 'run-1'")
        .get() as { sessionId: string | null };
      expect(row.sessionId).toBe("node-1");
    });

    release?.();
    await running;
  });

  it("运行开始后出口归属或产物路径漂移都会中止", async () => {
    sqlite.prepare("update action_ports set exit_name = '通过' where id = 'port-1'").run();

    await expect(runActionNode(context())).rejects.toThrow("端口在运行开始后被改动");

    sqlite
      .prepare("update action_ports set exit_name = NULL, artifact_path = 'changed.md' where id = 'port-1'")
      .run();
    await expect(runActionNode(context())).rejects.toThrow("端口在运行开始后被改动");
  });

  it("回边重入的新会话用量累加到节点历史轮次而不是覆盖", async () => {
    sqlite
      .prepare(
        "update run_nodes set input_tokens = 11, output_tokens = 7, reasoning_tokens = 5, cache_read_tokens = 3",
      )
      .run();
    const roundDir = path.join(workspaceRoot, "rounds", "2");
    fs.mkdirSync(roundDir, { recursive: true });
    fs.writeFileSync(path.join(roundDir, "result.md"), "ok");

    await runActionNode(
      context({
        round: 1,
        usage: {
          inputTokens: 13,
          outputTokens: 9,
          reasoningTokens: 6,
          cacheReadTokens: 4,
        },
      }),
    );

    expect(
      sqlite
        .prepare(
          "select input_tokens as inputTokens, output_tokens as outputTokens, reasoning_tokens as reasoningTokens, cache_read_tokens as cacheReadTokens, session_id as sessionId from run_nodes",
        )
        .get(),
    ).toEqual({
      inputTokens: 24,
      outputTokens: 16,
      reasoningTokens: 11,
      cacheReadTokens: 7,
      sessionId: "node-1#2",
    });
  });

  it("模型轮次超时后先关闭会话，再汇总关闭期间到达的最后用量", async () => {
    let closed = false;
    await expect(
      runActionNode(
        context({
          usage: {
            inputTokens: 17,
            outputTokens: 8,
            reasoningTokens: 3,
            cacheReadTokens: 2,
            cost: 0.125,
          },
          runTurnError: new Error("等待会话 node-1 进入 idle 超时"),
          closeSession: async (sessionId) => {
            closed = true;
            sqlite
              .prepare(
                "insert into node_usage (id, run_id, node_id, session_id, message_id, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cost, ts) values ('usage-late', 'run-1', 'node-1', ?, 'turn1-step2', 5, 2, 1, 1, 0.025, ?)",
              )
              .run(sessionId, Date.now());
          },
        }),
      ),
    ).rejects.toThrow("等待会话 node-1 进入 idle 超时");

    expect(closed).toBe(true);
    expect(
      sqlite
        .prepare(
          "select input_tokens as inputTokens, output_tokens as outputTokens, reasoning_tokens as reasoningTokens, cache_read_tokens as cacheReadTokens, cost from run_nodes",
        )
        .get(),
    ).toEqual({
      inputTokens: 22,
      outputTokens: 10,
      reasoningTokens: 4,
      cacheReadTokens: 3,
      cost: 0.15,
    });
    expect(
      sqlite
        .prepare("select type, payload from run_events where type = 'usage'")
        .get(),
    ).toMatchObject({ type: "usage" });
  });

  it("文件输入在真实会话提示中给出原件路径并指示自行转换", async () => {
    fs.writeFileSync(path.join(workspaceRoot, "result.md"), "ok");
    let renderedPrompt = "";

    await runActionNode(
      context({
        inputs: {
          source: [
            {
              kind: "file",
              file: {
                path: "runs/workflow/run/workspace/inputs/input/resume.pdf",
                name: "resume.pdf",
                mime: "application/pdf",
              },
            },
          ],
        },
        runTurn: async (_sessionId, messages) => {
          renderedPrompt = messages[0]?.type === "text" ? messages[0].text : "";
        },
      }),
    );

    expect(renderedPrompt).toContain("inputs/input/resume.pdf");
    expect(renderedPrompt).toContain("原件，未经预处理");
    expect(renderedPrompt).toContain("用 bash 自行转换");
  });
});
