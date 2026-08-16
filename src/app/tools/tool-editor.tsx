"use client";

/**
 * Tool 编辑抽屉：小标签页组织「基本信息 / 被引用 / 修订历史」。
 * 基本信息里内嵌 FolderPicker（新建时先收集，实体落库后再补一次归属指派）。
 */
import { useCallback, useState } from "react";
import {
  FolderPicker,
  type FolderRef,
  notifyFoldersChanged,
  readError,
  ReferencesPanel,
  RevisionPanel,
} from "@/components/library";

export interface ToolRow {
  id: string;
  name: string;
  description: string;
  code: string;
  createdAt: string;
  updatedAt: string;
}

const TOOL_TEMPLATE = `import { tool } from "@opencode-ai/plugin";

export default tool({
  description: "工具的功能描述（模型据此决定何时调用）",
  args: {
    input: tool.schema.string().describe("参数说明"),
  },
  async execute(args) {
    // TODO: 在这里实现工具逻辑，返回字符串结果
    return JSON.stringify({ ok: true, input: args.input });
  },
});
`;

type TabKey = "basic" | "refs" | "revisions";

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: "basic", label: "基本信息" },
  { key: "refs", label: "被引用" },
  { key: "revisions", label: "修订历史" },
];

export function ToolEditor({
  initial,
  initialFolder,
  onClose,
  onSaved,
  onRefresh,
}: {
  initial: ToolRow | null;
  /** create 模式是页面传入的默认归属（当前选中文件夹），edit 模式是实体现有归属 */
  initialFolder: FolderRef | null;
  onClose: () => void;
  onSaved: () => void;
  onRefresh: () => void;
}) {
  const [tab, setTab] = useState<TabKey>("basic");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [code, setCode] = useState(initial?.code ?? TOOL_TEMPLATE);
  const [folder, setFolder] = useState<FolderRef | null>(initialFolder);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 回滚后把服务端最新定义拉回表单 */
  const reloadFromServer = useCallback(async () => {
    if (!initial) return;
    try {
      const res = await fetch(`/api/tools/${initial.id}`, { cache: "no-store" });
      if (!res.ok) return;
      const row = (await res.json()) as ToolRow;
      setName(row.name);
      setDescription(row.description);
      setCode(row.code);
    } catch {
      // 拉取失败保持当前表单
    }
  }, [initial]);

  async function save() {
    if (!name.trim()) {
      setError("名称不能为空");
      return;
    }
    if (!code.trim()) {
      setError("代码不能为空");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        initial ? `/api/tools/${initial.id}` : "/api/tools",
        {
          method: initial ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), description, code }),
        },
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      // 新建时实体此前无 id，归属只存在内存里，落库后补一次指派
      if (!initial && folder) {
        const created = (await res.json()) as { id?: string };
        if (created?.id) {
          await fetch("/api/folders/assign", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              entityKind: "tool",
              entityId: created.id,
              folderId: folder.id,
            }),
          });
          notifyFoldersChanged();
        }
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
        className="flex h-full w-full max-w-2xl flex-col bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
          <h2 className="text-base font-semibold text-zinc-900">
            {initial ? "编辑 Tool" : "新建 Tool"}
          </h2>
          <button
            onClick={onClose}
            className="text-sm text-zinc-400 hover:text-zinc-600"
          >
            关闭
          </button>
        </div>

        {initial && (
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
        )}

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          {tab === "basic" && (
            <>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  名称（将作为工具文件名 &lt;name&gt;.ts）
                </span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="如：save_purchase_plan"
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm focus:border-zinc-500 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  描述
                </span>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="一句话说明这个 Tool 的用途"
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
                />
              </label>
              <div>
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  文件夹
                </span>
                <FolderPicker
                  kind="tool"
                  entityId={initial?.id ?? ""}
                  value={folder}
                  onChange={(next) => {
                    setFolder(next);
                    if (initial) onRefresh();
                  }}
                />
                {!initial && (
                  <p className="mt-1 text-xs text-zinc-400">
                    新建的 Tool 保存后才会真正归入文件夹。
                  </p>
                )}
              </div>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  代码（完整的 opencode custom tool TypeScript 定义）
                </span>
                <textarea
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  rows={20}
                  spellCheck={false}
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs leading-5 focus:border-zinc-500 focus:outline-none"
                />
              </label>
            </>
          )}

          {tab === "refs" && initial && (
            <ReferencesPanel kind="tool" id={initial.id} />
          )}

          {tab === "revisions" && initial && (
            <RevisionPanel
              kind="tool"
              id={initial.id}
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
