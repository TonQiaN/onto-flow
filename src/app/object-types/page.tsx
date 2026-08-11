"use client";

import { useCallback, useEffect, useState } from "react";

type Kind = "text" | "file" | "json";

interface ObjectTypeRow {
  id: string;
  name: string;
  kind: Kind;
  description: string;
  jsonSchema: string | null;
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ActionRef {
  id: string;
  name: string;
  ports: Array<{ objectTypeId: string }>;
}

const KIND_STYLE: Record<Kind, string> = {
  text: "border-sky-200 bg-sky-50 text-sky-700",
  file: "border-amber-200 bg-amber-50 text-amber-700",
  json: "border-violet-200 bg-violet-50 text-violet-700",
};

function KindBadge({ kind }: { kind: Kind }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-xs ${KIND_STYLE[kind]}`}
    >
      {kind}
    </span>
  );
}

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // 响应体不是 JSON
  }
  return `请求失败（HTTP ${res.status}）`;
}

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

function fmtTime(value: string | number | null | undefined): string {
  if (value == null) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", { hour12: false });
}

export default function ObjectTypesPage() {
  const [types, setTypes] = useState<ObjectTypeRow[] | null>(null);
  const [refs, setRefs] = useState<Map<string, string[]> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editor, setEditor] = useState<
    { mode: "create" } | { mode: "edit"; type: ObjectTypeRow } | null
  >(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/object-types", { cache: "no-store" });
      if (!res.ok) {
        setLoadError(await readError(res));
        setTypes(null);
        return;
      }
      setTypes((await res.json()) as ObjectTypeRow[]);
    } catch {
      setLoadError("网络错误，无法加载对象类型列表");
      setTypes(null);
    } finally {
      setLoading(false);
    }
    // 引用信息来自 Action 端口，加载失败不影响主列表
    try {
      const res = await fetch("/api/actions", { cache: "no-store" });
      if (!res.ok) return;
      const actions = (await res.json()) as ActionRef[];
      const map = new Map<string, string[]>();
      for (const a of actions) {
        const typeIds = new Set((a.ports ?? []).map((p) => p.objectTypeId));
        for (const typeId of typeIds) {
          const list = map.get(typeId) ?? [];
          list.push(a.name);
          map.set(typeId, list);
        }
      }
      setRefs(map);
    } catch {
      setRefs(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(type: ObjectTypeRow) {
    if (!window.confirm(`确认删除对象类型「${type.name}」？此操作不可撤销。`))
      return;
    setRowError((prev) => ({ ...prev, [type.id]: "" }));
    try {
      const res = await fetch(`/api/object-types/${type.id}`, {
        method: "DELETE",
      });
      if (res.status === 409) {
        const data = (await res.json()) as { error?: string; usedBy?: unknown };
        const detail = formatUsedBy(data.usedBy);
        setRowError((prev) => ({
          ...prev,
          [type.id]: `${data.error ?? "该类型正被引用，无法删除"}${detail ? `。引用方：${detail}` : ""}`,
        }));
        return;
      }
      if (!res.ok) {
        const msg = await readError(res);
        setRowError((prev) => ({ ...prev, [type.id]: msg }));
        return;
      }
      void load();
    } catch {
      setRowError((prev) => ({ ...prev, [type.id]: "网络错误，删除失败" }));
    }
  }

  return (
    <div className="p-8">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-zinc-900">对象类型</h1>
            <p className="mt-1 text-sm text-zinc-500">
              端口类型注册表：连线严格同类型才能连。内置 text / file / json
              三个通用类型兜底。
            </p>
          </div>
          <button
            onClick={() => setEditor({ mode: "create" })}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white transition-colors hover:bg-zinc-700"
          >
            新建类型
          </button>
        </header>

        {loadError && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {loadError}
            <button
              onClick={() => void load()}
              className="ml-3 underline hover:text-red-900"
            >
              重试
            </button>
          </div>
        )}

        {loading ? (
          <p className="py-16 text-center text-sm text-zinc-400">加载中…</p>
        ) : types && types.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 bg-white py-16 text-center text-sm text-zinc-400">
            还没有对象类型，点击右上角「新建类型」创建第一个。
          </div>
        ) : (
          <ul className="space-y-3">
            {(types ?? []).map((type) => {
              const names = refs?.get(type.id) ?? null;
              return (
                <li
                  key={type.id}
                  className="rounded-lg border border-zinc-200 bg-white p-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h2 className="text-sm font-semibold text-zinc-900">
                          {type.name}
                        </h2>
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
                      <p className="mt-1 text-sm text-zinc-500">
                        {type.description || "（无描述）"}
                      </p>
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
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-400">
                    <span>更新于 {fmtTime(type.updatedAt)}</span>
                    {refs &&
                      (names && names.length > 0 ? (
                        <span>
                          被 {names.length} 个 Action 的端口引用：
                          {names.join("、")}
                        </span>
                      ) : (
                        <span>未被 Action 端口引用</span>
                      ))}
                  </div>
                  {rowError[type.id] && (
                    <p className="mt-2 text-xs text-red-600">
                      {rowError[type.id]}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {editor && (
        <ObjectTypeEditor
          initial={editor.mode === "edit" ? editor.type : null}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function ObjectTypeEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: ObjectTypeRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<Kind>(initial?.kind ?? "text");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [jsonSchema, setJsonSchema] = useState(initial?.jsonSchema ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
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
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-zinc-200 px-6 py-4">
          {error && <p className="mr-auto text-sm text-red-600">{error}</p>}
          <button
            onClick={onClose}
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
          >
            取消
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
