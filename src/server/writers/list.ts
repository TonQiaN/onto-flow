/**
 * 五个库列表 GET 的公共查询实现（DESIGN-V2 第一节契约）。
 * 放在 writers/ 下是因为模块 B 只拥有本目录，逻辑本身是只读查询。
 *
 * 契约：?q=&tags=&sort=&page=&pageSize=  →  { items, total, page, pageSize }
 * item 追加 tags: Array<{id,name,color}> 与 refCount: number。
 */
import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { db, entityTags, type EntityKind } from "@/db";
import { refCounts } from "@/server/references";
import { tagsForEntities, type TagDto } from "@/server/tags";

export const SORT_KEYS = [
  "updated_desc",
  "updated_asc",
  "name_asc",
  "name_desc",
  "refs_desc",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 100;

export interface ListQuery {
  q: string;
  tagIds: string[];
  sort: SortKey;
  page: number;
  pageSize: number;
}

export function parseListQuery(url: string): ListQuery {
  const sp = new URL(url).searchParams;

  const q = (sp.get("q") ?? "").trim();

  const tagIds = [
    ...new Set(
      (sp.get("tags") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    ),
  ];

  const sortRaw = sp.get("sort") ?? "";
  const sort: SortKey = (SORT_KEYS as readonly string[]).includes(sortRaw)
    ? (sortRaw as SortKey)
    : "updated_desc";

  const pageRaw = Number.parseInt(sp.get("page") ?? "", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  const sizeRaw = Number.parseInt(sp.get("pageSize") ?? "", 10);
  const pageSize =
    Number.isFinite(sizeRaw) && sizeRaw > 0
      ? Math.min(sizeRaw, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

  return { q, tagIds, sort, page, pageSize };
}

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface LibraryColumns {
  id: AnySQLiteColumn;
  name: AnySQLiteColumn;
  description: AnySQLiteColumn;
  updatedAt: AnySQLiteColumn;
}

export interface LibraryPage {
  /** 本页实体 id，已按 sort 排好序 */
  ids: string[];
  total: number;
  tags: Map<string, TagDto[]>;
  refCount: Map<string, number>;
  page: number;
  pageSize: number;
}

/**
 * 过滤 + 排序 + 分页，返回本页 id 清单与 tags/refCount 批量结果。
 * 各库拿到 ids 后自行组装 DTO（按 ids 顺序输出）。
 */
export function selectLibraryPage(opts: {
  kind: EntityKind;
  table: SQLiteTable;
  columns: LibraryColumns;
  query: ListQuery;
}): LibraryPage {
  const { kind, table, columns, query } = opts;
  const offset = (query.page - 1) * query.pageSize;

  const conditions: SQL[] = [];

  if (query.q !== "") {
    const pattern = `%${escapeLike(query.q.toLowerCase())}%`;
    conditions.push(
      sql`(lower(${columns.name}) like ${pattern} escape '\\' or lower(${columns.description}) like ${pattern} escape '\\')`,
    );
  }

  if (query.tagIds.length > 0) {
    // AND 语义：同时具备全部所选标签
    const tagged = db
      .select({ entityId: entityTags.entityId })
      .from(entityTags)
      .where(
        and(
          eq(entityTags.entityKind, kind),
          inArray(entityTags.tagId, query.tagIds),
        ),
      )
      .groupBy(entityTags.entityId)
      .having(sql`count(distinct ${entityTags.tagId}) = ${query.tagIds.length}`);
    conditions.push(inArray(columns.id, tagged));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const total =
    db.select({ n: count() }).from(table).where(where).get()?.n ?? 0;

  const allRefCounts = refCounts(kind);

  let ids: string[];
  if (query.sort === "refs_desc") {
    // refCount 由 references.ts 在应用层算出，无法下推 SQL：取过滤结果再排序切片
    const rows = db
      .select({ id: columns.id, name: columns.name })
      .from(table)
      .where(where)
      .all() as Array<{ id: string; name: string }>;
    rows.sort(
      (a, b) =>
        (allRefCounts[b.id] ?? 0) - (allRefCounts[a.id] ?? 0) ||
        a.name.localeCompare(b.name, "zh"),
    );
    ids = rows.slice(offset, offset + query.pageSize).map((r) => r.id);
  } else {
    const orderBy =
      query.sort === "updated_asc"
        ? asc(columns.updatedAt)
        : query.sort === "name_asc"
          ? asc(columns.name)
          : query.sort === "name_desc"
            ? desc(columns.name)
            : desc(columns.updatedAt);
    const rows = db
      .select({ id: columns.id })
      .from(table)
      .where(where)
      .orderBy(orderBy)
      .limit(query.pageSize)
      .offset(offset)
      .all() as Array<{ id: string }>;
    ids = rows.map((r) => r.id);
  }

  const tags = tagsForEntities(kind, ids);

  return {
    ids,
    total,
    tags,
    refCount: new Map(ids.map((id) => [id, allRefCounts[id] ?? 0])),
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** 给单个 item 附上 tags / refCount */
export function withMeta<T extends { id: string }>(
  item: T,
  page: LibraryPage,
): T & { tags: TagDto[]; refCount: number } {
  return {
    ...item,
    tags: page.tags.get(item.id) ?? [],
    refCount: page.refCount.get(item.id) ?? 0,
  };
}

/** 组装列表信封：items 按 page.ids 顺序，逐条附 tags/refCount */
export function listEnvelope<T extends { id: string }>(
  page: LibraryPage,
  rows: T[],
): {
  items: Array<T & { tags: TagDto[]; refCount: number }>;
  total: number;
  page: number;
  pageSize: number;
} {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items = page.ids
    .flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    })
    .map((row) => withMeta(row, page));
  return {
    items,
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
  };
}
