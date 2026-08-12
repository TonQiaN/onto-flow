"use client";

/**
 * Skill 库列表页：左标签树 + 顶部搜索/排序/分页（状态同步 URL）+ 卡片列表。
 * 列表数据读 DESIGN-V2 第一节的信封响应 { items, total, page, pageSize }。
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
import { SkillEditor, type SkillRow } from "./skill-editor";

type SkillItem = SkillRow & WithLibraryMeta;

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

export default function SkillsPage() {
  return (
    <Suspense
      fallback={<p className="p-8 text-sm text-zinc-400">加载 Skill 库…</p>}
    >
      <SkillsLibrary />
    </Suspense>
  );
}

function SkillsLibrary() {
  const { q, tags, sort, page, setQ, setTags, setSort, setPage } =
    useLibraryQuery();
  const highlight = useSearchParams().get("highlight");

  const [data, setData] = useState<ListEnvelope<SkillItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editor, setEditor] = useState<
    { mode: "create" } | { mode: "edit"; skill: SkillItem } | null
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
      const res = await fetch(`/api/skills?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setLoadError(await readError(res));
        setData(null);
        return;
      }
      setData((await res.json()) as ListEnvelope<SkillItem>);
    } catch {
      setLoadError("网络错误，无法加载 Skill 列表");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [q, tags, sort, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = data?.items ?? [];

  async function remove(skill: SkillItem) {
    if (!window.confirm(`确认删除 Skill「${skill.name}」？此操作不可撤销。`))
      return;
    setRowError((prev) => ({ ...prev, [skill.id]: "" }));
    try {
      const res = await fetch(`/api/skills/${skill.id}`, { method: "DELETE" });
      if (res.status === 409) {
        const body = (await res.json()) as { error?: string; usedBy?: unknown };
        const detail = formatUsedBy(body.usedBy);
        setRowError((prev) => ({
          ...prev,
          [skill.id]: `${body.error ?? "该 Skill 正被引用，无法删除"}${detail ? `。引用方：${detail}` : ""}`,
        }));
        return;
      }
      if (!res.ok) {
        const message = await readError(res);
        setRowError((prev) => ({ ...prev, [skill.id]: message }));
        return;
      }
      // 删掉本页最后一条时退回上一页，避免停在空页
      if (items.length === 1 && page > 1) setPage(page - 1);
      else void load();
    } catch {
      setRowError((prev) => ({ ...prev, [skill.id]: "网络错误，删除失败" }));
    }
  }

  const filtering = q !== "" || tags.length > 0;

  return (
    <>
      <LibraryLayout
        title="Skill 库"
        subtitle="命名 prompt 片段，被 Action 引用后在执行时强制注入会话。"
        tree={<TagTree kind="skill" selected={tags} onChange={setTags} />}
        toolbar={
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
                className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white transition-colors hover:bg-zinc-700"
              >
                新建 Skill
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
              ? "没有符合当前筛选条件的 Skill。"
              : "还没有 Skill，点击右上角「新建 Skill」创建第一个。"
            : undefined
        }
      >
        <ul className="space-y-3">
          {items.map((skill) => (
            <li
              key={skill.id}
              className={`rounded-lg border bg-white p-4 ${
                highlight === skill.id
                  ? "border-zinc-900 ring-1 ring-zinc-900"
                  : "border-zinc-200"
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-zinc-900">
                    {skill.name}
                  </h2>
                  <p className="mt-1 text-sm text-zinc-500">
                    {skill.description || "（无描述）"}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => setEditor({ mode: "edit", skill })}
                    className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => void remove(skill)}
                    className="rounded-md border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50"
                  >
                    删除
                  </button>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                <TagBadges tags={skill.tags} onPick={(id) => setTags([id])} />
                <RefCount count={skill.refCount} />
                <span className="text-zinc-400">
                  更新于 {formatTime(skill.updatedAt)}
                </span>
              </div>

              {rowError[skill.id] && (
                <p className="mt-2 text-xs text-red-600">{rowError[skill.id]}</p>
              )}
            </li>
          ))}
        </ul>
      </LibraryLayout>

      {editor && (
        <SkillEditor
          initial={editor.mode === "edit" ? editor.skill : null}
          initialTags={editor.mode === "edit" ? editor.skill.tags : []}
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
