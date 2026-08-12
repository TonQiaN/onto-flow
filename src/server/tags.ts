/**
 * 标签服务：跨五个库的多归属分类（ADR-0003）。
 * 名字用 `/` 表达层级，语义上仍是标签而非文件夹——树形只是渲染方式。
 *
 * 对外接口（其它模块可直接 import，签名保持稳定）：
 *   tagsForEntities(kind, ids): Map<entityId, TagDto[]>   ← 五个库列表 API 批量取标签
 *   listTags / createTag / updateTag / deleteTag / assignTags / tagsOf
 *   normalizeTagName（名字规范化，UI 与 API 共用同一套规则）
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  ENTITY_KINDS,
  db,
  entityTags,
  tags,
  type EntityKind,
} from "@/db";
import { entityExists, listEntities } from "@/server/references";

export interface TagDto {
  id: string;
  name: string;
  color: string | null;
}

export interface TagWithCounts extends TagDto {
  /** 该标签在各库下的挂载数，五个 kind 全在，未挂载为 0 */
  counts: Record<EntityKind, number>;
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

function zeroCounts(): Record<EntityKind, number> {
  return {
    workflow: 0,
    action: 0,
    skill: 0,
    tool: 0,
    object_type: 0,
  };
}

function toDto(row: typeof tags.$inferSelect): TagDto {
  return { id: row.id, name: row.name, color: row.color };
}

/**
 * 标签名规范化：去首尾空白、折叠连续空白、逐段 trim。
 * 拒绝：空名、首尾斜杠、空层级（`a//b`）。
 */
export function normalizeTagName(raw: unknown): Result<string> {
  if (typeof raw !== "string") return fail(400, "标签名必须是字符串");
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed === "") return fail(400, "标签名不能为空");
  if (collapsed.startsWith("/") || collapsed.endsWith("/"))
    return fail(400, "标签名不能以 / 开头或结尾");
  const segments = collapsed.split("/").map((s) => s.trim());
  if (segments.some((s) => s === ""))
    return fail(400, "标签名不能有空层级（如「采购//集采」）");
  return ok(segments.join("/"));
}

function parseColor(raw: unknown): Result<string | null> {
  if (raw === undefined || raw === null) return ok(null);
  if (typeof raw !== "string") return fail(400, "颜色必须是字符串");
  const value = raw.trim();
  return ok(value === "" ? null : value);
}

/**
 * 各标签在各库下的挂载数。
 * entity_id 没有外键，实体删除后可能残留关联行，故按现存实体过滤，避免虚高。
 */
function countsByTag(): Map<string, Record<EntityKind, number>> {
  const rows = db.select().from(entityTags).all();
  const alive = new Map<EntityKind, Set<string>>(
    ENTITY_KINDS.map((kind) => [
      kind,
      new Set(listEntities(kind).map((e) => e.id)),
    ]),
  );
  const counts = new Map<string, Record<EntityKind, number>>();
  for (const row of rows) {
    if (!alive.get(row.entityKind)?.has(row.entityId)) continue;
    let entry = counts.get(row.tagId);
    if (!entry) {
      entry = zeroCounts();
      counts.set(row.tagId, entry);
    }
    entry[row.entityKind] += 1;
  }
  return counts;
}

/**
 * 标签清单，按 name 升序。
 * 传 kind 时只返回该库下挂载过的标签（列表页左树用）；
 * 不传则返回全部标签（标签选择器用）。counts 始终含全部五个 kind。
 */
export function listTags(kind?: EntityKind): TagWithCounts[] {
  const counts = countsByTag();
  return db
    .select()
    .from(tags)
    .orderBy(asc(tags.name))
    .all()
    .map((row) => ({
      ...toDto(row),
      counts: counts.get(row.id) ?? zeroCounts(),
    }))
    .filter((tag) => (kind ? tag.counts[kind] > 0 : true));
}

export function createTag(rawName: unknown, rawColor: unknown): Result<TagDto> {
  const name = normalizeTagName(rawName);
  if (!name.ok) return name;
  const color = parseColor(rawColor);
  if (!color.ok) return color;
  if (db.select().from(tags).where(eq(tags.name, name.data)).get())
    return fail(409, `标签「${name.data}」已存在`);
  const row = db
    .insert(tags)
    .values({ name: name.data, color: color.data })
    .returning()
    .get();
  return ok(toDto(row));
}

/** 改名是全局操作：所有挂载该标签的实体一起变 */
export function updateTag(
  id: string,
  patch: { name?: unknown; color?: unknown },
): Result<TagDto> {
  const existing = db.select().from(tags).where(eq(tags.id, id)).get();
  if (!existing) return fail(404, "标签不存在");

  const values: { name?: string; color?: string | null } = {};
  if (patch.name !== undefined) {
    const name = normalizeTagName(patch.name);
    if (!name.ok) return name;
    const clash = db
      .select({ id: tags.id })
      .from(tags)
      .where(eq(tags.name, name.data))
      .get();
    if (clash && clash.id !== id) return fail(409, `标签「${name.data}」已存在`);
    values.name = name.data;
  }
  if (patch.color !== undefined) {
    const color = parseColor(patch.color);
    if (!color.ok) return color;
    values.color = color.data;
  }
  if (Object.keys(values).length === 0) return ok(toDto(existing));

  const row = db
    .update(tags)
    .set(values)
    .where(eq(tags.id, id))
    .returning()
    .get();
  return ok(toDto(row));
}

/** 标签是软分类，删除无需引用保护；entity_tags 由外键级联清除 */
export function deleteTag(id: string): Result<{ ok: true }> {
  if (!db.select({ id: tags.id }).from(tags).where(eq(tags.id, id)).get())
    return fail(404, "标签不存在");
  db.delete(tags).where(eq(tags.id, id)).run();
  return ok({ ok: true });
}

/** 某个实体当前的标签，按 name 升序 */
export function tagsOf(kind: EntityKind, entityId: string): TagDto[] {
  return db
    .select({ id: tags.id, name: tags.name, color: tags.color })
    .from(entityTags)
    .innerJoin(tags, eq(entityTags.tagId, tags.id))
    .where(
      and(eq(entityTags.entityKind, kind), eq(entityTags.entityId, entityId)),
    )
    .orderBy(asc(tags.name))
    .all();
}

/**
 * 【对外接口】批量取标签，供五个库的列表 API 一次查完本页实体。
 * 返回 Map：entityId → 该实体的标签（按 name 升序）；没有标签的实体不出现在 Map 里。
 */
export function tagsForEntities(
  kind: EntityKind,
  ids: string[],
): Map<string, TagDto[]> {
  const result = new Map<string, TagDto[]>();
  if (ids.length === 0) return result;
  const rows = db
    .select({
      entityId: entityTags.entityId,
      id: tags.id,
      name: tags.name,
      color: tags.color,
    })
    .from(entityTags)
    .innerJoin(tags, eq(entityTags.tagId, tags.id))
    .where(
      and(eq(entityTags.entityKind, kind), inArray(entityTags.entityId, ids)),
    )
    .orderBy(asc(tags.name))
    .all();
  for (const row of rows) {
    const list = result.get(row.entityId) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    result.set(row.entityId, list);
  }
  return result;
}

/** 整体替换某实体的标签集合（事务内先删后插） */
export function assignTags(
  kind: EntityKind,
  entityId: string,
  rawTagIds: unknown,
): Result<TagDto[]> {
  if (!entityExists(kind, entityId)) return fail(404, "实体不存在");
  if (!Array.isArray(rawTagIds)) return fail(400, "tagIds 必须是字符串数组");
  const tagIds: string[] = [];
  for (const item of rawTagIds) {
    if (typeof item !== "string") return fail(400, "tagIds 必须是字符串数组");
    if (!tagIds.includes(item)) tagIds.push(item);
  }
  if (tagIds.length > 0) {
    const found = new Set(
      db
        .select({ id: tags.id })
        .from(tags)
        .where(inArray(tags.id, tagIds))
        .all()
        .map((t) => t.id),
    );
    if (tagIds.some((t) => !found.has(t))) return fail(400, "存在不存在的标签");
  }

  db.transaction((tx) => {
    tx.delete(entityTags)
      .where(
        and(eq(entityTags.entityKind, kind), eq(entityTags.entityId, entityId)),
      )
      .run();
    if (tagIds.length > 0)
      tx.insert(entityTags)
        .values(tagIds.map((tagId) => ({ entityKind: kind, entityId, tagId })))
        .run();
  });

  return ok(tagsOf(kind, entityId));
}
