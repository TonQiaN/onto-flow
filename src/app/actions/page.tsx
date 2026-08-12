"use client";

/**
 * Action 库列表页：左标签树 + 顶部搜索/排序/分页（状态同步 URL）+ 卡片列表。
 * 列表数据读 DESIGN-V2 第一节的信封响应 { items, total, page, pageSize }；
 * 编辑器需要的对象类型 / Skill / Tool 全量清单按页翻完（信封 pageSize 上限 100）。
 */
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import {
  DEFAULT_PAGE_SIZE,
  formatTime,
  LibraryLayout,
  LibraryToolbar,
  type ListEnvelope,
  readError,
  type Tag,
  tagColor,
  tagLeafName,
  TagTree,
  useLibraryQuery,
  type WithLibraryMeta,
} from "@/components/library";
import { ActionEditor } from "./action-editor";
import {
  type ActionDto,
  EFFORT_LABEL,
  formatUsedBy,
  KIND_STYLE,
  type ModelRow,
  type ObjectTypeRow,
  type SkillRow,
  type ToolRow,
} from "./shared";

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
    <Suspense
      fallback={<p className="p-8 text-sm text-zinc-400">加载 Action 库…</p>}
    >
      <ActionsLibrary />
    </Suspense>
  );
}

function ActionsLibrary() {
  const { q, tags, sort, page, setQ, setTags, setSort, setPage } =
    useLibraryQuery();
  const highlight = useSearchParams().get("highlight");

  const [data, setData] = useState<ListEnvelope<ActionItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [supportError, setSupportError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [objectTypes, setObjectTypes] = useState<ObjectTypeRow[] | null>(null);
  const [skills, setSkills] = useState<SkillRow[] | null>(null);
  const [tools, setTools] = useState<ToolRow[] | null>(null);
  const [editor, setEditor] = useState<
    { mode: "create" } | { mode: "edit"; action: ActionItem } | null
  >(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (tags.length > 0) params.set("tags", tags.join(","));
    params.set("sort", sort);
    params.set("page", String(page));
    try {
      const res = await fetch(`/api/actions?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setLoadError(await readError(res));
        setData(null);
        return;
      }
      setData((await res.json()) as ListEnvelope<ActionItem>);
    } catch {
      setLoadError("网络错误，无法加载 Action 列表");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [q, tags, sort, page]);

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
      setSupportError(
        "模型 / 对象类型 / Skill / Tool 基础数据加载失败，编辑功能暂不可用",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadSupport();
  }, [loadSupport]);

  const items = data?.items ?? [];
  const editorReady =
    models !== null && objectTypes !== null && skills !== null && tools !== null;
  const modelById = new Map((models ?? []).map((m) => [m.id, m]));

  async function remove(action: ActionItem) {
    if (!window.confirm(`确认删除 Action「${action.name}」？此操作不可撤销。`))
      return;
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

  const filtering = q !== "" || tags.length > 0;

  return (
    <>
      <LibraryLayout
        title="Action 库"
        subtitle="可复用的原子工作单元：Prompt + Rule + 端口 + 模型 + 引用的 Skill / Tool。"
        tree={<TagTree kind="action" selected={tags} onChange={setTags} />}
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
              page={page}
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
                className={`rounded-lg border bg-white p-4 ${
                  highlight === action.id
                    ? "border-zinc-900 ring-1 ring-zinc-900"
                    : "border-zinc-200"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-zinc-900">
                      {action.name}
                    </h2>
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
                  <span>Skill × {action.skillIds.length}</span>
                  <span>Tool × {action.toolIds.length}</span>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                  <TagBadges tags={action.tags} onPick={(id) => setTags([id])} />
                  <RefCount count={action.refCount} />
                  {/* ActionDto 目前不含 updatedAt（模块 B 的 DTO），补上后此处自动显示 */}
                  {action.updatedAt && (
                    <span className="text-zinc-400">
                      更新于 {formatTime(action.updatedAt)}
                    </span>
                  )}
                </div>

                {rowError[action.id] && (
                  <p className="mt-2 text-xs text-red-600">
                    {rowError[action.id]}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </LibraryLayout>

      {editor && models && objectTypes && skills && tools && (
        <ActionEditor
          initial={editor.mode === "edit" ? editor.action : null}
          initialTags={editor.mode === "edit" ? editor.action.tags : []}
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

/** 标签徽章，点击即按该标签筛选列表 */
function TagBadges({
  tags,
  onPick,
}: {
  tags: Tag[];
  onPick: (id: string) => void;
}) {
  if (tags.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {tags.map((tag) => (
        <button
          key={tag.id}
          type="button"
          title={`按标签「${tag.name}」筛选`}
          onClick={() => onPick(tag.id)}
          className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2 py-0.5 text-[11px] text-zinc-600 hover:border-zinc-400 hover:text-zinc-900"
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: tagColor(tag) }}
          />
          {tagLeafName(tag.name)}
        </button>
      ))}
    </span>
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
