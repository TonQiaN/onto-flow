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

/** GET /api/folders 的文件夹元素：扁平返回，树形由前端组装（ADR-0005） */
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

/** GET /api/folders?kind=... 返回的本库实体叶子；folderId 为空 = 未归类 */
export interface EntityLeaf {
  id: string;
  name: string;
  folderId: string | null;
}

/** 通用列表信封（DESIGN-V2 第一节） */
export interface ListEnvelope<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 列表项在原有字段上追加的公共部分（workflow 不分类，folder 恒为 null） */
export interface WithLibraryMeta {
  folder: FolderRef | null;
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

/** 文件夹结构或实体归属变化时广播：FolderTree 刷新，列表页重载 */
export const FOLDERS_CHANGED_EVENT = "flowforge:folders-changed";

export function notifyFoldersChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FOLDERS_CHANGED_EVENT));
}

/** 拖拽 MIME：实体 payload 是 JSON {kind, id}；文件夹 payload 是 folder id 字符串 */
export const DND_ENTITY_MIME = "application/x-flowforge-entity";
export const DND_FOLDER_MIME = "application/x-flowforge-folder";

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
