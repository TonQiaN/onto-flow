"use client";

/**
 * 工作流列表页：顶部搜索/排序/分页（状态同步 URL）+ 卡片网格。
 * 工作流不参与文件夹分类（ADR-0005），所以没有左侧文件夹树。
 * 列表数据读 DESIGN-V2 第一节的信封响应 { items, total, page, pageSize }。
 * 工作流是顶层实体（refCount 恒为 0），卡片不显示引用计数，改显示节点数。
 * 卡片点开进画布；「信息」抽屉里改名称/描述、看被引用与修订历史。
 */
import { useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import {
  DEFAULT_PAGE_SIZE,
  formatTime,
  LibraryLayout,
  LibraryToolbar,
  type ListEnvelope,
  readError,
  ReferencesPanel,
  RevisionPanel,
  useLibraryQuery,
  type WithLibraryMeta,
} from "@/components/library";

interface WorkflowRow {
  id: string;
  name: string;
  description: string;
  nodeCount: number;
  updatedAt: string;
}

// 列表 API 返回的 folder 字段对工作流恒为 null，此处直接忽略
type WorkflowItem = WorkflowRow & WithLibraryMeta;

export default function WorkflowsPage() {
  return (
    <Suspense
      fallback={<p className="p-8 text-sm text-zinc-400">加载工作流…</p>}
    >
      <WorkflowsLibrary />
    </Suspense>
  );
}

function WorkflowsLibrary() {
  const router = useRouter();
  const { q, sort, page, highlight, setQ, setSort, setPage } =
    useLibraryQuery();

  const [data, setData] = useState<ListEnvelope<WorkflowItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [detail, setDetail] = useState<WorkflowItem | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  /** 有进行中运行的工作流 id 集合（卡片「运行中」徽标；点卡片进画布会自动重连动画） */
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    params.set("sort", sort);
    params.set("page", String(page));
    try {
      const res = await fetch(`/api/workflows?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setLoadError(await readError(res));
        setData(null);
        return;
      }
      setData((await res.json()) as ListEnvelope<WorkflowItem>);
    } catch {
      setLoadError("网络错误，无法加载工作流列表");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [q, sort, page]);

  /** 与列表同步刷新的运行中标记；失败静默（徽标缺失不影响列表本身） */
  const loadRunning = useCallback(async () => {
    try {
      const res = await fetch("/api/runs?status=running", { cache: "no-store" });
      if (!res.ok) return;
      const rows = (await res.json()) as Array<{ workflowId?: string }>;
      setRunningIds(
        new Set(
          (Array.isArray(rows) ? rows : [])
            .map((r) => r.workflowId)
            .filter((id): id is string => typeof id === "string"),
        ),
      );
    } catch {
      // 静默
    }
  }, []);

  useEffect(() => {
    void load();
    void loadRunning();
  }, [load, loadRunning]);

  const items = data?.items ?? [];

  async function create() {
    const name = createName.trim();
    if (!name || createBusy) return;
    setCreateBusy(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: "" }),
      });
      if (!res.ok) {
        setLoadError(await readError(res));
        return;
      }
      const created = (await res.json()) as { id?: string };
      if (!created?.id) {
        setLoadError("创建失败：服务端未返回工作流 id");
        return;
      }
      router.push(`/workflows/${created.id}`);
    } catch {
      setLoadError("网络错误，创建失败");
    } finally {
      setCreateBusy(false);
    }
  }

  async function remove(workflow: WorkflowItem) {
    if (!window.confirm(`确认删除工作流「${workflow.name}」？该操作不可恢复。`))
      return;
    setRowError((prev) => ({ ...prev, [workflow.id]: "" }));
    try {
      const res = await fetch(`/api/workflows/${workflow.id}`, {
        method: "DELETE",
      });
      if (res.status === 409) {
        const body = (await res.json()) as { error?: string; usedBy?: unknown };
        const detailText = Array.isArray(body.usedBy)
          ? body.usedBy
              .map((u) =>
                u && typeof u === "object" && "name" in u
                  ? String((u as { name: unknown }).name)
                  : String(u),
              )
              .join("、")
          : "";
        setRowError((prev) => ({
          ...prev,
          [workflow.id]: `${body.error ?? "该工作流正被引用，无法删除"}${detailText ? `。引用方：${detailText}` : ""}`,
        }));
        return;
      }
      if (!res.ok) {
        const message = await readError(res);
        setRowError((prev) => ({ ...prev, [workflow.id]: message }));
        return;
      }
      if (items.length === 1 && page > 1) setPage(page - 1);
      else void load();
    } catch {
      setRowError((prev) => ({ ...prev, [workflow.id]: "网络错误，删除失败" }));
    }
  }

  const filtering = q !== "";

  return (
    <>
      <LibraryLayout
        title="工作流"
        subtitle="编排 Action 的 DAG，点击卡片进入画布编辑器。"
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
                onClick={() => {
                  setCreateName("");
                  setCreating(true);
                }}
                className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white transition-colors hover:bg-zinc-700"
              >
                ＋ 新建工作流
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
              ? "没有符合当前筛选条件的工作流。"
              : "还没有工作流，点击右上角「新建工作流」开始。"
            : undefined
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((workflow) => (
            <div
              key={workflow.id}
              onClick={() => router.push(`/workflows/${workflow.id}`)}
              className={`cursor-pointer rounded-lg border bg-white p-4 shadow-sm transition-colors hover:border-zinc-400 ${
                highlight === workflow.id
                  ? "border-zinc-900 ring-1 ring-zinc-900"
                  : "border-zinc-200"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="min-w-0 truncate text-sm font-semibold text-zinc-900">
                  {workflow.name}
                </h2>
                {runningIds.has(workflow.id) && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-600">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                    运行中
                  </span>
                )}
                <div
                  className="flex shrink-0 gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    onClick={() => setDetail(workflow)}
                    className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
                  >
                    信息
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(workflow)}
                    className="rounded px-1.5 py-0.5 text-xs text-red-500 hover:bg-red-50 hover:text-red-700"
                  >
                    删除
                  </button>
                </div>
              </div>

              <p className="mt-1 line-clamp-2 min-h-[1.25rem] text-xs text-zinc-500">
                {workflow.description || "（无描述）"}
              </p>

              <div className="mt-3 flex items-center justify-between text-[11px] text-zinc-400">
                <span>节点数：{workflow.nodeCount}</span>
                <span>更新于 {formatTime(workflow.updatedAt)}</span>
              </div>

              {rowError[workflow.id] && (
                <p className="mt-2 text-xs text-red-600">
                  {rowError[workflow.id]}
                </p>
              )}
            </div>
          ))}
        </div>
      </LibraryLayout>

      {creating && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => {
            if (!createBusy) setCreating(false);
          }}
        >
          <div
            className="w-96 rounded-lg border border-zinc-200 bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-zinc-900">
              新建工作流
            </h2>
            <input
              autoFocus
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void create();
              }}
              placeholder="工作流名称"
              className="mt-3 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreating(false)}
                disabled={createBusy}
                className="rounded-md border border-zinc-300 bg-white px-3.5 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void create()}
                disabled={createBusy || !createName.trim()}
                className="rounded-md bg-zinc-900 px-3.5 py-1.5 text-sm text-white hover:bg-zinc-700 disabled:opacity-50"
              >
                {createBusy ? "处理中…" : "确定"}
              </button>
            </div>
          </div>
        </div>
      )}

      {detail && (
        <WorkflowDrawer
          workflow={detail}
          onClose={() => setDetail(null)}
          onSaved={() => {
            setDetail(null);
            void load();
          }}
          onRefresh={() => void load()}
        />
      )}
    </>
  );
}

type TabKey = "basic" | "refs" | "revisions";

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: "basic", label: "基本信息" },
  { key: "refs", label: "被引用" },
  { key: "revisions", label: "修订历史" },
];

/**
 * 工作流信息抽屉。名称/描述保存走「GET 整图 → PUT 整图透传 + 新名称」，
 * 以满足 PUT 为整图替换的契约（画布结构本身仍在 /workflows/[id] 里编辑）。
 */
function WorkflowDrawer({
  workflow,
  onClose,
  onSaved,
  onRefresh,
}: {
  workflow: WorkflowItem;
  onClose: () => void;
  onSaved: () => void;
  onRefresh: () => void;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>("basic");
  const [name, setName] = useState(workflow.name);
  const [description, setDescription] = useState(workflow.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reloadFromServer = useCallback(async () => {
    try {
      const res = await fetch(`/api/workflows/${workflow.id}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const body = (await res.json()) as {
        workflow?: { name?: string; description?: string };
      };
      if (body.workflow?.name !== undefined) setName(body.workflow.name);
      if (body.workflow?.description !== undefined)
        setDescription(body.workflow.description);
    } catch {
      // 拉取失败保持当前表单
    }
  }, [workflow.id]);

  async function save() {
    if (!name.trim()) {
      setError("名称不能为空");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const detailRes = await fetch(`/api/workflows/${workflow.id}`, {
        cache: "no-store",
      });
      if (!detailRes.ok) {
        setError(await readError(detailRes));
        return;
      }
      const detail = (await detailRes.json()) as {
        nodes?: unknown[];
        edges?: unknown[];
      };
      const res = await fetch(`/api/workflows/${workflow.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description,
          nodes: detail.nodes ?? [],
          edges: detail.edges ?? [],
        }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      onSaved();
    } catch {
      setError("网络错误，保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/30"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-xl flex-col bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
          <h2 className="text-base font-semibold text-zinc-900">工作流信息</h2>
          <button
            onClick={onClose}
            className="text-sm text-zinc-400 hover:text-zinc-600"
          >
            关闭
          </button>
        </div>

        <div className="flex gap-1 border-b border-zinc-200 px-6">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                tab === t.key
                  ? "border-zinc-900 text-zinc-900"
                  : "border-transparent text-zinc-500 hover:text-zinc-800"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          {tab === "basic" && (
            <>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  名称
                </span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  描述
                </span>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="一句话说明这个工作流做什么"
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
                />
              </label>
              <p className="text-xs text-zinc-400">
                节点与连线在画布里编辑：
                <button
                  type="button"
                  onClick={() => router.push(`/workflows/${workflow.id}`)}
                  className="ml-1 underline hover:text-zinc-700"
                >
                  打开画布
                </button>
              </p>
            </>
          )}

          {tab === "refs" && (
            <ReferencesPanel kind="workflow" id={workflow.id} />
          )}

          {tab === "revisions" && (
            <RevisionPanel
              kind="workflow"
              id={workflow.id}
              onRestored={() => {
                void reloadFromServer();
                onRefresh();
              }}
            />
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-zinc-200 px-6 py-4">
          {error && <p className="mr-auto text-sm text-red-600">{error}</p>}
          <button
            onClick={onClose}
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
          >
            {tab === "basic" ? "取消" : "关闭"}
          </button>
          {tab === "basic" && (
            <button
              onClick={() => void save()}
              disabled={saving}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
