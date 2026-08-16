/**
 * 文件夹服务：跨四个库共享的单归属流程树（ADR-0005，推翻 ADR-0003 的标签体系）。
 * name 是单段名（不含 `/`），层级由 parentId 表达；workflow 明确不进文件夹。
 *
 * 对外接口（其它模块可直接 import，签名保持稳定）：
 *   foldersForEntities(kind, ids): Map<entityId, FolderRef>   ← 四个库列表 API 批量取归属
 *   subtreeIds(folderId)：自身+全部子孙 id                     ← 列表过滤「含子孙」语义
 *   listFolders / listEntityLeaves / createFolder / updateFolder / deleteFolder
 *   assignEntityFolder / normalizeFolderName / isFolderEntityKind
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  FOLDER_ENTITY_KINDS,
  db,
  entityFolders,
  folders,
  type FolderEntityKind,
} from "@/db";
import { entityExists, listEntities } from "@/server/references";

export interface FolderDto {
  id: string;
  name: string;
  parentId: string | null;
}

/** 实体卡片/编辑器上显示的归属：path = 根到本文件夹的 name 用 "/" 连接（如 "采购/集采"） */
export interface FolderRef {
  id: string;
  name: string;
  path: string;
}

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const fail = (status: number, error: string): Result<never> => ({
  ok: false,
  status,
  error,
});

export function isFolderEntityKind(v: string): v is FolderEntityKind {
  return (FOLDER_ENTITY_KINDS as readonly string[]).includes(v);
}

function toDto(row: typeof folders.$inferSelect): FolderDto {
  return { id: row.id, name: row.name, parentId: row.parentId };
}

/** 全部文件夹，按 name 升序（树形由前端组装） */
export function listFolders(): FolderDto[] {
  return db
    .select()
    .from(folders)
    .orderBy(asc(folders.name))
    .all()
    .map(toDto);
}

/**
 * 某库全部实体叶子：{ id, name, folderId|null }，按 name 升序。
 * 复用 references.listEntities 拿 id/name；entity_id 无外键，
 * 已删实体的残留指派行因不在 listEntities 里而自然被排除。
 */
export function listEntityLeaves(
  kind: FolderEntityKind,
): Array<{ id: string; name: string; folderId: string | null }> {
  const assigned = new Map(
    db
      .select({
        entityId: entityFolders.entityId,
        folderId: entityFolders.folderId,
      })
      .from(entityFolders)
      .where(eq(entityFolders.entityKind, kind))
      .all()
      .map((r) => [r.entityId, r.folderId] as const),
  );
  return listEntities(kind).map((e) => ({
    id: e.id,
    name: e.name,
    folderId: assigned.get(e.id) ?? null,
  }));
}

/** 文件夹名规范化：折叠连续空白、去首尾空白；拒绝空名与含 `/`（层级由 parentId 表达） */
export function normalizeFolderName(raw: unknown): Result<string> {
  if (typeof raw !== "string") return fail(400, "文件夹名必须是字符串");
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed === "") return fail(400, "文件夹名不能为空");
  if (collapsed.includes("/"))
    return fail(400, "文件夹名不能包含 /（层级请用子文件夹表达）");
  return ok(collapsed);
}

/** parentId 入参解析：undefined/null = 根层级，其余必须是字符串 */
function parseParentId(raw: unknown): Result<string | null> {
  if (raw === undefined || raw === null) return ok(null);
  if (typeof raw !== "string" || raw === "")
    return fail(400, "parentId 必须是字符串或 null");
  return ok(raw);
}

function folderById(id: string): typeof folders.$inferSelect | undefined {
  return db.select().from(folders).where(eq(folders.id, id)).get();
}

/** 同级（同 parentId）是否已有同名文件夹；excludeId 用于排除自身 */
function siblingNameTaken(
  name: string,
  parentId: string | null,
  excludeId?: string,
): boolean {
  // 用 .all().some() 而非 .get()：万一历史数据里已存在重名，.get() 只取第一条
  // 命中会让结果依插入顺序而异，这里逐条排除 excludeId 后再判断
  return db
    .select({ id: folders.id })
    .from(folders)
    .where(
      and(
        eq(folders.name, name),
        parentId === null
          ? isNull(folders.parentId)
          : eq(folders.parentId, parentId),
      ),
    )
    .all()
    .some((clash) => clash.id !== excludeId);
}

/** 创建：校验 parent 存在（parentId 可 null）、同级同名 409 */
export function createFolder(
  rawName: unknown,
  rawParentId: unknown,
): Result<FolderDto> {
  const name = normalizeFolderName(rawName);
  if (!name.ok) return name;
  const parentId = parseParentId(rawParentId);
  if (!parentId.ok) return parentId;
  if (parentId.data !== null && !folderById(parentId.data))
    return fail(404, "父文件夹不存在");
  if (siblingNameTaken(name.data, parentId.data))
    return fail(409, `同级已有文件夹「${name.data}」`);
  const row = db
    .insert(folders)
    .values({ name: name.data, parentId: parentId.data })
    .returning()
    .get();
  return ok(toDto(row));
}

/**
 * 重命名 and/or 移动。patch.parentId === null 表示移到根，undefined 表示不动。
 * 移动校验：目标存在、不能移到自己或自己的子孙（循环）、目标同级同名 409。
 */
export function updateFolder(
  id: string,
  patch: { name?: unknown; parentId?: unknown },
): Result<FolderDto> {
  const existing = folderById(id);
  if (!existing) return fail(404, "文件夹不存在");

  let nextName = existing.name;
  if (patch.name !== undefined) {
    const name = normalizeFolderName(patch.name);
    if (!name.ok) return name;
    nextName = name.data;
  }

  let nextParentId = existing.parentId;
  if (patch.parentId !== undefined) {
    const parentId = parseParentId(patch.parentId);
    if (!parentId.ok) return parentId;
    nextParentId = parentId.data;
    if (nextParentId !== null) {
      if (!folderById(nextParentId)) return fail(404, "目标文件夹不存在");
      if (subtreeIds(id).includes(nextParentId))
        return fail(400, "不能把文件夹移到自己或自己的子孙下");
    }
  }

  if (siblingNameTaken(nextName, nextParentId, id))
    return fail(409, `同级已有文件夹「${nextName}」`);

  const row = db
    .update(folders)
    .set({ name: nextName, parentId: nextParentId })
    .where(eq(folders.id, id))
    .returning()
    .get();
  return ok(toDto(row));
}

/**
 * 删除：事务内把子文件夹 parentId、entity_folders.folderId 全部改成被删文件夹的
 * parentId（父为 null 时实体指派行直接删除＝变未归类），然后删文件夹。实体永不跟随删除。
 */
export function deleteFolder(id: string): Result<{ ok: true }> {
  const existing = folderById(id);
  if (!existing) return fail(404, "文件夹不存在");
  // 内容上移前先查重：子文件夹将移到被删文件夹的父级，若与该层级现有文件夹重名，
  // 会打破「同级同名由服务层拒绝」的不变量（createFolder/updateFolder 都是 409，
  // 这里保持一致）。excludeId 传本文件夹 id：与被删文件夹自身同名的子文件夹
  // 上移合法——父名随删除消失。子文件夹彼此本就同级，不变量保证互不重名。
  const children = db
    .select({ name: folders.name })
    .from(folders)
    .where(eq(folders.parentId, id))
    .all();
  for (const child of children) {
    if (siblingNameTaken(child.name, existing.parentId, id))
      return fail(
        409,
        `删除后子文件夹「${child.name}」将与目标层级现有文件夹重名，请先重命名`,
      );
  }
  db.transaction((tx) => {
    tx.update(folders)
      .set({ parentId: existing.parentId })
      .where(eq(folders.parentId, id))
      .run();
    if (existing.parentId === null) {
      tx.delete(entityFolders).where(eq(entityFolders.folderId, id)).run();
    } else {
      tx.update(entityFolders)
        .set({ folderId: existing.parentId })
        .where(eq(entityFolders.folderId, id))
        .run();
    }
    tx.delete(folders).where(eq(folders.id, id)).run();
  });
  return ok({ ok: true });
}

/** 单归属指派：folderId 为 null 时删除指派行（变未归类）。整体替换语义（先删后插） */
export function assignEntityFolder(
  kind: FolderEntityKind,
  entityId: string,
  folderId: string | null,
): Result<{ ok: true }> {
  if (!entityExists(kind, entityId)) return fail(404, "实体不存在");
  if (folderId !== null && !folderById(folderId))
    return fail(404, "文件夹不存在");
  db.transaction((tx) => {
    tx.delete(entityFolders)
      .where(
        and(
          eq(entityFolders.entityKind, kind),
          eq(entityFolders.entityId, entityId),
        ),
      )
      .run();
    if (folderId !== null)
      tx.insert(entityFolders)
        .values({ entityKind: kind, entityId, folderId })
        .run();
  });
  return ok({ ok: true });
}

/** 全部文件夹的 id → 行 映射，路径拼接与子树遍历共用 */
function folderMap(): Map<string, { name: string; parentId: string | null }> {
  return new Map(
    db
      .select({
        id: folders.id,
        name: folders.name,
        parentId: folders.parentId,
      })
      .from(folders)
      .all()
      .map((r) => [r.id, { name: r.name, parentId: r.parentId }] as const),
  );
}

/** 根到本文件夹的 name 用 "/" 连接（如 "采购/集采"） */
function folderPath(
  id: string,
  byId: Map<string, { name: string; parentId: string | null }>,
): string {
  const segments: string[] = [];
  let cursor: string | null = id;
  while (cursor !== null) {
    const row = byId.get(cursor);
    if (!row) break;
    segments.unshift(row.name);
    cursor = row.parentId;
  }
  return segments.join("/");
}

/**
 * 【对外接口】批量取归属，供四个库的列表 API 一次查完本页实体。
 * 返回 Map：entityId → FolderRef；未归类实体不出现在 Map 里。
 */
export function foldersForEntities(
  kind: FolderEntityKind,
  ids: string[],
): Map<string, FolderRef> {
  const result = new Map<string, FolderRef>();
  if (ids.length === 0) return result;
  const rows = db
    .select({
      entityId: entityFolders.entityId,
      folderId: entityFolders.folderId,
    })
    .from(entityFolders)
    .where(
      and(
        eq(entityFolders.entityKind, kind),
        inArray(entityFolders.entityId, ids),
      ),
    )
    .all();
  if (rows.length === 0) return result;
  const byId = folderMap();
  for (const row of rows) {
    const folder = byId.get(row.folderId);
    if (!folder) continue;
    result.set(row.entityId, {
      id: row.folderId,
      name: folder.name,
      path: folderPath(row.folderId, byId),
    });
  }
  return result;
}

/** 自身+全部子孙 id（列表过滤「进入文件夹含子孙」语义）；文件夹不存在返回 [] */
export function subtreeIds(folderId: string): string[] {
  const byId = folderMap();
  if (!byId.has(folderId)) return [];
  const children = new Map<string | null, string[]>();
  for (const [id, row] of byId) {
    const list = children.get(row.parentId) ?? [];
    list.push(id);
    children.set(row.parentId, list);
  }
  const result: string[] = [];
  const queue = [folderId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    result.push(current);
    queue.push(...(children.get(current) ?? []));
  }
  return result;
}
