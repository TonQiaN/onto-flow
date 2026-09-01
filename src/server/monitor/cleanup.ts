/**
 * 手动清理执行器（三种目标 × dryRun 预览）。
 *
 * 危险操作纪律：
 * - `dryRun: true` 必须能算出与真删完全一致的影响面（前端先预览、再二次确认）；
 * - 一切删除路径先经 `resolveWithinData` 收敛在 data/ 内，目录名来自 readdir/DB 也照查不误；
 * - 执行器仍持有的运行永远不动——cancelled 已落库时，子进程和工作区仍可能在收尾；
 * - beforeDays 必须是正整数，没有「删全部」的入口。
 */
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import {
  activeRunExecutionIds,
  isRunExecutionActive,
} from "@/server/engine/runner";
import { DATA_DIR, resolveWithinData } from "@/server/fs-safety";
import { dirStat, formatBytes } from "./disk";
import type { CleanupRequest, CleanupResult, CleanupTarget } from "./types";
import { CLEANUP_TARGETS } from "./types";

const DAY_MS = 86_400_000;

export class CleanupError extends Error {}

export function isCleanupTarget(value: unknown): value is CleanupTarget {
  return (
    typeof value === "string" &&
    (CLEANUP_TARGETS as readonly string[]).includes(value)
  );
}

export function runCleanup(request: CleanupRequest): CleanupResult {
  const { target } = request;
  if (!isCleanupTarget(target)) {
    throw new CleanupError("target 必须是 workspaces / events / runs 之一");
  }
  const beforeDays = request.beforeDays;
  if (
    typeof beforeDays !== "number" ||
    !Number.isInteger(beforeDays) ||
    beforeDays < 1
  ) {
    throw new CleanupError("beforeDays 必须是正整数（保留最近 N 天）");
  }
  const dryRun = request.dryRun === true;
  const cutoff = Date.now() - beforeDays * DAY_MS;

  switch (target) {
    case "workspaces":
      return cleanWorkspaces(cutoff, beforeDays, dryRun);
    case "events":
      return cleanEvents(cutoff, beforeDays, dryRun);
    case "runs":
      return cleanRuns(cutoff, beforeDays, dryRun);
  }
}

// ---------------- workspaces ----------------

/**
 * 删 data/runs/<workflowId>/<runId> 下 N 天前运行的工作区目录，**保留数据库记录**。
 * DB 里查不到的叶子目录按目录 mtime 判断（多半是被删过运行的残留）。
 */
function cleanWorkspaces(
  cutoff: number,
  beforeDays: number,
  dryRun: boolean,
): CleanupResult {
  const root = path.join(DATA_DIR, "runs");
  const entries = readWorkspaceDirs(root);
  const runRows = db.all<{
    id: string;
    runDir: string | null;
    startedAt: number;
    status: string;
  }>(
    sql`select id, run_dir as runDir, started_at as startedAt, status from runs`,
  );
  const knownRunIds = new Set(runRows.map((r) => r.id));
  const knownTargets = new Map<string, WorkspaceTarget>();
  const targets = new Map<string, WorkspaceTarget>();
  let skippedRunning = 0;

  // 有 DB 记录的运行只信 run_dir；空值或目录不存在时不按 workflowId/id 猜路径。
  for (const run of runRows) {
    const target = targetFromStoredRunDir(run.runDir);
    if (!target) continue;
    knownTargets.set(target.absolutePath, target);
    if (!isDirectory(target.absolutePath)) continue;
    if (run.status === "running" || isRunExecutionActive(run.id)) {
      skippedRunning += 1;
      continue;
    }
    if (run.startedAt < cutoff) targets.set(target.absolutePath, target);
  }

  // DB 完全不知道的叶子目录才是孤儿。若 runId 仍有记录但 run_dir 为空或指向别处，
  // 不能把约定布局当 fallback，否则又绕开了 run_dir 的唯一事实源。
  for (const entry of entries) {
    if (knownRunIds.has(entry.runId) || knownTargets.has(entry.absolutePath)) continue;
    const at = dirMtime(entry.absolutePath);
    if (at == null || at >= cutoff) continue;
    const target = targetFromAbsoluteRunDir(entry.absolutePath);
    targets.set(target.absolutePath, target);
  }

  const count = targets.size;
  const bytes = [...targets.values()].reduce(
    (sum, target) => sum + dirStat(target.absolutePath).bytes,
    0,
  );

  if (!dryRun) {
    for (const target of targets.values()) removeDir(target);
  }

  const detail =
    `data/runs 下 ${beforeDays} 天前的工作区目录 ${count} 个` +
    `（约 ${formatBytes(bytes)}）；数据库记录保留，运行详情页仍可查` +
    (skippedRunning > 0 ? `；跳过进行中的运行 ${skippedRunning} 个` : "");

  return { target: "workspaces", affected: { count, bytes }, deleted: !dryRun, detail };
}

// ---------------- events ----------------

/**
 * 删 N 天前的 run_events 行（进行中的运行不动）。bytes 是 payload 文本长度的估算，
 * 真删之后跑一次 VACUUM 把空间还给文件系统。
 */
function cleanEvents(
  cutoff: number,
  beforeDays: number,
  dryRun: boolean,
): CleanupResult {
  const activeIds = activeRunExecutionIds();
  const activeFilter =
    activeIds.length === 0
      ? sql``
      : sql`and e.run_id not in (${sql.join(
          activeIds.map((id) => sql`${id}`),
          sql`, `,
        )})`;
  const stat = db.get<{ count: number; bytes: number }>(sql`
      select count(*) as count,
        coalesce(sum(length(cast(coalesce(e.payload, '') as blob))), 0) as bytes
      from run_events e
      join runs r on r.id = e.run_id
      where e.ts < ${cutoff} and r.status <> 'running'
        ${activeFilter}
    `);
  const count = stat?.count ?? 0;
  const bytes = stat?.bytes ?? 0;

  let vacuumNote = "";
  if (!dryRun && count > 0) {
    db.run(sql`
      delete from run_events where id in (
        select e.id
        from run_events e
        join runs r on r.id = e.run_id
        where e.ts < ${cutoff} and r.status <> 'running'
          ${activeFilter}
      )
    `);
    try {
      db.run(sql`vacuum`);
      vacuumNote = "；已 VACUUM 回收文件空间";
    } catch (err) {
      vacuumNote = `；VACUUM 失败（${err instanceof Error ? err.message : String(err)}）`;
    }
  }

  const detail =
    `${beforeDays} 天前的事件明细 ${count} 条（payload 约 ${formatBytes(bytes)}）；` +
    `运行与节点记录保留，只是不再能回看逐条日志${vacuumNote}`;

  return { target: "events", affected: { count, bytes }, deleted: !dryRun, detail };
}

// ---------------- runs ----------------

/**
 * 删 N 天前的运行整条记录：run_nodes / run_events / node_usage 由外键级联清除
 * （db/index.ts 开了 foreign_keys=ON），另外一并删掉它们的工作区目录。
 */
function cleanRuns(
  cutoff: number,
  beforeDays: number,
  dryRun: boolean,
): CleanupResult {
  const rows = db.all<{ id: string; runDir: string | null }>(sql`
    select id, run_dir as runDir
    from runs where started_at < ${cutoff} and status <> 'running'
  `).filter((row) => !isRunExecutionActive(row.id));
  const count = rows.length;
  const targets = new Map<string, WorkspaceTarget>();
  for (const row of rows) {
    const target = targetFromStoredRunDir(row.runDir);
    if (target) targets.set(target.absolutePath, target);
  }

  const detailStat = rows.reduce(
    (sum, row) => {
      const stat = db.get<{ nodes: number; events: number; usage: number }>(sql`
        select
          (select count(*) from run_nodes where run_id = ${row.id}) as nodes,
          (select count(*) from run_events where run_id = ${row.id}) as events,
          (select count(*) from node_usage where run_id = ${row.id}) as usage
      `);
      return {
        nodes: sum.nodes + (stat?.nodes ?? 0),
        events: sum.events + (stat?.events ?? 0),
        usage: sum.usage + (stat?.usage ?? 0),
      };
    },
    { nodes: 0, events: 0, usage: 0 },
  );

  const bytes = [...targets.values()].reduce(
    (sum, target) => sum + dirStat(target.absolutePath).bytes,
    0,
  );

  if (!dryRun && count > 0) {
    db.transaction((tx) => {
      for (const row of rows) {
        tx.run(sql`delete from runs where id = ${row.id} and status <> 'running'`);
      }
    });
    for (const target of targets.values()) removeDir(target);
  }

  const detail =
    `${beforeDays} 天前的运行 ${count} 次（级联 ${detailStat?.nodes ?? 0} 个节点、` +
    `${detailStat?.events ?? 0} 条事件、${detailStat?.usage ?? 0} 条用量明细，` +
    `含工作区约 ${formatBytes(bytes)}）；不可恢复，运行历史与成本统计都会少掉这些数据`;

  return { target: "runs", affected: { count, bytes }, deleted: !dryRun, detail };
}

// ---------------- 单个运行 ----------------

/**
 * 删除单个已结束的运行：runs 行（run_nodes / run_events / node_usage 外键级联）
 * 加工作区目录。对外暴露运行 API 后，调用方要能清理自己发起的运行，e2e 也靠它
 * 收走测试运行。与 cleanRuns 同属本模块这条破坏性路径，纪律一致：
 * 执行器仍持有的运行永不动、目录先收敛进 data/runs 再删。
 */
export function deleteRun(
  runId: string,
): { ok: true } | { ok: false; status: 404 | 409; error: string } {
  const row = db.get<{ status: string; runDir: string | null }>(
    sql`select status, run_dir as runDir from runs where id = ${runId}`,
  );
  if (!row) return { ok: false, status: 404, error: "运行不存在" };
  if (row.status === "running" || isRunExecutionActive(runId)) {
    return { ok: false, status: 409, error: "运行执行尚未完全收束，不能删除" };
  }
  // 越界的 run_dir 由 targetFromStoredRunDir 抛 CleanupError，路由层映射为 400。
  const target = targetFromStoredRunDir(row.runDir);
  db.run(sql`delete from runs where id = ${runId} and status <> 'running'`);
  if (target) removeDir(target);
  return { ok: true };
}

// ---------------- helpers ----------------

function readDirs(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

interface ScannedWorkspaceDir {
  workflowId: string;
  runId: string;
  absolutePath: string;
}

/** 当前工作区布局有两层所有权：workflowId 再 runId；清理单位是叶子运行目录。 */
function readWorkspaceDirs(root: string): ScannedWorkspaceDir[] {
  return readDirs(root).flatMap((workflowId) => {
    const workflowRoot = path.join(root, workflowId);
    return readDirs(workflowRoot).map((runId) => ({
      workflowId,
      runId,
      absolutePath: path.join(workflowRoot, runId),
    }));
  });
}

interface WorkspaceTarget {
  /** 相对 data/ 的删除路径；与 absolutePath 在目标解析时一次性生成。 */
  relativePath: string;
  absolutePath: string;
}

/** runs.run_dir 是相对仓库根的事实路径；null 表示该记录没有可清理目录。 */
function targetFromStoredRunDir(runDir: string | null): WorkspaceTarget | null {
  if (!runDir) return null;
  // runDir 是运行时数据库事实，不是构建输入；下游仍会收敛到 data/runs，禁止 Turbopack
  // 因这个动态值把整个仓库误追踪进服务端产物。
  return targetFromAbsoluteRunDir(
    path.resolve(/* turbopackIgnore: true */ process.cwd(), runDir),
  );
}

/** 把 DB 或目录扫描得来的路径收敛在 data/runs 内，并冻结为同一个清理目标。 */
function targetFromAbsoluteRunDir(absolutePath: string): WorkspaceTarget {
  const relativePath = path.relative(DATA_DIR, absolutePath);
  let resolved: string;
  try {
    resolved = resolveWithinData(relativePath);
  } catch {
    throw new CleanupError("运行目录越界 data/，已拒绝清理");
  }
  const runsRoot = path.join(DATA_DIR, "runs");
  const withinRuns = path.relative(runsRoot, resolved);
  if (
    withinRuns === "" ||
    withinRuns.startsWith("..") ||
    path.isAbsolute(withinRuns)
  ) {
    throw new CleanupError("运行目录不在 data/runs 内，已拒绝清理");
  }
  return { relativePath: path.relative(DATA_DIR, resolved), absolutePath: resolved };
}

function dirMtime(dir: string): number | null {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return null;
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** target 在预览前已收敛；真删前再验证同一相对路径仍解析回同一绝对目标。 */
function removeDir(target: WorkspaceTarget): void {
  try {
    const abs = resolveWithinData(target.relativePath);
    if (abs !== target.absolutePath) throw new Error("运行目录在预览后发生变化");
    fs.rmSync(abs, { recursive: true, force: true });
  } catch (err) {
    console.error("[monitor] 删除目录失败", target.relativePath, err);
  }
}
