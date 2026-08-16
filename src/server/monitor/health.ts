/**
 * 系统健康：opencode 可达性、进程内事件泵、数据库与磁盘占用、孤儿运行。
 *
 * 全部「不抛错」——健康检查自己挂了就没有健康检查了：opencode 探测超时 2 秒、
 * 磁盘统计遇到权限错误跳过该项，任何一段失败都退化成 reachable:false / 0，
 * 不让整个页面 500。
 */
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { DATA_DIR } from "@/server/fs-safety";
import { getOpencodeUrl, type SessionRoute } from "@/server/opencode/server";
import { dirStat } from "./disk";
import type {
  EventPumpRoute,
  HealthCounts,
  HealthDb,
  HealthDisk,
  HealthEventPump,
  HealthOpencode,
  HealthPayload,
  HealthTable,
  OrphanRun,
} from "./types";

const PROBE_TIMEOUT_MS = 2000;

/** 事件泵与会话路由挂在 globalThis（见 src/server/opencode/server.ts） */
interface OpencodeGlobals {
  ontoflowSessionRoutes?: Map<string, SessionRoute>;
  ontoflowSessionPumps?: Map<string, AbortController>;
}

export async function getHealth(): Promise<HealthPayload> {
  // 注意：getOpencodeUrl() 会在 server 未启动时把它拉起来——这是探测唯一能拿到 baseUrl 的途径
  const opencode = await probeOpencode();
  const eventPump = readEventPump();
  return {
    opencode,
    eventPump,
    db: readDb(),
    disk: readDisk(),
    orphanRuns: listOrphanRuns(eventPump.routes),
    counts: readCounts(),
  };
}

/** 探测 opencode server：GET <url>/doc 拿 OpenAPI 里的版本号，失败退根路径，超时 2 秒 */
async function probeOpencode(): Promise<HealthOpencode> {
  let url = "";
  try {
    url = await getOpencodeUrl();
  } catch (err) {
    return { url: "", reachable: false, error: message(err) };
  }

  try {
    const res = await fetch(new URL("/doc", url), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) {
      const version = await readVersion(res);
      return version
        ? { url, reachable: true, version }
        : { url, reachable: true };
    }
  } catch {
    // 落到根路径再试一次
  }

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { url, reachable: res.ok || res.status < 500 };
  } catch (err) {
    return { url, reachable: false, error: message(err) };
  }
}

async function readVersion(res: Response): Promise<string | undefined> {
  try {
    const doc: unknown = await res.json();
    if (doc && typeof doc === "object") {
      const info = (doc as Record<string, unknown>).info;
      if (info && typeof info === "object") {
        const version = (info as Record<string, unknown>).version;
        if (typeof version === "string") return version;
      }
    }
  } catch {
    // 不是 JSON 就算了，可达性已经确认
  }
  return undefined;
}

function readEventPump(): HealthEventPump {
  const g = globalThis as OpencodeGlobals;
  const routes: EventPumpRoute[] = [];
  for (const [sessionId, route] of g.ontoflowSessionRoutes ?? []) {
    routes.push({ sessionId, runId: route.runId, nodeId: route.nodeId });
  }
  return {
    activeSessions: g.ontoflowSessionPumps?.size ?? 0,
    routes,
  };
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
function listOrphanRuns(routes: EventPumpRoute[]): OrphanRun[] {
  const live = new Set(routes.map((r) => r.runId));
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
