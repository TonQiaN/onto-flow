/**
 * 删除保护：谁在引用这个实体。唯一事实源是 src/server/references.ts 的 referencesOf，
 * 五个库的 DELETE 都走这里，不再各写一份 join。
 */
import type { EntityKind } from "@/db";
import { referencesOf } from "@/server/references";

/** 引用方名称去重清单，供 409 响应的 usedBy 字段 */
export function usedByNames(kind: EntityKind, id: string): string[] {
  return [...new Set(referencesOf(kind, id).map((ref) => ref.name))];
}
