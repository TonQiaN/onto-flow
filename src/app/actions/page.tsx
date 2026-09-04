"use client";

/**
 * Action 库列表页：左文件夹树 + 顶部搜索/排序/分页（状态同步 URL）+ 卡片列表。
 * 列表数据读 DESIGN-V2 第一节的信封响应 { items, total, page, pageSize }；
 * 编辑器需要的对象类型 / Skill / Tool 全量清单按页翻完（信封 pageSize 上限 100）。
 */
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { EFFORT_LABEL } from "@/components/canvas/node-model";
import {
  type ActionDto,
  DEFAULT_PAGE_SIZE,
  DND_ENTITY_MIME,
  FolderBadge,
  type FolderDto,
  folderRefFrom,
  FOLDERS_CHANGED_EVENT,
  FolderTree,
  formatTime,
  formatUsedBy,
  KIND_STYLE,
  LibraryLayout,
  LibraryToolbar,
  type ListEnvelope,
  type ModelRow,
  type ObjectTypeRow,
  readError,
  RefCount,
  type SkillRow,
  type ToolRow,
  useLibraryQuery,
  type WithLibraryMeta,
} from "@/components/library";
import { ActionEditor } from "./action-editor";

type ActionItem = ActionDto & WithLibraryMeta;

/** 翻完全部分页，取某个库的完整清单（编辑器的下拉/多选需要全量） */
async function fetchAllItems<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let p = 1; p <= 20; p += 1) {
    const res = await fetch(`${path}?sort=name_asc&page=${p}&pageSize=100`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(await readError(res));
    const envelope = (await res.json()) as ListEnvelope<T>;
    out.push(...envelope.items);
    if (envelope.items.length === 0 || out.length >= envelope.total) break;
  }
  return out;
}

export default function ActionsPage() {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-zinc-400">加载 Action 库…</p>}>
      <ActionsLibrary />
    </Suspense>
  );
}

function ActionsLibrary() {
  const { q, folder, sort, page, highlight, setQ, setFolder, setSort, setPage, openEntity } =
    useLibraryQuery();

  const [data, setData] = useState<ListEnvelope<ActionItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [supportError, setSupportError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [objectTypes, setObjectTypes] = useState<ObjectTypeRow[] | null>(null);
  const [skills, setSkills] = useState<SkillRow[] | null>(null);
  const [tools, setTools] = useState<ToolRow[] | null>(null);
  /** 扁平文件夹清单：仅用于把当前选中的 folder id 还原成 FolderRef，作为新建默认归属 */
  const [folders, setFolders] = useState<FolderDto[]>([]);
  const [editor, setEditor] = useState<
    { mode: "create" } | { mode: "edit"; action: ActionItem } | null
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
      const res = await fetch(`/api/actions?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const message = await readError(res);
        if (seq !== loadSeqRef.current) return;
        setLoadError(message);
        setData(null);
        return;
      }
      const envelope = (await res.json()) as ListEnvelope<ActionItem>;
      if (seq !== loadSeqRef.current) return;
      setData(envelope);
    } catch {
      if (seq !== loadSeqRef.current) return;
      setLoadError("网络错误，无法加载 Action 列表");
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

  /** 编辑器依赖的基础数据，与筛选无关，只在首次与重试时加载 */
  const loadSupport = useCallback(async () => {
    setSupportError(null);
    const [m, ot, s, t] = await Promise.allSettled([
      (async () => {
        const res = await fetch("/api/models", { cache: "no-store" });
        if (!res.ok) throw new Error(await readError(res));
        return (await res.json()) as ModelRow[];
      })(),
      fetchAllItems<ObjectTypeRow>("/api/object-types"),
      fetchAllItems<SkillRow>("/api/skills"),
      fetchAllItems<ToolRow>("/api/tools"),
    ]);
    setModels(m.status === "fulfilled" ? m.value : null);
    setObjectTypes(ot.status === "fulfilled" ? ot.value : null);
    setSkills(s.status === "fulfilled" ? s.value : null);
    setTools(t.status === "fulfilled" ? t.value : null);
    if (
      m.status === "rejected" ||
      ot.status === "rejected" ||
      s.status === "rejected" ||
      t.status === "rejected"
    ) {
      setSupportError("模型 / 对象类型 / Skill / Tool 基础数据加载失败，编辑功能暂不可用");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadSupport();
  }, [loadSupport]);

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
  const editorReady = models !== null && objectTypes !== null && skills !== null && tools !== null;
  const modelById = new Map((models ?? []).map((m) => [m.id, m]));

  async function remove(action: ActionItem) {
    if (!window.confirm(`确认删除 Action「${action.name}」？此操作不可撤销。`)) return;
    setRowError((prev) => ({ ...prev, [action.id]: "" }));
    try {
      const res = await fetch(`/api/actions/${action.id}`, {
        method: "DELETE",
      });
      if (res.status === 409) {
        const body = (await res.json()) as { error?: string; usedBy?: unknown };
        const detail = formatUsedBy(body.usedBy);
        setRowError((prev) => ({
          ...prev,
          [action.id]: `${body.error ?? "该 Action 正被引用，无法删除"}${detail ? `。引用方：${detail}` : ""}`,
        }));
        return;
      }
      if (!res.ok) {
        const message = await readError(res);
        setRowError((prev) => ({ ...prev, [action.id]: message }));
        return;
      }
      if (items.length === 1 && page > 1) setPage(page - 1);
      else void load();
    } catch {
      setRowError((prev) => ({ ...prev, [action.id]: "网络错误，删除失败" }));
    }
  }

  const filtering = q !== "" || folder !== null;

  return (
    <>
      <LibraryLayout
        title="Action 库"
        subtitle="可复用的原子工作单元：Prompt + Rule + 端口 + 模型，外加在所在工作流集合里选出的预载技能与可见 Tool。"
        tree={
          <FolderTree
            kind="action"
            selected={folder}
            onSelect={setFolder}
            onOpenEntity={(e) => openEntity(e.folderId, e.id)}
          />
        }
        toolbar={
          <>
            {supportError && (
              <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                {supportError}
                <button
                  onClick={() => void loadSupport()}
                  className="ml-3 underline hover:text-amber-900"
                >
                  重试
                </button>
              </div>
            )}
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
                  disabled={!editorReady}
                  title={editorReady ? undefined : "基础数据未就绪"}
                  className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
                >
                  新建 Action
                </button>
              }
            />
          </>
        }
        loading={loading && data === null}
        error={loadError}
        onRetry={() => void load()}
        empty={
          !loadError && !loading && items.length === 0
            ? filtering
              ? "没有符合当前筛选条件的 Action。"
              : "还没有 Action，点击右上角「新建 Action」创建第一个。"
            : undefined
        }
      >
        <ul className="space-y-3">
          {items.map((action) => {
            const inputs = action.ports
              .filter((p) => p.direction === "input")
              .sort((a, b) => a.position - b.position);
            const outputs = action.ports
              .filter((p) => p.direction === "output")
              .sort((a, b) => a.position - b.position);
            const model = modelById.get(action.modelId);
            return (
              <li
                key={action.id}
                id={`entity-${action.id}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(
                    DND_ENTITY_MIME,
                    JSON.stringify({ kind: "action", id: action.id }),
                  );
                  e.dataTransfer.effectAllowed = "move";
                }}
                className={`rounded-lg border bg-white p-4 ${
                  highlight === action.id
                    ? "border-zinc-900 ring-1 ring-zinc-900"
                    : "border-zinc-200"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-zinc-900">{action.name}</h2>
                    <p className="mt-1 text-sm text-zinc-500">
                      {action.description || "（无描述）"}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => setEditor({ mode: "edit", action })}
                      disabled={!editorReady}
                      className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => void remove(action)}
                      className="rounded-md border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50"
                    >
                      删除
                    </button>
                  </div>
                </div>

                {/* 端口签名摘要：输入类型 → 输出类型 */}
                <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
                  {inputs.length === 0 ? (
                    <span className="text-zinc-400">无输入</span>
                  ) : (
                    inputs.map((p) => (
                      <span
                        key={p.id}
                        title={`${p.name}（${p.objectTypeName}）`}
                        className={`inline-flex items-center rounded border px-1.5 py-0.5 ${KIND_STYLE[p.kind]}`}
                      >
                        {p.objectTypeName}
                      </span>
                    ))
                  )}
                  <span className="px-1 font-mono text-zinc-400">→</span>
                  {outputs.length === 0 ? (
                    <span className="text-zinc-400">无输出</span>
                  ) : (
                    outputs.map((p) => (
                      <span
                        key={p.id}
                        title={`${p.name}（${p.objectTypeName}）`}
                        className={`inline-flex items-center rounded border px-1.5 py-0.5 ${KIND_STYLE[p.kind]}`}
                      >
                        {p.objectTypeName}
                      </span>
                    ))
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-400">
                  <span>模型：{model ? model.displayName : "（未知模型）"}</span>
                  <span>思考强度：{EFFORT_LABEL[action.reasoningEffort]}</span>
                  <span>预载技能 × {action.preloadSkillIds.length}</span>
                  <span>可见 Tool × {action.toolIds.length}</span>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                  <FolderBadge folder={action.folder} onEnter={setFolder} />
                  <RefCount count={action.refCount} />
                  {/* ActionDto 目前不含 updatedAt（模块 B 的 DTO），补上后此处自动显示 */}
                  {action.updatedAt && (
                    <span className="text-zinc-400">更新于 {formatTime(action.updatedAt)}</span>
                  )}
                </div>

                {rowError[action.id] && (
                  <p className="mt-2 text-xs text-red-600">{rowError[action.id]}</p>
                )}
              </li>
            );
          })}
        </ul>
      </LibraryLayout>

      {editor && models && objectTypes && skills && tools && (
        <ActionEditor
          initial={editor.mode === "edit" ? editor.action : null}
          initialFolder={
            editor.mode === "edit" ? editor.action.folder : folderRefFrom(folders, folder)
          }
          refCount={editor.mode === "edit" ? editor.action.refCount : 0}
          models={models}
          objectTypes={objectTypes}
          skills={skills}
          tools={tools}
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
