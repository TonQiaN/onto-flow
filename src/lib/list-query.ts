/**
 * 五个库列表查询的排序键与分页默认值（DESIGN-V2 第一节契约）——服务端的
 * `src/server/writers/list.ts` 与共享列表 UI（`src/components/library/`）共有的那一份。
 *
 * 放在 `src/lib/` 是因为两侧都要认同一套键与同一个 30：客户端不能从 `@/server` 导入运行时值，
 * 服务端也不该 import `src/components`。标签文案归 UI 一侧，键本身只在这里列一次。
 *
 * 纯模块：不 import 任何东西。
 */

export const SORT_KEYS = [
  "updated_desc",
  "updated_asc",
  "name_asc",
  "name_desc",
  "refs_desc",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

/** 未指定或不认识的 sort 一律回落到它（服务端与 URL 状态同一个默认）。 */
export const DEFAULT_SORT: SortKey = "updated_desc";

export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 100;

export function isSortKey(v: string | null | undefined): v is SortKey {
  return (SORT_KEYS as readonly string[]).includes(v ?? "");
}
