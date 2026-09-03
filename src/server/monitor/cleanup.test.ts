/** 清理测试：隔离临时 data 根与内存 SQLite，绝不触碰真实运行历史。 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../db/schema";

const testPaths = vi.hoisted(() => ({
  dataDir: `/tmp/ontoflow-cleanup-${process.pid}-${Math.random().toString(16).slice(2)}`,
}));

vi.mock("@/server/fs-safety", () => ({
  DATA_DIR: testPaths.dataDir,
  resolveWithinData(relPath: string): string {
    if (relPath.startsWith("/") || relPath.split(/[\\/]/).includes("..") || relPath === "") {
      throw new Error("测试路径越界");
    }
    return `${testPaths.dataDir}/${relPath}`;
  },
}));

const sqlite = new Database(":memory:");
sqlite.exec(`
CREATE TABLE runs (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL,
  workflow_name TEXT NOT NULL DEFAULT '', error TEXT, run_dir TEXT, imports TEXT,
  started_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE TABLE run_results (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, content TEXT NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE run_nodes (run_id TEXT NOT NULL);
CREATE TABLE run_events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, ts INTEGER NOT NULL, payload TEXT);
CREATE TABLE node_usage (run_id TEXT NOT NULL);
`);
sqlite.pragma("foreign_keys = ON");
const activeRuns = new Set<string>();
(globalThis as unknown as { ontoflowDb?: unknown; ontoflowActiveRuns?: Set<string> }).ontoflowDb =
  drizzle(sqlite, {
    schema,
  });
(globalThis as unknown as { ontoflowActiveRuns?: Set<string> }).ontoflowActiveRuns = activeRuns;

const { deleteRun, runCleanup } = await import("./cleanup");
const old = Date.now() - 3 * 86_400_000;

function makeWorkspace(workflowId: string, runId: string, content = "test") {
  const dir = path.join(testPaths.dataDir, "runs", workflowId, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "artifact.txt"), content);
  fs.utimesSync(dir, new Date(old), new Date(old));
  return dir;
}

function storedRunDir(absolutePath: string): string {
  return path.relative(process.cwd(), absolutePath);
}

beforeEach(() => {
  activeRuns.clear();
  sqlite.exec(
    "DELETE FROM node_usage; DELETE FROM run_events; DELETE FROM run_nodes; DELETE FROM run_results; DELETE FROM runs",
  );
  fs.rmSync(testPaths.dataDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(testPaths.dataDir, "runs"), { recursive: true });
});

afterAll(() => {
  fs.rmSync(testPaths.dataDir, { recursive: true, force: true });
  sqlite.close();
});

describe("运行工作区清理", () => {
  it("按 workflowId/runId 两层布局清理叶子目录并跳过进行中运行", () => {
    // 已知运行实际目录故意不等于 workflow_id/id 约定重建路径。
    const finished = makeWorkspace("stored-owner", "stored-finished");
    const active = makeWorkspace("workflow-1", "run-active");
    const orphan = makeWorkspace("workflow-2", "run-orphan", "orphan");
    // 旧错误实现把 data/runs 的顶层当 runId；这个目录不应被当作运行工作区。
    const direct = path.join(testPaths.dataDir, "runs", "direct-old");
    fs.mkdirSync(direct, { recursive: true });
    fs.writeFileSync(path.join(direct, "artifact.txt"), "direct");
    fs.utimesSync(direct, new Date(old), new Date(old));

    sqlite
      .prepare(
        "insert into runs (id, workflow_id, status, run_dir, started_at) values (?, ?, ?, ?, ?)",
      )
      .run("run-finished", "workflow-1", "success", storedRunDir(finished), old);
    sqlite
      .prepare(
        "insert into runs (id, workflow_id, status, run_dir, started_at) values (?, ?, ?, ?, ?)",
      )
      .run("run-active", "workflow-1", "running", storedRunDir(active), old);

    const preview = runCleanup({ target: "workspaces", beforeDays: 1, dryRun: true });
    expect(preview.affected.count).toBe(2);
    expect(preview.detail).toContain("跳过进行中的运行 1 个");

    const deleted = runCleanup({ target: "workspaces", beforeDays: 1, dryRun: false });
    expect(deleted.affected).toEqual(preview.affected);
    expect(fs.existsSync(finished)).toBe(false);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(active)).toBe(true);
    expect(fs.existsSync(direct)).toBe(true);
  });

  it("run_dir 与 workflow/id 约定路径不同时只删除 run_dir 指向的工作区", () => {
    const actual = makeWorkspace("storage-owner", "actual-leaf");
    const reconstructed = makeWorkspace("workflow-9", "run-9");
    sqlite
      .prepare(
        "insert into runs (id, workflow_id, status, run_dir, started_at) values (?, ?, ?, ?, ?)",
      )
      .run("run-9", "workflow-9", "success", storedRunDir(actual), old);

    const deleted = runCleanup({ target: "runs", beforeDays: 1, dryRun: false });

    expect(deleted.affected.count).toBe(1);
    expect(fs.existsSync(actual)).toBe(false);
    expect(fs.existsSync(reconstructed)).toBe(true);
    expect(sqlite.prepare("select count(*) as count from runs").get()).toEqual({ count: 0 });
  });

  it("run_dir 为空时不从 workflow/id 猜目录", () => {
    const conventional = makeWorkspace("workflow-null", "run-null");
    sqlite
      .prepare(
        "insert into runs (id, workflow_id, status, run_dir, started_at) values (?, ?, ?, NULL, ?)",
      )
      .run("run-null", "workflow-null", "success", old);

    const workspaceCleanup = runCleanup({
      target: "workspaces",
      beforeDays: 1,
      dryRun: false,
    });
    expect(workspaceCleanup.affected.count).toBe(0);
    expect(fs.existsSync(conventional)).toBe(true);

    runCleanup({ target: "runs", beforeDays: 1, dryRun: false });
    expect(fs.existsSync(conventional)).toBe(true);
  });

  it("cancelled 已落库但执行器仍持有时不清理记录、事件或工作区", () => {
    const workspace = makeWorkspace("workflow-settling", "run-settling");
    sqlite
      .prepare(
        "insert into runs (id, workflow_id, status, run_dir, started_at) values (?, ?, ?, ?, ?)",
      )
      .run("run-settling", "workflow-settling", "cancelled", storedRunDir(workspace), old);
    sqlite
      .prepare("insert into run_events (run_id, ts, payload) values (?, ?, ?)")
      .run("run-settling", old, JSON.stringify({ phase: "disposing" }));
    activeRuns.add("run-settling");

    expect(runCleanup({ target: "workspaces", beforeDays: 1, dryRun: true }).affected.count).toBe(
      0,
    );
    expect(runCleanup({ target: "events", beforeDays: 1, dryRun: true }).affected.count).toBe(0);
    expect(runCleanup({ target: "runs", beforeDays: 1, dryRun: true }).affected.count).toBe(0);
    expect(deleteRun("run-settling")).toEqual({
      ok: false,
      status: 409,
      error: "运行执行尚未完全收束，不能删除",
    });
    expect(fs.existsSync(workspace)).toBe(true);

    activeRuns.delete("run-settling");
    expect(runCleanup({ target: "events", beforeDays: 1, dryRun: false }).affected.count).toBe(1);
    expect(deleteRun("run-settling")).toEqual({ ok: true });
    expect(fs.existsSync(workspace)).toBe(false);
  });

  it("单个运行的工作区删除失败时保留数据库记录以便按 runId 重试", () => {
    const workspace = makeWorkspace("workflow-failed-delete", "run-failed-delete");
    sqlite
      .prepare(
        "insert into runs (id, workflow_id, status, run_dir, started_at) values (?, ?, ?, ?, ?)",
      )
      .run("run-failed-delete", "workflow-failed-delete", "success", storedRunDir(workspace), old);
    const remove = vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
      throw new Error("EACCES");
    });

    try {
      expect(() => deleteRun("run-failed-delete")).toThrow("EACCES");
    } finally {
      remove.mockRestore();
    }

    expect(sqlite.prepare("select id from runs where id = ?").get("run-failed-delete")).toEqual({
      id: "run-failed-delete",
    });
    expect(fs.existsSync(workspace)).toBe(true);
    expect(deleteRun("run-failed-delete")).toEqual({ ok: true });
  });

  it("运行影响面一次汇总并由单条条件删除排除活动执行器", () => {
    for (const id of ["run-a", "run-b", "run-active"]) {
      sqlite
        .prepare(
          "insert into runs (id, workflow_id, status, run_dir, started_at) values (?, 'workflow-batch', 'success', NULL, ?)",
        )
        .run(id, old);
    }
    activeRuns.add("run-active");
    sqlite.exec(`
      INSERT INTO run_nodes (run_id) VALUES ('run-a'), ('run-a'), ('run-b'),
        ('run-active'), ('run-active'), ('run-active'), ('run-active'), ('run-active');
      INSERT INTO run_events (run_id, ts, payload) VALUES
        ('run-a', ${old}, '{}'), ('run-b', ${old}, '{}'), ('run-active', ${old}, '{}');
      INSERT INTO node_usage (run_id) VALUES
        ('run-a'), ('run-b'), ('run-b'), ('run-b'),
        ('run-active'), ('run-active'), ('run-active'), ('run-active');
      INSERT INTO run_results (run_id, kind, content, sha256, created_at) VALUES
        ('run-a', 'resume-match', '{}', '${"a".repeat(64)}', ${old}),
        ('run-b', 'resume-match', '{}', '${"b".repeat(64)}', ${old}),
        ('run-active', 'resume-match', '{}', '${"c".repeat(64)}', ${old});
    `);

    const preview = runCleanup({ target: "runs", beforeDays: 1, dryRun: true });
    expect(preview.affected.count).toBe(2);
    expect(preview.detail).toContain("级联 3 个节点、2 条事件、4 条用量明细、2 份持久结果");

    const deleted = runCleanup({ target: "runs", beforeDays: 1, dryRun: false });
    expect(deleted.affected).toEqual(preview.affected);
    expect(sqlite.prepare("select id from runs order by id").all()).toEqual([{ id: "run-active" }]);
    expect(sqlite.prepare("select run_id as runId from run_results").all()).toEqual([
      { runId: "run-active" },
    ]);
  });
});
