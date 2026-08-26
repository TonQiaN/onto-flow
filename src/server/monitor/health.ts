/**
 * 系统健康：引擎就绪状态、在跑的运行子进程、数据库与磁盘占用、孤儿运行。
 *
 * 全部「不抛错」——健康检查自己挂了就没有健康检查了：任何一段失败都退化成
 * ready:false / 0，不让整个页面 500。
 *
 * 换成 dsh 引擎后没有常驻外部服务可探（ADR-0006）：就绪与否只取决于 runner
 * 入口在不在、凭据引用名有没有值；「活着的东西」是每次运行自己的子进程。
 */
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { DATA_DIR } from "@/server/fs-safety";
import { DEFAULT_CREDENTIAL_ENV } from "@/server/harness/entries";
import { defaultRunnerEntry } from "@/server/harness/launch";
import type { RunProcess } from "@/server/harness/runtime";
import { dirStat } from "./disk";
import type {
  HealthCounts,
  HealthDb,
  HealthDisk,
  HealthEngine,
  HealthPayload,
  HealthRunProcesses,
  HealthTable,
  LiveRunProcess,
  OrphanRun,
} from "./types";

/** 在跑运行的子进程表挂在 globalThis（见 src/server/engine/runner.ts） */
interface RunnerGlobals {
  ontoflowRunProcesses?: Map<string, RunProcess>;
}

export async function getHealth(): Promise<HealthPayload> {
  const runProcesses = readRunProcesses();
  return {
    engine: readEngine(),
    runProcesses,
    db: readDb(),
    disk: readDisk(),
    orphanRuns: listOrphanRuns(runProcesses.runs),
    counts: readCounts(),
  };
}

/** 引擎就绪：runner 入口在不在、凭据引用名有没有值。都不联网。 */
function readEngine(): HealthEngine {
  const credentialRef = DEFAULT_CREDENTIAL_ENV;
  const credentialConfigured = (process.env[credentialRef] ?? "") !== "";
  try {
    const runnerEntry = defaultRunnerEntry();
    return {
      runnerEntry,
      ready: fs.existsSync(runnerEntry),
      credentialRef,
      credentialConfigured,
    };
  } catch (err) {
    return {
      runnerEntry: "",
      ready: false,
      credentialRef,
      credentialConfigured,
      error: message(err),
    };
  }
}

/** 进程内在跑的运行子进程快照。 */
function readRunProcesses(): HealthRunProcesses {
  const g = globalThis as RunnerGlobals;
  const runs: LiveRunProcess[] = [];
  for (const [runId, proc] of g.ontoflowRunProcesses ?? []) {
    runs.push({ runId, pid: proc.pid ?? null });
  }
  return { activeRuns: runs.length, runs };
}

function readDb(): HealthDb {
  const dbPath = path.join(DATA_DIR, "ontoflow.db");
  let bytes = 0;
  try {
    bytes = fs.statSync(dbPath).size;
  } catch {
    bytes = 0;
  }

  const tables: HealthTable[] = [];
  try {
    const names = db.all<{ name: string }>(sql`
      select name from sqlite_master
      where type = 'table' and name not like 'sqlite_%'
      order by name asc
    `);
    for (const { name } of names) {
      // name 来自 sqlite_master，双引号包裹后拼接安全（不接受外部输入）
      const row = db.get<{ c: number }>(
        sql.raw(`select count(*) as c from "${name.replace(/"/g, '""')}"`),
      );
      tables.push({ name, rows: row?.c ?? 0 });
    }
  } catch (err) {
    console.error("[monitor] 读取表统计失败", err);
  }

  return { path: dbPath, bytes, tables };
}

function readDisk(): HealthDisk {
  const runsDir = dirStat(path.join(DATA_DIR, "runs"));
  const uploads = dirStat(path.join(DATA_DIR, "uploads"));
  const documents = dirStat(path.join(DATA_DIR, "documents"));
  return {
    runsDir: { bytes: runsDir.bytes, dirs: runsDir.topDirs, files: runsDir.files },
    uploads: { bytes: uploads.bytes, files: uploads.files },
    documents: { bytes: documents.bytes, files: documents.files },
  };
}

/**
 * 孤儿运行：状态仍是 running、但进程内已无事件泵路由——多为进程重启遗留。
 * 返回明细而非计数：控制台要能直接看出「是哪几次运行卡住了、卡在几个节点上」。
 * 注意串行引擎在两个节点之间有短暂无路由窗口，瞬时出现 1 条属正常，持续存在才是真孤儿。
 */
function listOrphanRuns(live_runs: LiveRunProcess[]): OrphanRun[] {
  const live = new Set(live_runs.map((r) => r.runId));
  const rows = db.all<{
    id: string;
    workflowName: string;
    startedAt: number | null;
    pendingNodes: number;
  }>(sql`
    select r.id as id,
           r.workflow_name as workflowName,
           r.started_at as startedAt,
           (select count(*) from run_nodes n
             where n.run_id = r.id and n.status in ('running', 'pending')) as pendingNodes
      from runs r
     where r.status = 'running'
     order by r.started_at desc
  `);
  return rows
    .filter((r) => !live.has(r.id))
    .map((r) => ({
      id: r.id,
      workflowName: r.workflowName,
      status: "running",
      startedAt: r.startedAt,
      pendingNodes: r.pendingNodes,
      reason: "进程内已无事件泵路由，疑似进程重启遗留",
    }));
}

function readCounts(): HealthCounts {
  const row = db.get<HealthCounts>(sql`
    select
      (select count(*) from runs) as runs,
      (select count(*) from run_nodes) as runNodes,
      (select count(*) from run_events) as runEvents,
      (select count(*) from node_usage) as nodeUsage
  `);
  return {
    runs: row?.runs ?? 0,
    runNodes: row?.runNodes ?? 0,
    runEvents: row?.runEvents ?? 0,
    nodeUsage: row?.nodeUsage ?? 0,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
