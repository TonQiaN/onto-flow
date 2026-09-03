/**
 * 系统健康与手动清理的载荷类型（服务端与前端共用）。
 *
 * 监控台收口成系统健康一页后，`/api/monitor/*` 只剩 health 与 cleanup 两条，
 * 总览 / 实时会话 / 日志检索的载荷类型随那三页一并删除。
 *
 * 约定：**所有时间字段一律是 epoch 毫秒数（number）**，不是 Date 也不是 ISO 串——
 * 服务层在返回前统一归一，前端可直接丢给 `@/app/runs/lib` 的 `formatDateTime`，
 * 无需再过 `toMillis`。
 */

// ---------------- 系统健康 ----------------

export interface HealthEngine {
  /** 运行子进程的 runner 入口绝对路径 */
  runnerEntry: string;
  /** 入口文件在不在——不在则一次运行都起不来 */
  ready: boolean;
  /** 模型凭据引用名 */
  credentialRef: string;
  /** 该引用名在本进程环境里有没有值（只看有无，不读值） */
  credentialConfigured: boolean;
  error?: string;
}

export interface LiveRunProcess {
  runId: string;
  pid: number | null;
}

export interface HealthRunProcesses {
  /** 进程内在跑的运行子进程数（一次运行一个，见 ADR-0007） */
  activeRuns: number;
  runs: LiveRunProcess[];
}

export interface HealthTable {
  name: string;
  rows: number;
}

export interface HealthDb {
  path: string;
  bytes: number;
  tables: HealthTable[];
}

export interface DiskDirStat {
  bytes: number;
  /** 目录数（仅 data/runs 用：一个子目录 = 一次运行的工作区） */
  dirs?: number;
  /** 文件数 */
  files?: number;
}

export interface HealthDisk {
  runsDir: DiskDirStat & { dirs: number };
  uploads: DiskDirStat & { files: number };
}

/** 孤儿运行明细：状态仍是 running 但进程内已无事件泵路由 */
export interface OrphanRun {
  id: string;
  workflowName: string;
  status: string;
  startedAt: number | null;
  pendingNodes: number;
  reason: string;
}

export interface HealthCounts {
  runs: number;
  runNodes: number;
  runEvents: number;
  nodeUsage: number;
}

export interface HealthPayload {
  engine: HealthEngine;
  runProcesses: HealthRunProcesses;
  db: HealthDb;
  disk: HealthDisk;
  /** status='running' 但进程内已无对应子进程的运行（多半是上次进程留下的） */
  orphanRuns: OrphanRun[];
  counts: HealthCounts;
}

// ---------------- 清理 ----------------

export const CLEANUP_TARGETS = ["workspaces", "events", "runs"] as const;
export type CleanupTarget = (typeof CLEANUP_TARGETS)[number];

export interface CleanupRequest {
  target: CleanupTarget;
  /** 保留最近 N 天，删除更早的；必须是正整数 */
  beforeDays: number;
  /** true 只预览影响面不删（前端二次确认前必须先跑一遍） */
  dryRun?: boolean;
}

export interface CleanupResult {
  target: CleanupTarget;
  affected: {
    count: number;
    /** 可回收（或已回收）的字节数；事件清理是按 payload 长度的估算 */
    bytes?: number;
  };
  /** false 表示这次只是预览 */
  deleted: boolean;
  detail: string;
}
