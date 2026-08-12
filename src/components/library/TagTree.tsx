"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type EntityKind,
  readError,
  TAGS_CHANGED_EVENT,
  tagColor,
  type TagWithCounts,
} from "./types";

interface TreeNode {
  /** 完整路径（等于真实标签的 name，或仅由子孙拼出的中间前缀） */
  path: string;
  /** 末段名，树上显示的文字 */
  label: string;
  /** 该路径本身是否是一个真实标签 */
  tag: TagWithCounts | null;
  children: TreeNode[];
  /** 自身标签在本库下的挂载数 */
  ownCount: number;
  /** 自身 + 全部子孙的挂载数合计 */
  totalCount: number;
  /** 自身 + 全部子孙的 tag id（点父节点即选中这一串） */
  tagIds: string[];
}

function buildTree(tags: TagWithCounts[], kind: EntityKind): TreeNode[] {
  const byPath = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  const ensure = (path: string, label: string, parent: TreeNode | null) => {
    let node = byPath.get(path);
    if (!node) {
      node = {
        path,
        label,
        tag: null,
        children: [],
        ownCount: 0,
        totalCount: 0,
        tagIds: [],
      };
      byPath.set(path, node);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return node;
  };

  for (const tag of tags) {
    const segments = tag.name
      .split("/")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    let parent: TreeNode | null = null;
    let path = "";
    for (const segment of segments) {
      path = path ? `${path}/${segment}` : segment;
      parent = ensure(path, segment, parent);
    }
    if (parent) {
      parent.tag = tag;
      parent.ownCount = tag.counts?.[kind] ?? 0;
    }
  }

  const finish = (node: TreeNode): void => {
    node.children.sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
    node.totalCount = node.ownCount;
    node.tagIds = node.tag ? [node.tag.id] : [];
    for (const child of node.children) {
      finish(child);
      node.totalCount += child.totalCount;
      node.tagIds.push(...child.tagIds);
    }
  };
  roots.sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
  for (const root of roots) finish(root);
  return roots;
}

/** 按关键词剪枝：命中节点自身，或其任意子孙命中，则保留 */
function pruneTree(nodes: TreeNode[], keyword: string): TreeNode[] {
  const lower = keyword.toLowerCase();
  const walk = (node: TreeNode): TreeNode | null => {
    const children = node.children
      .map(walk)
      .filter((n): n is TreeNode => n !== null);
    const hit = node.path.toLowerCase().includes(lower);
    if (!hit && children.length === 0) return null;
    return { ...node, children: hit ? node.children : children };
  };
  return nodes.map(walk).filter((n): n is TreeNode => n !== null);
}

function collectPaths(nodes: TreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    out.push(node.path);
    collectPaths(node.children, out);
  }
  return out;
}

/**
 * 层级标签树（列表页左栏）。tags 扁平列表按 `/` 构建树；
 * 点击节点切换选中（多选，服务端 AND 过滤）；父节点选中时把全部子孙标签一并加入 selected。
 */
export function TagTree({
  kind,
  selected,
  onChange,
}: {
  kind: EntityKind;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [tags, setTags] = useState<TagWithCounts[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tags?kind=${encodeURIComponent(kind)}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const data = (await res.json()) as TagWithCounts[];
      setTags(Array.isArray(data) ? data : []);
    } catch {
      setError("网络错误，无法加载标签");
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const handler = () => void load();
    window.addEventListener(TAGS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(TAGS_CHANGED_EVENT, handler);
  }, [load]);

  const tree = useMemo(() => buildTree(tags ?? [], kind), [tags, kind]);
  const searching = keyword.trim().length > 0;
  const visible = useMemo(
    () => (searching ? pruneTree(tree, keyword.trim()) : tree),
    [tree, keyword, searching],
  );

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const toggleNode = (node: TreeNode) => {
    if (node.tagIds.length === 0) return;
    const all = node.tagIds.every((id) => selectedSet.has(id));
    if (all) {
      const drop = new Set(node.tagIds);
      onChange(selected.filter((id) => !drop.has(id)));
    } else {
      const next = new Set(selected);
      for (const id of node.tagIds) next.add(id);
      onChange([...next]);
    }
  };

  const toggleCollapse = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderNodes = (nodes: TreeNode[], depth: number) =>
    nodes.map((node) => {
      const isCollapsed = !searching && collapsed.has(node.path);
      const all =
        node.tagIds.length > 0 &&
        node.tagIds.every((id) => selectedSet.has(id));
      const some = !all && node.tagIds.some((id) => selectedSet.has(id));
      return (
        <div key={node.path}>
          <div
            className={`group flex items-center gap-1 rounded-md pr-2 text-sm ${
              all
                ? "bg-zinc-900 text-white"
                : some
                  ? "bg-zinc-100 text-zinc-900"
                  : "text-zinc-700 hover:bg-zinc-100"
            }`}
            style={{ paddingLeft: `${depth * 12 + 4}px` }}
          >
            {node.children.length > 0 ? (
              <button
                type="button"
                onClick={() => toggleCollapse(node.path)}
                aria-label={isCollapsed ? "展开" : "折叠"}
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-xs ${
                  all ? "text-zinc-300 hover:text-white" : "text-zinc-400 hover:text-zinc-700"
                }`}
              >
                {isCollapsed ? "▸" : "▾"}
              </button>
            ) : (
              <span className="h-5 w-5 shrink-0" />
            )}
            <button
              type="button"
              onClick={() => toggleNode(node)}
              title={node.path}
              className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{
                  backgroundColor: tagColor(node.tag ?? { name: node.path }),
                }}
              />
              <span className="truncate">{node.label}</span>
            </button>
            <span
              className={`shrink-0 text-xs tabular-nums ${
                all ? "text-zinc-300" : "text-zinc-400"
              }`}
            >
              {node.totalCount}
            </span>
          </div>
          {node.children.length > 0 && !isCollapsed && (
            <div>{renderNodes(node.children, depth + 1)}</div>
          )}
        </div>
      );
    });

  const allPaths = useMemo(() => collectPaths(tree), [tree]);
  const anyExpandable = tree.some((n) => n.children.length > 0);

  return (
    <div className="flex h-full flex-col rounded-lg border border-zinc-200 bg-white">
      <div className="border-b border-zinc-200 px-3 py-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-zinc-500">标签</span>
          {anyExpandable && (
            <button
              type="button"
              onClick={() =>
                setCollapsed((prev) =>
                  prev.size > 0 ? new Set() : new Set(allPaths),
                )
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
          placeholder="搜索标签…"
          className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs focus:border-zinc-500 focus:outline-none"
        />
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        <button
          type="button"
          onClick={() => onChange([])}
          className={`mb-1 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm ${
            selected.length === 0
              ? "bg-zinc-900 text-white"
              : "text-zinc-700 hover:bg-zinc-100"
          }`}
        >
          <span>全部</span>
          {selected.length > 0 && (
            <span className="text-xs text-zinc-400">清空筛选</span>
          )}
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

        {loading && !tags ? (
          <p className="px-2 py-4 text-xs text-zinc-400">加载中…</p>
        ) : visible.length === 0 ? (
          <p className="px-2 py-4 text-xs text-zinc-400">
            {searching ? "没有匹配的标签" : "还没有标签"}
          </p>
        ) : (
          renderNodes(visible, 0)
        )}
      </div>
    </div>
  );
}
