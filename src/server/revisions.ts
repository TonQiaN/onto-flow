/**
 * 修订服务：实体每次保存留一版完整定义，可查看 / 对比 / 回滚（CONTEXT.md「修订」）。
 *
 * 对外接口（其它模块可直接 import，签名保持稳定）：
 *   recordRevision(kind, entityId, payload, note?, tx?)  ← 五个库 POST/PUT 成功后调用
 *   registerEntityWriter(kind, writer)                   ← 各库注册自己的写入路径
 *   listRevisions / getRevision / patchRevision / restoreRevision
 *
 * 回滚必须复用实体自身的写入逻辑（与 PUT 同一条路径与校验），故这里只维护一张
 * 写入器注册表，具体写法由各库自己提供（src/server/writers/）。**注册发生在模块
 * 加载时**：路由必须 `import "@/server/writers"`，否则 restore 只能返回 501。
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db, revisions, type EntityKind } from "@/db";
import { type WriteResult, writeFail, writeOk } from "@/server/writers/types";

export type Revision = typeof revisions.$inferSelect;
/** 列表用：不带 payload（可能很大） */
export type RevisionSummary = Omit<Revision, "payload">;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** 全局 db 或某个事务；两者是同一条 sqlite 连接 */
export type DbHandle = typeof db | Tx;

/** 写入器返回 void 视同成功（写入器自行抛错也可，异常由调用方的 handle() 兜底） */
export type EntityWriter = (id: string, payload: unknown) => WriteResult<unknown> | void;

const writers = new Map<EntityKind, EntityWriter>();

/** 各库在自己的服务模块顶层调用，声明「这个 kind 怎么写回」 */
export function registerEntityWriter(kind: EntityKind, writer: EntityWriter): void {
  writers.set(kind, writer);
}

function maxVersionNo(kind: EntityKind, entityId: string, conn = db): number {
  const row = conn
    .select({
      v: sql<number>`coalesce(max(${revisions.versionNo}), 0)`,
    })
    .from(revisions)
    .where(and(eq(revisions.entityKind, kind), eq(revisions.entityId, entityId)))
    .get();
  return row?.v ?? 0;
}

/**
 * 追加一版修订，versionNo = 该实体当前最大值 + 1（从 1 开始）。
 *
 * @param payload 实体的完整定义（Action 含 ports/preloadSkillIds/toolIds；Skill 含 files；
 *                Workflow 含 instructions/settings/skillIds/toolIds/nodes/edges）
 * @param tx 在调用方事务内记账时可传入；省略即用全局 db——better-sqlite3 单连接，
 *           省略时若外层已 BEGIN，插入同样落在该事务里。
 */
export function recordRevision(
  entityKind: EntityKind,
  entityId: string,
  payload: Record<string, unknown>,
  note = "",
  tx?: DbHandle,
): Revision {
  const conn = (tx ?? db) as typeof db;
  const versionNo = maxVersionNo(entityKind, entityId, conn) + 1;
  return conn
    .insert(revisions)
    .values({ entityKind, entityId, versionNo, payload, note })
    .returning()
    .get();
}

/** 该实体的修订列表，版本号倒序，不含 payload */
export function listRevisions(kind: EntityKind, entityId: string): RevisionSummary[] {
  return db
    .select({
      id: revisions.id,
      entityKind: revisions.entityKind,
      entityId: revisions.entityId,
      versionNo: revisions.versionNo,
      note: revisions.note,
      createdAt: revisions.createdAt,
    })
    .from(revisions)
    .where(and(eq(revisions.entityKind, kind), eq(revisions.entityId, entityId)))
    .orderBy(desc(revisions.versionNo))
    .all();
}

export function getRevision(revId: string): Revision | null {
  return db.select().from(revisions).where(eq(revisions.id, revId)).get() ?? null;
}

/** 只允许改 note，版本内容本身不可变 */
export function patchRevision(revId: string, patch: { note?: unknown }): WriteResult<Revision> {
  const existing = getRevision(revId);
  if (!existing) return writeFail(404, "修订不存在");
  if (patch.note === undefined) return writeOk(existing);
  if (typeof patch.note !== "string") return writeFail(400, "note 必须是字符串");

  const row = db
    .update(revisions)
    .set({ note: patch.note.trim() })
    .where(eq(revisions.id, revId))
    .returning()
    .get();
  return writeOk(row);
}

/**
 * 回滚：把该版 payload 交给实体自己的写入器写回，并为回滚动作再留一版修订。
 *
 * 写入器可能自己就在写入路径里记了修订（POST/PUT 的既定行为）——那样只把那一版的
 * note 改成「回滚到第 N 版」，不再重复记账；没记则由这里补一条。
 * 不在此处开事务：写入器内部通常自带事务，better-sqlite3 不支持嵌套 BEGIN。
 */
export function restoreRevision(
  revId: string,
): WriteResult<{ revision: Revision; restoredFrom: number }> {
  const rev = getRevision(revId);
  if (!rev) return writeFail(404, "修订不存在");

  const writer = writers.get(rev.entityKind);
  if (!writer)
    return writeFail(
      501,
      `实体类型「${rev.entityKind}」尚未注册写入器，无法回滚（需在其服务模块中调用 registerEntityWriter）`,
    );

  const before = maxVersionNo(rev.entityKind, rev.entityId);
  const outcome = writer(rev.entityId, rev.payload);
  if (outcome && outcome.ok === false) return writeFail(outcome.status, outcome.error);

  const note = `回滚到第 ${rev.versionNo} 版`;
  const latest = db
    .select()
    .from(revisions)
    .where(and(eq(revisions.entityKind, rev.entityKind), eq(revisions.entityId, rev.entityId)))
    .orderBy(desc(revisions.versionNo))
    .get();

  const revision =
    latest && latest.versionNo > before
      ? db.update(revisions).set({ note }).where(eq(revisions.id, latest.id)).returning().get()
      : recordRevision(rev.entityKind, rev.entityId, rev.payload, note);

  return writeOk({ revision, restoredFrom: rev.versionNo });
}
