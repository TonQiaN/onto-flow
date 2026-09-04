"use client";

/**
 * 对象类型库列表页：左文件夹树 + 顶部搜索/排序/分页（状态同步 URL）+ 卡片列表。
 * 列表数据读 DESIGN-V2 第一节的信封响应 { items, total, page, pageSize }。
 */
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_PAGE_SIZE,
  DND_ENTITY_MIME,
  FolderBadge,
  type FolderDto,
  folderRefFrom,
  FOLDERS_CHANGED_EVENT,
  FolderTree,
  formatTime,
  formatUsedBy,
  KindBadge,
  LibraryLayout,
  LibraryToolbar,
  type ListEnvelope,
  type ObjectTypeRow,
  readError,
  RefCount,
  useLibraryQuery,
  type WithLibraryMeta,
} from "@/components/library";
import { ObjectTypeEditor } from "./object-type-editor";

type ObjectTypeItem = ObjectTypeRow & WithLibraryMeta;

export default function ObjectTypesPage() {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-zinc-400">加载对象类型…</p>}>
      <ObjectTypesLibrary />
    </Suspense>
  );
}

function ObjectTypesLibrary() {
  const { q, folder, sort, page, highlight, setQ, setFolder, setSort, setPage, openEntity } =
    useLibraryQuery();

  const [data, setData] = useState<ListEnvelope<ObjectTypeItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 扁平文件夹清单：仅用于把当前选中的 folder id 还原成 FolderRef，作为新建默认归属 */
  const [folders, setFolders] = useState<FolderDto[]>([]);
  const [editor, setEditor] = useState<
    { mode: "create" } | { mode: "edit"; type: ObjectTypeItem } | null
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
      const res = await fetch(`/api/object-types?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const message = await readError(res);
        if (seq !== loadSeqRef.current) return;
        setLoadError(message);
        setData(null);
        return;
      }
      const envelope = (await res.json()) as ListEnvelope<ObjectTypeItem>;
      if (seq !== loadSeqRef.current) return;
      setData(envelope);
    } catch {
      if (seq !== loadSeqRef.current) return;
      setLoadError("网络错误，无法加载对象类型列表");
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
    if (!highlight || data === null || scrolledRef.current === highlight) return;
    const el = document.getElementById(`entity-${highlight}`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      scrolledRef.current = highlight;
    }
  }, [highlight, data]);

  const items = data?.items ?? [];

  async function remove(type: ObjectTypeItem) {
    if (!window.confirm(`确认删除对象类型「${type.name}」？此操作不可撤销。`)) return;
    setRowError((prev) => ({ ...prev, [type.id]: "" }));
    try {
      const res = await fetch(`/api/object-types/${type.id}`, {
        method: "DELETE",
      });
      if (res.status === 409) {
        const body = (await res.json()) as { error?: string; usedBy?: unknown };
        const detail = formatUsedBy(body.usedBy);
        setRowError((prev) => ({
          ...prev,
          [type.id]: `${body.error ?? "该类型正被引用，无法删除"}${detail ? `。引用方：${detail}` : ""}`,
        }));
        return;
      }
      if (!res.ok) {
        const message = await readError(res);
        setRowError((prev) => ({ ...prev, [type.id]: message }));
        return;
      }
      if (items.length === 1 && page > 1) setPage(page - 1);
      else void load();
    } catch {
      setRowError((prev) => ({ ...prev, [type.id]: "网络错误，删除失败" }));
    }
  }

  const filtering = q !== "" || folder !== null;

  return (
    <>
      <LibraryLayout
        title="对象类型"
        subtitle="端口类型注册表：连线严格同类型才能连。内置 text / file / json 三个通用类型兜底。"
        tree={
          <FolderTree
            kind="object_type"
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
                新建类型
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
              ? "没有符合当前筛选条件的对象类型。"
              : "还没有对象类型，点击右上角「新建类型」创建第一个。"
            : undefined
        }
      >
        <ul className="space-y-3">
          {items.map((type) => (
            <li
              key={type.id}
              id={`entity-${type.id}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  DND_ENTITY_MIME,
                  JSON.stringify({ kind: "object_type", id: type.id }),
                );
                e.dataTransfer.effectAllowed = "move";
              }}
              className={`rounded-lg border bg-white p-4 ${
                highlight === type.id ? "border-zinc-900 ring-1 ring-zinc-900" : "border-zinc-200"
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold text-zinc-900">{type.name}</h2>
                    <KindBadge kind={type.kind} />
                    {type.builtin && (
                      <span className="inline-flex items-center rounded border border-zinc-300 bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600">
                        内置
                      </span>
                    )}
                    {type.kind === "json" && type.jsonSchema && (
                      <span className="inline-flex items-center rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-xs text-zinc-500">
                        含 Schema
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-zinc-500">{type.description || "（无描述）"}</p>
                </div>
                {!type.builtin && (
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => setEditor({ mode: "edit", type })}
                      className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => void remove(type)}
                      className="rounded-md border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50"
                    >
                      删除
                    </button>
                  </div>
                )}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                <FolderBadge folder={type.folder} onEnter={setFolder} />
                <RefCount count={type.refCount} />
                <span className="text-zinc-400">更新于 {formatTime(type.updatedAt)}</span>
              </div>

              {rowError[type.id] && (
                <p className="mt-2 text-xs text-red-600">{rowError[type.id]}</p>
              )}
            </li>
          ))}
        </ul>
      </LibraryLayout>

      {editor && (
        <ObjectTypeEditor
          initial={editor.mode === "edit" ? editor.type : null}
          initialFolder={
            editor.mode === "edit" ? editor.type.folder : folderRefFrom(folders, folder)
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
