/**
 * 系统健康页的数据契约与解析工具（模块 D 自用）。
 *
 * 服务端接口由监控 API 模块提供，本文件是**客户端侧的契约声明**，
 * 唯一权威是 `@/server/monitor/types`：
 * - `GET /api/monitor/health` → HealthPayload
 *   `{ opencode, eventPump:{activeSessions,routes[]}, db:{path,bytes,tables[]}, disk, orphanRuns[], counts }`
 * - `POST /api/monitor/cleanup` `{ target, beforeDays, dryRun }` → CleanupResult
 *   `{ target, affected:{count,bytes?}, deleted, detail }`
 * - `GET /api/references/orphans` → `{ items: Array<{kind,id,name,href}> }`（已存在，见 DESIGN-V2 第三节）
 *
 * 解析**只认服务端的真实键名**，不再猜同义键（bytes/sizeBytes、count/items/deleted…）。
 * 那套「宽松映射」看着是容错，实际是把错层写成了合法解析：猜错的键会静默命中一个
 * 类型不对的值（如布尔 deleted）并解析成 0，页面照常渲染却全是假数字——清理面板
 * 长期显示「影响 0 项」、事件泵路由表恒为 0 都是这么来的。缺字段/类型不对时仍退化成
 * 零值（只为防后端异常把整页打成白屏），但绝不接受第二种形状。
 */

/** 工作区总体积告警阈值：2GB */
export const WORKSPACE_WARN_BYTES = 2 * 1024 * 1024 * 1024;

/* -------------------------------------------------------------------------- */
/* 类型                                                                        */
/* -------------------------------------------------------------------------- */

export interface OpencodeHealth {
  /** server 是否可达（HTTP 探活成功） */
  reachable: boolean;
  /** 基址，通常是 http://127.0.0.1:4977 */
  url: string;
  version: string | null;
  /** 不可达时的原因 */
  error: string | null;
}

/** 事件泵状态：每个活跃会话一个泵，路由表是 sessionID→(runId,nodeId) */
export interface EventPumpHealth {
  activeSessions: number;
  /** 服务端 eventPump.routes 是明细数组，这里只留条目数（页面只用计数） */
  routeEntries: number;
}

export interface TableStat {
  name: string;
  rows: number;
}

export interface DatabaseHealth {
  path: string;
  sizeBytes: number;
  tables: TableStat[];
}

/**
 * 磁盘目录统计：count 为目录数（runs）或文件数（uploads/documents）。
 * 服务端 DiskDirStat 只有 { bytes, dirs?, files? }，不带路径，所以这里没有 path 字段
 * ——曾经声明过一个永远是空串的 path，纯属对着不存在的契约写字段。
 */
export interface DiskEntry {
  sizeBytes: number;
  count: number;
}

export interface DiskHealth {
  runs: DiskEntry;
  uploads: DiskEntry;
  documents: DiskEntry;
}

/** 孤儿运行：状态仍为 running，但进程内已无对应会话/事件泵（多为进程重启遗留） */
export interface OrphanRun {
  id: string;
  workflowName: string;
  status: string;
  /** 服务端一律给 epoch 毫秒（见 types.ts 抬头约定），异常数据兜底 null */
  startedAt: number | null;
  /** 仍停在 running/pending 的节点数（可缺） */
  pendingNodes: number | null;
  reason: string | null;
}

/** 四张核心表的行数（服务端 counts 字段） */
export interface HealthCounts {
  runs: number;
  runNodes: number;
  runEvents: number;
  nodeUsage: number;
}

export interface HealthPayload {
  opencode: OpencodeHealth;
  eventPump: EventPumpHealth;
  /** 服务端键名是 db */
  database: DatabaseHealth;
  disk: DiskHealth;
  orphanRuns: OrphanRun[];
  counts: HealthCounts;
}

/** 未被任何实体引用的库条目（/api/references/orphans） */
export interface OrphanEntity {
  kind: string;
  id: string;
  name: string;
  href: string;
}

export const CLEANUP_TARGETS = ["workspaces", "events", "runs"] as const;
export type CleanupTarget = (typeof CLEANUP_TARGETS)[number];

export interface CleanupResult {
  target: CleanupTarget;
  days: number;
  dryRun: boolean;
  /** 将删除 / 已删除的条目数（工作区=目录数，事件=事件行数，运行=运行条数），取自 affected.count */
  items: number;
  /** 将释放 / 已释放的字节数，取自 affected.bytes；事件清理是按 payload 长度的估算 */
  bytes: number;
  /** 服务端补充说明 detail（如「级联 12 个节点、340 条事件」） */
  note: string | null;
}

/* -------------------------------------------------------------------------- */
/* 宽松解析                                                                    */
/* -------------------------------------------------------------------------- */

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

/** 对齐 @/server/monitor/types 的 DiskDirStat：{ bytes, dirs?, files? } */
function asDiskEntry(value: unknown): DiskEntry {
  const o = rec(value);
  return {
    sizeBytes: num(o.bytes),
    // 同一个 DiskDirStat 的两种口径：runs 目录只有 dirs 有意义（一次运行一个工作区），
    // uploads/documents 只带 files。不是同义键猜测，是服务端明确的两种统计维度。
    count: num(o.dirs ?? o.files),
  };
}

/** db.tables 固定是 `[{name, rows}]` */
function asTables(value: unknown): TableStat[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const o = rec(item);
    const name = str(o.name);
    if (!name) return [];
    return [{ name, rows: num(o.rows) }];
  });
}

function asOrphanRuns(value: unknown): OrphanRun[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const o = rec(item);
    const id = str(o.id);
    if (!id) return [];
    return [
      {
        id,
        workflowName: str(o.workflowName),
        status: str(o.status) || "running",
        startedAt: typeof o.startedAt === "number" ? o.startedAt : null,
        pendingNodes:
          typeof o.pendingNodes === "number" ? o.pendingNodes : null,
        reason: strOrNull(o.reason),
      },
    ];
  });
}

export function asHealth(value: unknown): HealthPayload {
  const o = rec(value);
  const oc = rec(o.opencode);
  const pump = rec(o.eventPump);
  const database = rec(o.db);
  const disk = rec(o.disk);
  const counts = rec(o.counts);
  return {
    opencode: {
      reachable: oc.reachable === true,
      url: str(oc.url),
      version: strOrNull(oc.version),
      error: strOrNull(oc.error),
    },
    eventPump: {
      activeSessions: num(pump.activeSessions),
      // routes 是 {sessionId,runId,nodeId} 的**数组**，不是计数：
      // 以前直接 num(routes) 恒为 0，页面因此永远显示「路由表 0 条」并误报计数不一致
      routeEntries: Array.isArray(pump.routes) ? pump.routes.length : 0,
    },
    database: {
      path: str(database.path),
      sizeBytes: num(database.bytes),
      tables: asTables(database.tables),
    },
    disk: {
      runs: asDiskEntry(disk.runsDir),
      uploads: asDiskEntry(disk.uploads),
      documents: asDiskEntry(disk.documents),
    },
    orphanRuns: asOrphanRuns(o.orphanRuns),
    counts: {
      runs: num(counts.runs),
      runNodes: num(counts.runNodes),
      runEvents: num(counts.runEvents),
      nodeUsage: num(counts.nodeUsage),
    },
  };
}

export function asOrphanEntities(value: unknown): OrphanEntity[] {
  const items = rec(value).items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    const o = rec(item);
    const id = str(o.id);
    if (!id) return [];
    return [
      {
        kind: str(o.kind),
        id,
        name: str(o.name) || id,
        href: str(o.href),
      },
    ];
  });
}

/**
 * 解析 CleanupResult。服务端真实形状是
 * `{ target, affected: { count, bytes? }, deleted, detail }`——影响面在 affected 里，
 * **顶层没有 items/bytes**。以前在顶层猜 items/count/deleted/affected：布尔的 deleted
 * 先命中、num() 恒判 0，bytes 四个同义键一个都不存在，于是预览与执行后永远显示
 * 「影响 0 项」，二次确认框还会写「当前预览为 0 项，执行不会有任何变化」，
 * 而用户点下去真删了 N 条。改动请只跟着 @/server/monitor/types 的 CleanupResult 走。
 */
export function asCleanupResult(
  value: unknown,
  target: CleanupTarget,
  days: number,
  dryRun: boolean,
): CleanupResult {
  const o = rec(value);
  const affected = rec(o.affected);
  return {
    target,
    days,
    dryRun,
    items: num(affected.count),
    bytes: num(affected.bytes),
    note: strOrNull(o.detail),
  };
}

/* -------------------------------------------------------------------------- */
/* 展示工具                                                                    */
/* -------------------------------------------------------------------------- */

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString("zh-CN");
}

/** 五个库的中文名（孤儿实体按 kind 分组时用） */
export const KIND_LABELS: Record<string, string> = {
  workflow: "工作流",
  action: "Action",
  skill: "Skill",
  tool: "Tool",
  object_type: "对象类型",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}
