/**
 * 五个库（Workflow / Action / Skill / Tool / Object Type）共享 UI 的类型与小工具。
 * 契约见 docs/DESIGN-V2.md 第一/二/三/四节。
 */

export type EntityKind =
  | "workflow"
  | "action"
  | "skill"
  | "tool"
  | "object_type";

export const ENTITY_KIND_LABEL: Record<EntityKind, string> = {
  workflow: "工作流",
  action: "Action",
  skill: "Skill",
  tool: "Tool",
  object_type: "对象类型",
};

/** 各库前端路径，用于引用面板兜底跳转 */
export const ENTITY_KIND_PATH: Record<EntityKind, string> = {
  workflow: "/workflows",
  action: "/actions",
  skill: "/skills",
  tool: "/tools",
  object_type: "/object-types",
};

/** 各库 REST 路径（取当前定义做 diff 用） */
export const ENTITY_KIND_API: Record<EntityKind, string> = {
  workflow: "/api/workflows",
  action: "/api/actions",
  skill: "/api/skills",
  tool: "/api/tools",
  object_type: "/api/object-types",
};

export type SortKey =
  | "updated_desc"
  | "updated_asc"
  | "name_asc"
  | "name_desc"
  | "refs_desc";

export const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: "updated_desc", label: "最近更新" },
  { value: "updated_asc", label: "最早更新" },
  { value: "name_asc", label: "名称升序" },
  { value: "name_desc", label: "名称降序" },
  { value: "refs_desc", label: "引用最多" },
];

export const DEFAULT_SORT: SortKey = "updated_desc";
export const DEFAULT_PAGE_SIZE = 30;

export function isSortKey(v: string | null | undefined): v is SortKey {
  return SORT_OPTIONS.some((o) => o.value === v);
}

export interface Tag {
  id: string;
  name: string;
  color: string | null;
}

/** GET /api/tags 的元素：带各库下的挂载计数 */
export interface TagWithCounts extends Tag {
  counts: Partial<Record<EntityKind, number>>;
}

/** 通用列表信封（DESIGN-V2 第一节） */
export interface ListEnvelope<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 列表项在原有字段上追加的公共部分 */
export interface WithLibraryMeta {
  tags: Tag[];
  refCount: number;
}

/** GET /api/references 的一条引用 */
export interface EntityReference {
  kind: "workflow" | "action";
  id: string;
  name: string;
  detail: string;
  href: string;
}

export interface RevisionSummary {
  id: string;
  versionNo: number;
  note: string;
  pinned: boolean;
  createdAt: string | number;
}

export interface RevisionDetail extends RevisionSummary {
  payload: Record<string, unknown>;
}

/** 标签集合发生变化（新建/指派）时广播，标签树据此刷新计数 */
export const TAGS_CHANGED_EVENT = "flowforge:tags-changed";

export function notifyTagsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TAGS_CHANGED_EVENT));
}

export async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // 响应体不是 JSON
  }
  return `请求失败（HTTP ${res.status}）`;
}

export function formatTime(value: string | number | null | undefined): string {
  if (value == null) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", { hour12: false });
}

/** 柔和色板：tag.color 为空时按名字哈希取稳定色 */
const TAG_PALETTE = [
  "#93c5fd",
  "#a5b4fc",
  "#c4b5fd",
  "#f0abfc",
  "#f9a8d4",
  "#fca5a5",
  "#fdba74",
  "#fcd34d",
  "#86efac",
  "#5eead4",
  "#7dd3fc",
  "#d8b4fe",
] as const;

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** 标签色点：显式 color 优先，否则按名字哈希取稳定柔和色 */
export function tagColor(tag: { name: string; color?: string | null }): string {
  if (tag.color && tag.color.trim()) return tag.color.trim();
  return TAG_PALETTE[hashString(tag.name) % TAG_PALETTE.length]!;
}

/** 标签名末段（`采购/集采` → `集采`） */
export function tagLeafName(name: string): string {
  const parts = name.split("/");
  return parts[parts.length - 1] ?? name;
}
