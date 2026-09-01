/** 内部简历评分入口测试：输出契约破坏时必须在付费 startRun 前失败。 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema";
import {
  RESUME_MATCH_RESULT_ARTIFACT,
  RESUME_MATCH_RESULT_SCHEMA_TEXT,
} from "../lib/resume-match";
import type { ResolvedWorkflow } from "./resolve";

const controls = vi.hoisted(() => ({
  resolveWorkflow: vi.fn(),
  startRun: vi.fn(),
}));

vi.mock("@/server/resolve", () => ({ resolveWorkflow: controls.resolveWorkflow }));
vi.mock("@/server/engine/runner", () => ({ startRun: controls.startRun }));
vi.mock("@/server/fs-safety", () => ({
  isWithinData: () => true,
  resolveWithinData: (value: string) => value,
}));

const sqlite = new Database(":memory:");
sqlite.exec(`
CREATE TABLE workflows (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE object_types (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
  description TEXT NOT NULL, json_schema TEXT, builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE workflow_nodes (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, kind TEXT NOT NULL,
  action_id TEXT, object_type_id TEXT, label TEXT NOT NULL DEFAULT '',
  x REAL NOT NULL DEFAULT 0, y REAL NOT NULL DEFAULT 0
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL,
  workflow_name TEXT NOT NULL DEFAULT '', error TEXT, run_dir TEXT, imports TEXT,
  started_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE TABLE run_nodes (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
  label TEXT NOT NULL, status TEXT NOT NULL, snapshot TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
  inputs TEXT, outputs TEXT, session_id TEXT, error TEXT,
  started_at INTEGER, finished_at INTEGER
);
`);
(globalThis as unknown as { ontoflowDb?: unknown }).ontoflowDb = drizzle(sqlite, { schema });

const { readResumeMatchRun, startResumeMatch } = await import("./resume-match");

const workflowId = "resume-workflow";
const resultTypeId = "resume-result-type";
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ontoflow-resume-match-"));
const invocation = {
  job: { kind: "file" as const, file: { path: "uploads/job.md", name: "job.md", mime: "text/markdown" } },
  resume: { kind: "file" as const, file: { path: "uploads/resume.md", name: "resume.md", mime: "text/markdown" } },
};

function resolved(options: { outputLabel?: string; artifactPath?: string } = {}): ResolvedWorkflow {
  const port = (
    name: string,
    kind: "file" | "json",
    objectTypeId: string,
    artifactPath: string | null = null,
  ) => ({
    name,
    kind,
    objectTypeId,
    objectTypeName: kind === "json" ? "评分报告" : "文件",
    artifactPath,
    exitName: null,
  });
  return {
    workflow: {
      id: workflowId,
      name: "简历匹配评分",
      description: "测试",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    nodes: [
      {
        id: "job-input",
        kind: "input",
        label: "岗位JD",
        inputs: [],
        outputs: [port("value", "file", "job-type")],
      },
      {
        id: "resume-input",
        kind: "input",
        label: "简历",
        inputs: [],
        outputs: [port("value", "file", "resume-type")],
      },
      {
        id: "report-action",
        kind: "action",
        label: "汇总",
        inputs: [],
        outputs: [
          port(
            "结果",
            "json",
            resultTypeId,
            options.artifactPath ?? RESUME_MATCH_RESULT_ARTIFACT,
          ),
        ],
      },
      {
        id: "result-output",
        kind: "output",
        label: options.outputLabel ?? "评分结果",
        inputs: [port("value", "json", resultTypeId)],
        outputs: [],
      },
    ],
    edges: [
      {
        id: "result-edge",
        sourceNodeId: "report-action",
        sourcePort: "结果",
        targetNodeId: "result-output",
        targetPort: "value",
      },
    ],
    nodeRows: new Map(),
  };
}

beforeEach(() => {
  sqlite.exec(
    "DELETE FROM run_nodes; DELETE FROM runs; DELETE FROM workflow_nodes; DELETE FROM object_types; DELETE FROM workflows;",
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  sqlite
    .prepare(
      "insert into workflows (id, name, description, created_at, updated_at) values (?, ?, '', 0, 0)",
    )
    .run(workflowId, "简历匹配评分");
  sqlite
    .prepare(
      "insert into object_types (id, name, kind, description, json_schema, created_at, updated_at) values (?, ?, 'json', '', ?, 0, 0)",
    )
    .run(resultTypeId, "评分报告", RESUME_MATCH_RESULT_SCHEMA_TEXT);
  controls.resolveWorkflow.mockReset();
  controls.startRun.mockReset();
  controls.startRun.mockResolvedValue({ ok: true, runId: "run-1" });
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  sqlite.close();
});

describe("简历匹配工作流预检", () => {
  it("完整契约通过后才调用 startRun", async () => {
    controls.resolveWorkflow.mockResolvedValue(resolved());
    await expect(startResumeMatch(invocation)).resolves.toEqual({
      ok: true,
      data: { runId: "run-1" },
    });
    expect(controls.startRun).toHaveBeenCalledOnce();
  });

  it.each([
    ["输出标签", resolved({ outputLabel: "旧评分报告" })],
    ["产物路径", resolved({ artifactPath: "report.json" })],
  ])("%s 被编辑后在 startRun 前失败", async (_name, graph) => {
    controls.resolveWorkflow.mockResolvedValue(graph);
    const result = await startResumeMatch(invocation);
    expect(result.ok).toBe(false);
    expect(controls.startRun).not.toHaveBeenCalled();
  });

  it("JSON Schema 不兼容时在 startRun 前失败", async () => {
    sqlite
      .prepare("update object_types set json_schema = ? where id = ?")
      .run(JSON.stringify({ type: "object" }), resultTypeId);
    controls.resolveWorkflow.mockResolvedValue(resolved());

    await expect(startResumeMatch(invocation)).resolves.toEqual({
      ok: false,
      status: 500,
      error: "「评分结果」必须使用简历匹配的严格 JSON Schema",
    });
    expect(controls.startRun).not.toHaveBeenCalled();
  });
});

describe("简历匹配运行结果", () => {
  it("按 output 节点 id 读取结果，不会误取同名 Action", () => {
    sqlite
      .prepare(
        "insert into workflow_nodes (id, workflow_id, kind, object_type_id, label) values (?, ?, 'output', ?, ?)",
      )
      .run("result-output", workflowId, resultTypeId, "评分结果");
    sqlite
      .prepare(
        "insert into runs (id, workflow_id, status, workflow_name, run_dir, started_at, finished_at) values (?, ?, 'success', ?, ?, 0, 1)",
      )
      .run("run-1", workflowId, "简历匹配评分", tempRoot);
    sqlite
      .prepare(
        "insert into run_nodes (id, run_id, node_id, label, status, outputs) values (?, ?, ?, ?, 'success', ?)",
      )
      .run("action-row", "run-1", "same-label-action", "评分结果", JSON.stringify({}));
    sqlite
      .prepare(
        "insert into run_nodes (id, run_id, node_id, label, status, outputs) values (?, ?, ?, ?, 'success', ?)",
      )
      .run(
        "output-row",
        "run-1",
        "result-output",
        "评分结果",
        JSON.stringify({
          value: {
            kind: "file",
            file: {
              path: path.join(tempRoot, "missing-match-result.json"),
              name: "match-result.json",
              mime: "application/json",
            },
          },
        }),
      );

    expect(readResumeMatchRun("run-1")).toEqual({
      ok: false,
      status: 500,
      error: "评分结果文件不存在或不可读",
    });
  });
});
