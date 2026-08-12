/**
 * 系统健康页的数据契约与解析工具（模块 D 自用）。
 *
 * 服务端接口由监控 API 模块提供，本文件是**客户端侧的契约声明**：
 * - `GET /api/monitor/health` → HealthPayload
 * - `POST /api/monitor/cleanup` `{ target, days, dryRun }` → CleanupResult
 * - `GET /api/references/orphans` → `{ items: Array<{kind,id,name,href}> }`（已存在，见 DESIGN-V2 第三节）
 *
 * 解析一律走宽松映射（同 runs/lib.ts 的 asRunSnapshot 风格）：缺字段就给零值，
 * 常见同义键（bytes/sizeBytes、count/items、rows/count）都接受，
 * 这样接口细节微调不会把整页打成白屏。
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

/** 磁盘目录统计：count 为目录数（runs）或文件数（uploads/documents） */
export interface DiskEntry {
  path: string;
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
  startedAt: string | number | null;
  /** 仍停在 running/pending 的节点数（可缺） */
  pendingNodes: number | null;
  reason: string | null;
}

export interface HealthPayload {
  opencode: OpencodeHealth;
  eventPump: EventPumpHealth;
  database: DatabaseHealth;
  disk: DiskHealth;
  orphanRuns: OrphanRun[];
  /** 服务端采样时刻（可缺，缺则前端用收到响应的时刻） */
  generatedAt: number | null;
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
  /** 将删除 / 已删除的条目数（工作区=目录数，事件=事件行数，运行=运行条数） */
  items: number;
  /** 将释放 / 已释放的字节数；数据库行删除可能为 0 */
  bytes: number;
  /** 服务端补充说明（如「同时级联删除 12 个节点、340 条事件」） */
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

/** 取第一个存在的同义键 */
function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

/** 对齐 @/server/monitor/types 的 DiskDirStat：{ path, bytes, dirs?, files? } */
function asDiskEntry(value: unknown): DiskEntry {
  const o = rec(value);
  return {
    path: str(pick(o, "path", "dir")),
    sizeBytes: num(pick(o, "bytes")),
    // runs 目录统计的是子目录数（一次运行一个工作区），uploads/documents 统计文件数
    count: num(pick(o, "dirs", "files")),
  };
}

/** tables 既接受 `[{name,rows}]`，也接受 `{ 表名: 行数 }` */
function asTables(value: unknown): TableStat[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const o = rec(item);
      const name = str(pick(o, "name", "table"));
      if (!name) return [];
      return [{ name, rows: num(pick(o, "rows", "count")) }];
    });
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>).map(
      ([name, rows]) => ({ name, rows: num(rows) }),
    );
  }
  return [];
}

function asOrphanRuns(value: unknown): OrphanRun[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const o = rec(item);
    const id = str(pick(o, "id", "runId"));
    if (!id) return [];
    const started = pick(o, "startedAt", "startTime");
    const pending = pick(o, "pendingNodes", "nodeCount", "nodes");
    return [
      {
        id,
        workflowName: str(pick(o, "workflowName", "workflow")),
        status: str(o.status) || "running",
        startedAt:
          typeof started === "number" || typeof started === "string"
            ? started
            : null,
        pendingNodes: typeof pending === "number" ? pending : null,
        reason: strOrNull(pick(o, "reason", "detail")),
      },
    ];
  });
}

export function asHealth(value: unknown): HealthPayload {
  const o = rec(value);
  const oc = rec(pick(o, "opencode", "server"));
  const pump = rec(pick(o, "eventPump", "pump", "events"));
  const database = rec(pick(o, "database", "db"));
  const disk = rec(pick(o, "disk", "storage"));
  const generatedAt = pick(o, "generatedAt", "ts");
  return {
    opencode: {
      reachable: pick(oc, "reachable", "ok", "up") === true,
      url: str(pick(oc, "url", "baseUrl")),
      version: strOrNull(oc.version),
      error: strOrNull(oc.error),
    },
    eventPump: {
      activeSessions: num(pick(pump, "activeSessions", "sessions", "pumps")),
      routeEntries: num(pick(pump, "routeEntries", "routes", "sessionRoutes")),
    },
    database: {
      path: str(pick(database, "path", "file")),
      sizeBytes: num(pick(database, "sizeBytes", "bytes", "size")),
      tables: asTables(pick(database, "tables", "rows")),
    },
    disk: {
      runs: asDiskEntry(disk.runsDir),
      uploads: asDiskEntry(disk.uploads),
      documents: asDiskEntry(disk.documents),
    },
    orphanRuns: asOrphanRuns(pick(o, "orphanRuns", "orphans")),
    generatedAt: typeof generatedAt === "number" ? generatedAt : null,
  };
}

export function asOrphanEntities(value: unknown): OrphanEntity[] {
  const items = Array.isArray(value) ? value : rec(value).items;
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

export function asCleanupResult(
  value: unknown,
  target: CleanupTarget,
  days: number,
  dryRun: boolean,
): CleanupResult {
  const o = rec(value);
  return {
    target,
    days,
    dryRun,
    items: num(pick(o, "items", "count", "deleted", "affected")),
    bytes: num(pick(o, "bytes", "freedBytes", "sizeBytes", "size")),
    note: strOrNull(pick(o, "note", "detail", "message")),
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
