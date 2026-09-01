"use client";

/**
 * 对象类型编辑抽屉：小标签页组织「基本信息 / 被引用 / 修订历史」。
 * 内置类型不可改（列表页不给编辑入口），此处只处理自定义类型。
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

export type Kind = "text" | "file" | "json";

export interface ObjectTypeRow {
  id: string;
  name: string;
  kind: Kind;
  description: string;
  jsonSchema: string | null;
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

export const KIND_STYLE: Record<Kind, string> = {
  text: "border-sky-200 bg-sky-50 text-sky-700",
  file: "border-amber-200 bg-amber-50 text-amber-700",
  json: "border-violet-200 bg-violet-50 text-violet-700",
};

export function KindBadge({ kind }: { kind: Kind }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-xs ${KIND_STYLE[kind]}`}
    >
      {kind}
    </span>
  );
}

type TabKey = "basic" | "refs" | "revisions";

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: "basic", label: "基本信息" },
  { key: "refs", label: "被引用" },
  { key: "revisions", label: "修订历史" },
];

export function ObjectTypeEditor({
  initial,
  initialFolder,
  onClose,
  onSaved,
  onRefresh,
}: {
  initial: ObjectTypeRow | null;
  /** create 模式是页面传入的默认归属（当前选中文件夹），edit 模式是实体现有归属 */
  initialFolder: FolderRef | null;
  onClose: () => void;
  onSaved: () => void;
  onRefresh: () => void;
}) {
  const [tab, setTab] = useState<TabKey>("basic");
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<Kind>(initial?.kind ?? "text");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [jsonSchema, setJsonSchema] = useState(initial?.jsonSchema ?? "");
  const [folder, setFolder] = useState<FolderRef | null>(initialFolder);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 回滚后把服务端最新定义拉回表单 */
  const reloadFromServer = useCallback(async () => {
    if (!initial) return;
    try {
      const res = await fetch(`/api/object-types/${initial.id}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const row = (await res.json()) as ObjectTypeRow;
      setName(row.name);
      setKind(row.kind);
      setDescription(row.description);
      setJsonSchema(row.jsonSchema ?? "");
    } catch {
      // 拉取失败保持当前表单
    }
  }, [initial]);

  async function save() {
    if (!name.trim()) {
      setError("名称不能为空");
      return;
    }
    if (kind === "json" && jsonSchema.trim()) {
      try {
        JSON.parse(jsonSchema);
      } catch {
        setError("JSON Schema 不是合法 JSON");
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        initial ? `/api/object-types/${initial.id}` : "/api/object-types",
        {
          method: initial ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            kind,
            description,
            jsonSchema:
              kind === "json" && jsonSchema.trim() ? jsonSchema : null,
          }),
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
              entityKind: "object_type",
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
        className="flex h-full w-full max-w-xl flex-col bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
          <h2 className="text-base font-semibold text-zinc-900">
            {initial ? "编辑对象类型" : "新建对象类型"}
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
                  名称
                </span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="如：需求文件、集采计划"
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  基础形态
                </span>
                <select
                  value={kind}
                  onChange={(e) => setKind(e.target.value as Kind)}
                  className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
                >
                  <option value="text">text（文本）</option>
                  <option value="file">file（文件）</option>
                  <option value="json">json（结构化数据）</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  描述
                </span>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="一句话说明这个类型承载的内容"
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
                />
              </label>
              <div>
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  文件夹
                </span>
                <FolderPicker
                  kind="object_type"
                  entityId={initial?.id ?? ""}
                  value={folder}
                  onChange={(next) => {
                    setFolder(next);
                    if (initial) onRefresh();
                  }}
                />
                {!initial && (
                  <p className="mt-1 text-xs text-zinc-400">
                    新建的对象类型保存后才会真正归入文件夹。
                  </p>
                )}
              </div>
              {kind === "json" && (
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-zinc-700">
                    JSON Schema（可选，同时用作结构化输出 schema）
                  </span>
                  <textarea
                    value={jsonSchema}
                    onChange={(e) => setJsonSchema(e.target.value)}
                    rows={14}
                    spellCheck={false}
                    placeholder='{"type":"object","properties":{...},"required":[...]}'
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs leading-5 focus:border-zinc-500 focus:outline-none"
                  />
                </label>
              )}
            </>
          )}

          {tab === "refs" && initial && (
            <ReferencesPanel kind="object_type" id={initial.id} />
          )}

          {tab === "revisions" && initial && (
            <RevisionPanel
              kind="object_type"
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
