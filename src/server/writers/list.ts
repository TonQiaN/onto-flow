/**
 * 五个库列表 GET 的公共查询实现（DESIGN-V2 第一节契约）。
 * 放在 writers/ 下是因为模块 B 只拥有本目录，逻辑本身是只读查询。
 *
 * 契约：?q=&folder=&locate=&sort=&page=&pageSize=  →  { items, total, page, pageSize }
 * item 追加 folder: FolderRef | null（workflow 恒为 null）与 refCount: number。
 * locate=<实体 id>：反查该实体在当前过滤+排序下的页码并覆盖 page（信封返回生效
 * 页码），树上点实体叶子定位高亮用；不在过滤集内时忽略。
 */
import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { db, entityFolders, type EntityKind } from "@/db";
import {
  foldersForEntities,
  isFolderEntityKind,
  subtreeIds,
  type FolderRef,
} from "@/server/folders";
import { refCounts } from "@/server/references";

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
  folderId: string | null;
  /** 要定位的实体 id：反查其所在页并覆盖 page；不在过滤集内时忽略 */
  locate: string | null;
  sort: SortKey;
  page: number;
  pageSize: number;
}

export function parseListQuery(url: string): ListQuery {
  const sp = new URL(url).searchParams;

  const q = (sp.get("q") ?? "").trim();

  const folderRaw = (sp.get("folder") ?? "").trim();
  const folderId = folderRaw === "" ? null : folderRaw;

  const locateRaw = (sp.get("locate") ?? "").trim();
  const locate = locateRaw === "" ? null : locateRaw;

  const sortRaw = sp.get("sort") ?? "";
  const sort: SortKey = (SORT_KEYS as readonly string[]).includes(sortRaw)
    ? (sortRaw as SortKey)
    : "updated_desc";

  const pageRaw = Number.parseInt(sp.get("page") ?? "", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  const sizeRaw = Number.parseInt(sp.get("pageSize") ?? "", 10);
  const pageSize =
    Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.min(sizeRaw, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

  return { q, folderId, locate, sort, page, pageSize };
}

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface LibraryColumns {
  id: AnySQLiteColumn;
  name: AnySQLiteColumn;
  description: AnySQLiteColumn;
  updatedAt: AnySQLiteColumn;
  /** 关键词额外匹配的一列（Tool 的公名）；没有就只搜名字与描述。 */
  extraSearch?: AnySQLiteColumn;
}

export interface LibraryPage {
  /** 本页实体 id，已按 sort 排好序 */
  ids: string[];
  total: number;
  folder: Map<string, FolderRef>;
  refCount: Map<string, number>;
  /** 生效页码：locate 命中时是反查后的页码，否则等于请求的 page */
  page: number;
  pageSize: number;
}

/**
 * 过滤 + 排序 + 分页，返回本页 id 清单与 folder/refCount 批量结果。
 * 各库拿到 ids 后自行组装 DTO（按 ids 顺序输出）。
 */
export function selectLibraryPage(opts: {
  kind: EntityKind;
  table: SQLiteTable;
  columns: LibraryColumns;
  query: ListQuery;
}): LibraryPage {
  const { kind, table, columns, query } = opts;

  const conditions: SQL[] = [];

  if (query.q !== "") {
    const pattern = `%${escapeLike(query.q.toLowerCase())}%`;
    const clauses = [
      sql`lower(${columns.name}) like ${pattern} escape '\\'`,
      sql`lower(${columns.description}) like ${pattern} escape '\\'`,
      ...(columns.extraSearch === undefined
        ? []
        : [sql`lower(${columns.extraSearch}) like ${pattern} escape '\\'`]),
    ];
    conditions.push(sql`(${sql.join(clauses, sql` or `)})`);
  }

  if (query.folderId !== null && isFolderEntityKind(kind)) {
    // 「进入」语义：单选文件夹显示自身 + 全部子孙下的本库实体（ADR-0005）。
    // workflow 不进文件夹，folder 参数直接忽略（isFolderEntityKind 已排除）。
    const subtree = subtreeIds(query.folderId);
    if (subtree.length === 0) {
      // 文件夹不存在 → 强制空页，而不是回退成「全部」
      return {
        ids: [],
        total: 0,
        folder: new Map(),
        refCount: new Map(),
        page: query.page,
        pageSize: query.pageSize,
      };
    }
    const assigned = db
      .selectDistinct({ entityId: entityFolders.entityId })
      .from(entityFolders)
      .where(and(eq(entityFolders.entityKind, kind), inArray(entityFolders.folderId, subtree)));
    conditions.push(inArray(columns.id, assigned));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const total = db.select({ n: count() }).from(table).where(where).get()?.n ?? 0;

  const allRefCounts = refCounts(kind);

  // locate：目标实体落在当前过滤集内时，按当前排序反查其序号并覆盖 page，
  // 保证「点树上实体叶子定位高亮」的卡片一定出现在返回的这一页里
  let page = query.page;
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
        (allRefCounts[b.id] ?? 0) - (allRefCounts[a.id] ?? 0) || a.name.localeCompare(b.name, "zh"),
    );
    if (query.locate !== null) {
      const rank = rows.findIndex((r) => r.id === query.locate);
      if (rank >= 0) page = Math.floor(rank / query.pageSize) + 1;
    }
    const offset = (page - 1) * query.pageSize;
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
    if (query.locate !== null) {
      // 反查页码需要完整有序 id 清单（库规模小，全量可接受）；
      // 切片与反查用同一份清单，保证目标必落在返回页内
      const allIds = (
        db.select({ id: columns.id }).from(table).where(where).orderBy(orderBy).all() as Array<{
          id: string;
        }>
      ).map((r) => r.id);
      const rank = allIds.indexOf(query.locate);
      if (rank >= 0) page = Math.floor(rank / query.pageSize) + 1;
      const offset = (page - 1) * query.pageSize;
      ids = allIds.slice(offset, offset + query.pageSize);
    } else {
      const rows = db
        .select({ id: columns.id })
        .from(table)
        .where(where)
        .orderBy(orderBy)
        .limit(query.pageSize)
        .offset((page - 1) * query.pageSize)
        .all() as Array<{ id: string }>;
      ids = rows.map((r) => r.id);
    }
  }

  const folder = isFolderEntityKind(kind)
    ? foldersForEntities(kind, ids)
    : new Map<string, FolderRef>();

  return {
    ids,
    total,
    folder,
    refCount: new Map(ids.map((id) => [id, allRefCounts[id] ?? 0])),
    // locate 命中时是反查后的生效页码，前端分页条按它显示
    page,
    pageSize: query.pageSize,
  };
}

/** 给单个 item 附上 folder / refCount（workflow 不进文件夹，folder 恒为 null） */
export function withMeta<T extends { id: string }>(
  item: T,
  page: LibraryPage,
): T & { folder: FolderRef | null; refCount: number } {
  return {
    ...item,
    folder: page.folder.get(item.id) ?? null,
    refCount: page.refCount.get(item.id) ?? 0,
  };
}

/** 组装列表信封：items 按 page.ids 顺序，逐条附 folder/refCount */
export function listEnvelope<T extends { id: string }>(
  page: LibraryPage,
  rows: T[],
): {
  items: Array<T & { folder: FolderRef | null; refCount: number }>;
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
