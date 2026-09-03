"use client";

import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DND_ENTITY_MIME,
  DND_FOLDER_MIME,
  type EntityKind,
  type EntityLeaf,
  type FolderDto,
  FOLDERS_CHANGED_EVENT,
  notifyFoldersChanged,
  readError,
} from "./types";

const JSON_HEADERS = { "Content-Type": "application/json" };

/** 「全部」行作为 drop 目标时的高亮键（不会与 folder id 撞车的哨兵值） */
const ALL_DROP_KEY = "__all__";

interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  /** 根到本文件夹的 name 用 "/" 连接（行 title 用它，e2e 依赖） */
  path: string;
  children: FolderNode[];
  /** 直属的本库实体叶子 */
  entities: EntityLeaf[];
  /** 自身 + 全部子孙的本库实体数（行尾计数） */
  totalCount: number;
}

const byZhName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, "zh-Hans-CN");

/**
 * 扁平 folders + entities 组装树：文件夹在前、实体在后，各自按中文名升序；
 * 未归类实体（folderId 为空或指向不存在的文件夹）作为根级散叶子返回。
 */
function buildTree(
  folders: FolderDto[],
  entities: EntityLeaf[],
): { roots: FolderNode[]; rootEntities: EntityLeaf[] } {
  const byId = new Map<string, FolderNode>();
  for (const f of folders) {
    byId.set(f.id, {
      id: f.id,
      name: f.name,
      parentId: f.parentId,
      path: f.name,
      children: [],
      entities: [],
      totalCount: 0,
    });
  }
  const roots: FolderNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const rootEntities: EntityLeaf[] = [];
  for (const entity of entities) {
    const owner = entity.folderId ? byId.get(entity.folderId) : undefined;
    if (owner) owner.entities.push(entity);
    else rootEntities.push(entity);
  }
  const finish = (node: FolderNode, prefix: string) => {
    node.path = prefix ? `${prefix}/${node.name}` : node.name;
    node.children.sort(byZhName);
    node.entities.sort(byZhName);
    node.totalCount = node.entities.length;
    for (const child of node.children) {
      finish(child, node.path);
      node.totalCount += child.totalCount;
    }
  };
  roots.sort(byZhName);
  for (const root of roots) finish(root, "");
  rootEntities.sort(byZhName);
  return { roots, rootEntities };
}

/** 按关键词剪枝：命中文件夹名保留整棵子树；否则只留命中的子孙文件夹/实体 */
function pruneTree(nodes: FolderNode[], keyword: string): FolderNode[] {
  const lower = keyword.toLowerCase();
  const walk = (node: FolderNode): FolderNode | null => {
    if (node.name.toLowerCase().includes(lower)) return node;
    const children = node.children.map(walk).filter((n): n is FolderNode => n !== null);
    const leaves = node.entities.filter((e) => e.name.toLowerCase().includes(lower));
    if (children.length === 0 && leaves.length === 0) return null;
    return { ...node, children, entities: leaves };
  };
  return nodes.map(walk).filter((n): n is FolderNode => n !== null);
}

/** 收集所有「有内容可折叠」的文件夹 id（全部展开/折叠用） */
function collectExpandableIds(nodes: FolderNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.children.length > 0 || node.entities.length > 0) out.push(node.id);
    collectExpandableIds(node.children, out);
  }
  return out;
}

/** 小文件夹图标：内联 SVG，颜色随 currentColor 走 zinc 系 */
function FolderIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      className={className}
      aria-hidden="true"
    >
      <path d="M1.75 4.25c0-.55.45-1 1-1h3.1l1.4 1.5h6c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1v-7.5Z" />
    </svg>
  );
}

/** 实体叶子的小文档图标 */
function FileIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      className={className}
      aria-hidden="true"
    >
      <path d="M4.25 1.75h5L12 4.5v9.75H4.25V1.75Z" />
      <path d="M9.25 1.75V4.5H12" />
    </svg>
  );
}

/**
 * 文件夹树（列表页左栏，ADR-0005）：全局一棵树 + 本库实体叶子（Zed 式）。
 * 单选「进入」文件夹（onSelect），右侧列表显示该文件夹及全部子孙的实体；
 * 点实体叶子 onOpenEntity（页面据此进入其文件夹并高亮卡片）。
 * 管理操作全在树上：右键菜单（新建子文件夹/重命名/删除）、树顶「＋」新建根文件夹、
 * 拖实体入文件夹、拖文件夹改层级（「全部」行 = 拖回根/未归类）。
 */
export function FolderTree({
  kind,
  selected,
  onSelect,
  onOpenEntity,
}: {
  kind: EntityKind;
  selected: string | null;
  onSelect: (folderId: string | null) => void;
  onOpenEntity: (entity: EntityLeaf) => void;
}) {
  const [data, setData] = useState<{
    folders: FolderDto[];
    entities: EntityLeaf[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 变更操作（新建/重命名/删除/拖拽）的错误，展示在树内小红条 */
  const [opError, setOpError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** 右键菜单：fixed 定位在鼠标处，点击外部/Esc 关闭 */
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    id: string;
    name: string;
    path: string;
  } | null>(null);
  /** 行内输入：新建（根/子）或重命名，Enter 提交 Esc 取消 */
  const [editing, setEditing] = useState<
    { mode: "create"; parentId: string | null } | { mode: "rename"; id: string } | null
  >(null);
  const [editText, setEditText] = useState("");
  /** 当前 dragover 高亮的目标：folder id 或 ALL_DROP_KEY */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** 本树内正在拖动的文件夹 id（dragover 阶段读不到 dataTransfer 数据，靠它挡自己/子孙） */
  const draggingFolderRef = useRef<string | null>(null);
  const editBusyRef = useRef(false);
  /** 请求序号守卫：只有最新一次 load 的结果才允许落地，防止旧响应后返覆盖新结果 */
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/folders?kind=${encodeURIComponent(kind)}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const message = await readError(res);
        if (seq !== loadSeqRef.current) return;
        setError(message);
        return;
      }
      const raw = (await res.json()) as {
        folders?: FolderDto[];
        entities?: EntityLeaf[];
      };
      if (seq !== loadSeqRef.current) return;
      setData({
        folders: Array.isArray(raw.folders) ? raw.folders : [],
        entities: Array.isArray(raw.entities) ? raw.entities : [],
      });
    } catch {
      if (seq !== loadSeqRef.current) return;
      setError("网络错误，无法加载文件夹");
    } finally {
      // 过期请求不许把新请求的 loading 提前关掉
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const handler = () => void load();
    window.addEventListener(FOLDERS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(FOLDERS_CHANGED_EVENT, handler);
  }, [load]);

  // 右键菜单：点击外部 / Esc 关闭
  useEffect(() => {
    if (!menu) return;
    const onDocDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const { roots, rootEntities } = useMemo(
    () => buildTree(data?.folders ?? [], data?.entities ?? []),
    [data],
  );
  const searching = keyword.trim().length > 0;
  const visibleRoots = useMemo(
    () => (searching ? pruneTree(roots, keyword.trim()) : roots),
    [roots, keyword, searching],
  );
  const visibleRootEntities = useMemo(() => {
    if (!searching) return rootEntities;
    const lower = keyword.trim().toLowerCase();
    return rootEntities.filter((e) => e.name.toLowerCase().includes(lower));
  }, [rootEntities, keyword, searching]);

  /** id → parentId，供「拖到自己/子孙」判断走父链 */
  const parentById = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const f of data?.folders ?? []) m.set(f.id, f.parentId);
    return m;
  }, [data]);

  const isSelfOrDescendant = useCallback(
    (rootId: string, id: string | null): boolean => {
      let cur = id;
      while (cur) {
        if (cur === rootId) return true;
        cur = parentById.get(cur) ?? null;
      }
      return false;
    },
    [parentById],
  );

  /* ------------------------------ 变更操作 ------------------------------ */

  /** 行内输入提交：create → POST /api/folders；rename → PATCH /api/folders/[id] */
  const submitEdit = async () => {
    if (!editing || editBusyRef.current) return;
    const name = editText.trim();
    if (!name) {
      setEditing(null);
      return;
    }
    editBusyRef.current = true;
    setOpError(null);
    try {
      const res =
        editing.mode === "create"
          ? await fetch("/api/folders", {
              method: "POST",
              headers: JSON_HEADERS,
              body: JSON.stringify(
                editing.parentId ? { name, parentId: editing.parentId } : { name },
              ),
            })
          : await fetch(`/api/folders/${editing.id}`, {
              method: "PATCH",
              headers: JSON_HEADERS,
              body: JSON.stringify({ name }),
            });
      if (!res.ok) {
        // 同级重名等失败时保留输入框让用户改名
        setOpError(await readError(res));
        return;
      }
      setEditing(null);
      notifyFoldersChanged();
    } catch {
      setOpError("网络错误，文件夹未保存");
    } finally {
      editBusyRef.current = false;
    }
  };

  const startCreateRoot = () => {
    setEditing({ mode: "create", parentId: null });
    setEditText("");
  };

  const startCreateChild = (id: string) => {
    setMenu(null);
    // 先展开父级，让输入框可见
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setEditing({ mode: "create", parentId: id });
    setEditText("");
  };

  const startRename = (id: string, name: string) => {
    setMenu(null);
    setEditing({ mode: "rename", id });
    setEditText(name);
  };

  /** 删除：window.confirm 说明内容去向后 DELETE；服务端把子内容上移到父级 */
  const removeFolder = async (id: string, path: string) => {
    setMenu(null);
    const ok = window.confirm(
      `删除文件夹「${path}」？其中的子文件夹与实体将上移到父级（根文件夹的内容变为未归类）。`,
    );
    if (!ok) return;
    setOpError(null);
    try {
      const res = await fetch(`/api/folders/${id}`, { method: "DELETE" });
      if (!res.ok) {
        setOpError(await readError(res));
        return;
      }
      // 被删的正是当前选中的文件夹时清空筛选，避免右侧停留在死过滤器上
      if (selected === id) onSelect(null);
      notifyFoldersChanged();
    } catch {
      setOpError("网络错误，删除失败");
    }
  };

  /** 拖实体到文件夹（或「全部」= 未归类）：单归属整体替换 */
  const assignEntity = async (entityKind: string, entityId: string, folderId: string | null) => {
    setOpError(null);
    try {
      const res = await fetch("/api/folders/assign", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ entityKind, entityId, folderId }),
      });
      if (!res.ok) {
        setOpError(await readError(res));
        return;
      }
      notifyFoldersChanged();
    } catch {
      setOpError("网络错误，归类未保存");
    }
  };

  /** 拖文件夹改层级（parentId null = 拖到根） */
  const moveFolder = async (id: string, parentId: string | null) => {
    setOpError(null);
    try {
      const res = await fetch(`/api/folders/${id}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ parentId }),
      });
      if (!res.ok) {
        setOpError(await readError(res));
        return;
      }
      notifyFoldersChanged();
    } catch {
      setOpError("网络错误，移动失败");
    }
  };

  /* ------------------------------ 拖拽事件 ------------------------------ */

  const onRowDragOver = (e: DragEvent<HTMLElement>, folderId: string | null) => {
    const types = e.dataTransfer.types;
    const hasEntity = types.includes(DND_ENTITY_MIME);
    const hasFolder = types.includes(DND_FOLDER_MIME);
    if (!hasEntity && !hasFolder) return;
    // 拖文件夹到自己/子孙：不接受也不高亮
    if (
      hasFolder &&
      draggingFolderRef.current &&
      folderId !== null &&
      isSelfOrDescendant(draggingFolderRef.current, folderId)
    )
      return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(folderId ?? ALL_DROP_KEY);
  };

  const onRowDragLeave = (e: DragEvent<HTMLElement>, key: string) => {
    // 进入行内子元素也会触发 dragleave，真正离开行才清高亮
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDropTarget((prev) => (prev === key ? null : prev));
  };

  const onRowDrop = async (e: DragEvent<HTMLElement>, folderId: string | null) => {
    e.preventDefault();
    setDropTarget(null);
    const entityRaw = e.dataTransfer.getData(DND_ENTITY_MIME);
    if (entityRaw) {
      try {
        const parsed = JSON.parse(entityRaw) as { kind?: string; id?: string };
        if (typeof parsed?.kind === "string" && typeof parsed?.id === "string")
          await assignEntity(parsed.kind, parsed.id, folderId);
      } catch {
        // payload 非法，忽略
      }
      return;
    }
    const folderRaw = e.dataTransfer.getData(DND_FOLDER_MIME);
    if (!folderRaw) return;
    // 拖到自己/子孙：忽略；父级没变：不发无谓请求
    if (folderId !== null && isSelfOrDescendant(folderRaw, folderId)) return;
    if ((parentById.get(folderRaw) ?? null) === folderId) return;
    await moveFolder(folderRaw, folderId);
  };

  const onFolderDragStart = (e: DragEvent<HTMLElement>, id: string) => {
    e.dataTransfer.setData(DND_FOLDER_MIME, id);
    e.dataTransfer.effectAllowed = "move";
    draggingFolderRef.current = id;
  };

  const onEntityDragStart = (e: DragEvent<HTMLElement>, entity: EntityLeaf) => {
    e.dataTransfer.setData(DND_ENTITY_MIME, JSON.stringify({ kind, id: entity.id }));
    e.dataTransfer.effectAllowed = "move";
  };

  const onDragEnd = () => {
    draggingFolderRef.current = null;
    setDropTarget(null);
  };

  /* ------------------------------- 渲染 ------------------------------- */

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** 行内输入行（新建根/子文件夹用；重命名直接替换行内名字） */
  const editInput = (
    <input
      autoFocus
      value={editText}
      onChange={(e) => setEditText(e.target.value)}
      onKeyDown={(e) => {
        // IME 组词中的 Enter/Esc 属于输入法（确认/取消候选词），不当作提交/取消：
        // Chrome 靠 isComposing 判断；Safari 在 compositionend 后才派发按键、
        // isComposing 已是 false 但 keyCode 恒为 229，一并挡掉。
        // isComposing 不在 React 合成事件类型上，必须经 nativeEvent 取。
        if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        if (e.key === "Enter") void submitEdit();
        else if (e.key === "Escape") setEditing(null);
      }}
      onBlur={() => setEditing(null)}
      placeholder="文件夹名"
      className="min-w-0 flex-1 rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs text-zinc-800 focus:border-zinc-500 focus:outline-none"
    />
  );

  const renderEditRow = (depth: number) => (
    <div
      className="flex items-center gap-2 rounded-md py-1 pr-2"
      style={{ paddingLeft: `${depth * 12 + 4 + 20}px` }}
    >
      <FolderIcon className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
      {editInput}
    </div>
  );

  const renderEntityRow = (entity: EntityLeaf, depth: number) => (
    <div
      key={entity.id}
      className="flex items-center gap-1 rounded-md pr-2 text-sm text-zinc-700 hover:bg-zinc-100"
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
      draggable
      onDragStart={(e) => onEntityDragStart(e, entity)}
      onDragEnd={onDragEnd}
    >
      <span className="h-5 w-5 shrink-0" />
      <button
        type="button"
        onClick={() => onOpenEntity(entity)}
        title={entity.name}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
      >
        <FileIcon className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        <span className="truncate">{entity.name}</span>
      </button>
    </div>
  );

  const renderFolders = (nodes: FolderNode[], depth: number) =>
    nodes.map((node) => {
      const isSelected = selected === node.id;
      const isDrop = dropTarget === node.id;
      const renaming = editing?.mode === "rename" && editing.id === node.id;
      const hasContent = node.children.length > 0 || node.entities.length > 0;
      const isCollapsed = !searching && collapsed.has(node.id);
      const iconCls = `h-3.5 w-3.5 shrink-0 ${isSelected ? "text-zinc-300" : "text-zinc-400"}`;
      return (
        <div key={node.id}>
          <div
            className={`group flex items-center gap-1 rounded-md pr-2 text-sm ${
              isSelected ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-100"
            } ${isDrop ? "ring-1 ring-zinc-500 ring-inset" : ""}`}
            style={{ paddingLeft: `${depth * 12 + 4}px` }}
            draggable={!renaming}
            onDragStart={(e) => onFolderDragStart(e, node.id)}
            onDragEnd={onDragEnd}
            onDragOver={(e) => onRowDragOver(e, node.id)}
            onDragLeave={(e) => onRowDragLeave(e, node.id)}
            onDrop={(e) => void onRowDrop(e, node.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({
                x: e.clientX,
                y: e.clientY,
                id: node.id,
                name: node.name,
                path: node.path,
              });
            }}
          >
            {hasContent ? (
              <button
                type="button"
                onClick={() => toggleCollapse(node.id)}
                aria-label={isCollapsed ? "展开" : "折叠"}
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-xs ${
                  isSelected
                    ? "text-zinc-300 hover:text-white"
                    : "text-zinc-400 hover:text-zinc-700"
                }`}
              >
                {isCollapsed ? "▸" : "▾"}
              </button>
            ) : (
              <span className="h-5 w-5 shrink-0" />
            )}
            {renaming ? (
              <span className="flex min-w-0 flex-1 items-center gap-2 py-1">
                <FolderIcon className={iconCls} />
                {editInput}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onSelect(node.id)}
                title={node.path}
                className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
              >
                <FolderIcon className={iconCls} />
                <span className="truncate">{node.name}</span>
              </button>
            )}
            <span
              className={`shrink-0 text-xs tabular-nums ${
                isSelected ? "text-zinc-300" : "text-zinc-400"
              }`}
            >
              {node.totalCount}
            </span>
          </div>
          {editing?.mode === "create" && editing.parentId === node.id && renderEditRow(depth + 1)}
          {hasContent && !isCollapsed && (
            <div>
              {renderFolders(node.children, depth + 1)}
              {node.entities.map((entity) => renderEntityRow(entity, depth + 1))}
            </div>
          )}
        </div>
      );
    });

  const expandableIds = useMemo(() => collectExpandableIds(roots), [roots]);
  const anyExpandable = expandableIds.length > 0;
  const isEmpty = visibleRoots.length === 0 && visibleRootEntities.length === 0;

  return (
    <div className="flex h-full flex-col rounded-lg border border-zinc-200 bg-white">
      <div className="border-b border-zinc-200 px-3 py-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <span className="text-xs font-medium text-zinc-500">文件夹</span>
            <button
              type="button"
              aria-label="新建根文件夹"
              title="新建根文件夹"
              onClick={startCreateRoot}
              className="flex h-5 w-5 items-center justify-center rounded text-sm leading-none text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            >
              ＋
            </button>
          </div>
          {anyExpandable && (
            <button
              type="button"
              onClick={() =>
                setCollapsed((prev) => (prev.size > 0 ? new Set() : new Set(expandableIds)))
              }
              className="text-xs text-zinc-400 hover:text-zinc-700"
            >
              {collapsed.size > 0 ? "全部展开" : "全部折叠"}
            </button>
          )}
        </div>
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索文件夹或实体…"
          className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs focus:border-zinc-500 focus:outline-none"
        />
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        <button
          type="button"
          onClick={() => onSelect(null)}
          onDragOver={(e) => onRowDragOver(e, null)}
          onDragLeave={(e) => onRowDragLeave(e, ALL_DROP_KEY)}
          onDrop={(e) => void onRowDrop(e, null)}
          className={`mb-1 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm ${
            selected === null ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-100"
          } ${dropTarget === ALL_DROP_KEY ? "ring-1 ring-zinc-500 ring-inset" : ""}`}
        >
          <span>全部</span>
          {selected !== null && <span className="text-xs text-zinc-400">清空筛选</span>}
        </button>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-2 py-2 text-xs text-red-700">
            {error}
            <button
              type="button"
              onClick={() => void load()}
              className="ml-2 underline hover:text-red-900"
            >
              重试
            </button>
          </div>
        )}

        {opError && (
          <div className="mb-1 rounded-md border border-red-200 bg-red-50 px-2 py-2 text-xs text-red-700">
            {opError}
            <button
              type="button"
              onClick={() => setOpError(null)}
              className="ml-2 underline hover:text-red-900"
            >
              知道了
            </button>
          </div>
        )}

        {editing?.mode === "create" && editing.parentId === null && renderEditRow(0)}

        {loading && !data ? (
          <p className="px-2 py-4 text-xs text-zinc-400">加载中…</p>
        ) : isEmpty ? (
          <p className="px-2 py-4 text-xs text-zinc-400">
            {searching ? "没有匹配的文件夹或实体" : "还没有文件夹"}
          </p>
        ) : (
          <>
            {renderFolders(visibleRoots, 0)}
            {visibleRootEntities.map((entity) => renderEntityRow(entity, 0))}
          </>
        )}
      </div>

      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 w-36 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            type="button"
            onClick={() => startCreateChild(menu.id)}
            className="flex w-full items-center px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-50"
          >
            新建子文件夹
          </button>
          <button
            type="button"
            onClick={() => startRename(menu.id, menu.name)}
            className="flex w-full items-center px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-50"
          >
            重命名
          </button>
          <button
            type="button"
            onClick={() => void removeFolder(menu.id, menu.path)}
            className="flex w-full items-center px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50"
          >
            删除文件夹
          </button>
        </div>
      )}
    </div>
  );
}
