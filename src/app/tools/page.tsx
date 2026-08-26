"use client";

/**
 * Tool 库列表页：左文件夹树 + 顶部搜索/排序/分页（状态同步 URL）+ 卡片列表。
 * 列表数据读 DESIGN-V2 第一节的信封响应 { items, total, page, pageSize }。
 */
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_PAGE_SIZE,
  DND_ENTITY_MIME,
  type FolderDto,
  type FolderRef,
  FOLDERS_CHANGED_EVENT,
  FolderTree,
  formatTime,
  LibraryLayout,
  LibraryToolbar,
  type ListEnvelope,
  readError,
  useLibraryQuery,
  type WithLibraryMeta,
} from "@/components/library";
import { ToolEditor, type ToolRow } from "./tool-editor";

type ToolItem = ToolRow & WithLibraryMeta;

function formatUsedBy(usedBy: unknown): string {
  if (Array.isArray(usedBy)) {
    return usedBy
      .map((u) => {
        if (typeof u === "string") return u;
        if (u && typeof u === "object" && "name" in u)
          return String((u as { name: unknown }).name);
        return JSON.stringify(u);
      })
      .join("、");
  }
  return usedBy == null ? "" : JSON.stringify(usedBy);
}

/** 从扁平文件夹清单还原带完整路径的 FolderRef（新建默认归属用）；拿不到时返回 null */
function folderRefFrom(
  folders: FolderDto[],
  id: string | null,
): FolderRef | null {
  if (!id) return null;
  const byId = new Map(folders.map((f) => [f.id, f]));
  const target = byId.get(id);
  if (!target) return null;
  const names: string[] = [];
  for (
    let cur: FolderDto | undefined = target;
    cur;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  ) {
    names.unshift(cur.name);
  }
  return { id: target.id, name: target.name, path: names.join("/") };
}

export default function ToolsPage() {
  return (
    <Suspense
      fallback={<p className="p-8 text-sm text-zinc-400">加载 Tool 库…</p>}
    >
      <ToolsLibrary />
    </Suspense>
  );
}

function ToolsLibrary() {
  const {
    q,
    folder,
    sort,
    page,
    highlight,
    setQ,
    setFolder,
    setSort,
    setPage,
    openEntity,
  } = useLibraryQuery();

  const [data, setData] = useState<ListEnvelope<ToolItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 扁平文件夹清单：仅用于把当前选中的 folder id 还原成 FolderRef，作为新建默认归属 */
  const [folders, setFolders] = useState<FolderDto[]>([]);
  const [editor, setEditor] = useState<
    { mode: "create" } | { mode: "edit"; tool: ToolItem } | null
  >(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  /** 请求序号守卫：只有最新一次 load 的结果才允许落地，防止旧响应后返覆盖新结果 */
  const loadSeqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setLoadError(null);
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (folder) params.set("folder", folder);
    // 树上点实体叶子定位：让服务端反查该实体所在页并覆盖 page（信封返回生效页码）
    if (highlight) params.set("locate", highlight);
    params.set("sort", sort);
    params.set("page", String(page));
    try {
      const res = await fetch(`/api/tools?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const message = await readError(res);
        if (seq !== loadSeqRef.current) return;
        setLoadError(message);
        setData(null);
        return;
      }
      const envelope = (await res.json()) as ListEnvelope<ToolItem>;
      if (seq !== loadSeqRef.current) return;
      setData(envelope);
    } catch {
      if (seq !== loadSeqRef.current) return;
      setLoadError("网络错误，无法加载 Tool 列表");
      setData(null);
    } finally {
      // 过期请求不许把新请求的 loading 提前关掉
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [q, folder, sort, page, highlight]);

  const loadFolders = useCallback(async () => {
    try {
      const res = await fetch("/api/folders", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { folders?: FolderDto[] };
      setFolders(body.folders ?? []);
    } catch {
      // 拿不到就退化为新建时不带默认文件夹
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

  // 文件夹结构或实体归属变化时重载：卡片上的文件夹徽章、新建默认归属都要跟着变
  useEffect(() => {
    const handler = () => {
      void load();
      void loadFolders();
    };
    window.addEventListener(FOLDERS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(FOLDERS_CHANGED_EVENT, handler);
  }, [load, loadFolders]);

  // highlight 定位：列表加载后把高亮卡片滚到视口中央（每个目标只滚一次）
  const scrolledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!highlight || data === null || scrolledRef.current === highlight)
      return;
    const el = document.getElementById(`entity-${highlight}`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      scrolledRef.current = highlight;
    }
  }, [highlight, data]);

  const items = data?.items ?? [];

  async function remove(tool: ToolItem) {
    if (!window.confirm(`确认删除 Tool「${tool.name}」？此操作不可撤销。`))
      return;
    setRowError((prev) => ({ ...prev, [tool.id]: "" }));
    try {
      const res = await fetch(`/api/tools/${tool.id}`, { method: "DELETE" });
      if (res.status === 409) {
        const body = (await res.json()) as { error?: string; usedBy?: unknown };
        const detail = formatUsedBy(body.usedBy);
        setRowError((prev) => ({
          ...prev,
          [tool.id]: `${body.error ?? "该 Tool 正被引用，无法删除"}${detail ? `。引用方：${detail}` : ""}`,
        }));
        return;
      }
      if (!res.ok) {
        const message = await readError(res);
        setRowError((prev) => ({ ...prev, [tool.id]: message }));
        return;
      }
      if (items.length === 1 && page > 1) setPage(page - 1);
      else void load();
    } catch {
      setRowError((prev) => ({ ...prev, [tool.id]: "网络错误，删除失败" }));
    }
  }

  const filtering = q !== "" || folder !== null;

  return (
    <>
      <LibraryLayout
        title="Tool 库"
        subtitle="cordis 插件源码，被引用后物化进运行目录并注册到工具面，供模型调用。"
        tree={
          <FolderTree
            kind="tool"
            selected={folder}
            onSelect={setFolder}
            onOpenEntity={(e) => openEntity(e.folderId, e.id)}
          />
        }
        toolbar={
          <LibraryToolbar
            q={q}
            onQChange={setQ}
            sort={sort}
            onSortChange={setSort}
            total={data?.total ?? 0}
            page={data?.page ?? page}
            pageSize={data?.pageSize ?? DEFAULT_PAGE_SIZE}
            onPageChange={setPage}
            right={
              <button
                type="button"
                onClick={() => setEditor({ mode: "create" })}
                className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white transition-colors hover:bg-zinc-700"
              >
                新建 Tool
              </button>
            }
          />
        }
        loading={loading && data === null}
        error={loadError}
        onRetry={() => void load()}
        empty={
          !loadError && !loading && items.length === 0
            ? filtering
              ? "没有符合当前筛选条件的 Tool。"
              : "还没有 Tool，点击右上角「新建 Tool」创建第一个。"
            : undefined
        }
      >
        <ul className="space-y-3">
          {items.map((tool) => (
            <li
              key={tool.id}
              id={`entity-${tool.id}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  DND_ENTITY_MIME,
                  JSON.stringify({ kind: "tool", id: tool.id }),
                );
                e.dataTransfer.effectAllowed = "move";
              }}
              className={`rounded-lg border bg-white p-4 ${
                highlight === tool.id
                  ? "border-zinc-900 ring-1 ring-zinc-900"
                  : "border-zinc-200"
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="font-mono text-sm font-semibold text-zinc-900">
                    {tool.name}
                  </h2>
                  <p className="mt-1 text-sm text-zinc-500">
                    {tool.description || "（无描述）"}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => setEditor({ mode: "edit", tool })}
                    className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => void remove(tool)}
                    className="rounded-md border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50"
                  >
                    删除
                  </button>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                <FolderBadge folder={tool.folder} onEnter={setFolder} />
                <RefCount count={tool.refCount} />
                <span className="text-zinc-400">
                  更新于 {formatTime(tool.updatedAt)}
                </span>
              </div>

              {rowError[tool.id] && (
                <p className="mt-2 text-xs text-red-600">{rowError[tool.id]}</p>
              )}
            </li>
          ))}
        </ul>
      </LibraryLayout>

      {editor && (
        <ToolEditor
          initial={editor.mode === "edit" ? editor.tool : null}
          initialFolder={
            editor.mode === "edit"
              ? editor.tool.folder
              : folderRefFrom(folders, folder)
          }
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            void load();
          }}
          onRefresh={() => void load()}
        />
      )}
    </>
  );
}

/** 文件夹徽章，点击即进入该文件夹（列表改按其子树过滤）；未归类不显示 */
function FolderBadge({
  folder,
  onEnter,
}: {
  folder: FolderRef | null;
  onEnter: (id: string) => void;
}) {
  if (!folder) return null;
  return (
    <button
      type="button"
      title={`进入文件夹「${folder.path}」`}
      onClick={() => onEnter(folder.id)}
      className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2 py-0.5 text-[11px] text-zinc-600 hover:border-zinc-400 hover:text-zinc-900"
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="h-3 w-3 shrink-0 text-zinc-400"
        aria-hidden
      >
        <path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h2.9c.4 0 .78.16 1.06.44l.86.86h4.68c.83 0 1.5.67 1.5 1.5v6.2c0 .83-.67 1.5-1.5 1.5H3.25c-.83 0-1.5-.67-1.5-1.5v-7.5Z" />
      </svg>
      {folder.path}
    </button>
  );
}

/** 引用计数：0 时弱化显示 */
function RefCount({ count }: { count: number }) {
  return count > 0 ? (
    <span className="text-zinc-500">{count} 处引用</span>
  ) : (
    <span className="text-zinc-300">未被引用</span>
  );
}
