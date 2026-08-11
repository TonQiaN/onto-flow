"use client";

import { useCallback, useEffect, useState } from "react";

interface ToolRow {
  id: string;
  name: string;
  description: string;
  code: string;
  createdAt: string;
  updatedAt: string;
}

interface ActionRef {
  id: string;
  name: string;
  toolIds: string[];
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

export default function ToolsPage() {
  const [tools, setTools] = useState<ToolRow[] | null>(null);
  const [refs, setRefs] = useState<Map<string, string[]> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editor, setEditor] = useState<
    { mode: "create" } | { mode: "edit"; tool: ToolRow } | null
  >(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/tools", { cache: "no-store" });
      if (!res.ok) {
        setLoadError(await readError(res));
        setTools(null);
        return;
      }
      setTools((await res.json()) as ToolRow[]);
    } catch {
      setLoadError("网络错误，无法加载 Tool 列表");
      setTools(null);
    } finally {
      setLoading(false);
    }
    // 引用信息来自 Action 库，加载失败不影响主列表
    try {
      const res = await fetch("/api/actions", { cache: "no-store" });
      if (!res.ok) return;
      const actions = (await res.json()) as ActionRef[];
      const map = new Map<string, string[]>();
      for (const a of actions) {
        for (const toolId of a.toolIds ?? []) {
          const list = map.get(toolId) ?? [];
          list.push(a.name);
          map.set(toolId, list);
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

  async function remove(tool: ToolRow) {
    if (!window.confirm(`确认删除 Tool「${tool.name}」？此操作不可撤销。`))
      return;
    setRowError((prev) => ({ ...prev, [tool.id]: "" }));
    try {
      const res = await fetch(`/api/tools/${tool.id}`, { method: "DELETE" });
      if (res.status === 409) {
        const data = (await res.json()) as { error?: string; usedBy?: unknown };
        const detail = formatUsedBy(data.usedBy);
        setRowError((prev) => ({
          ...prev,
          [tool.id]: `${data.error ?? "该 Tool 正被引用，无法删除"}${detail ? `。引用方：${detail}` : ""}`,
        }));
        return;
      }
      if (!res.ok) {
        const msg = await readError(res);
        setRowError((prev) => ({ ...prev, [tool.id]: msg }));
        return;
      }
      void load();
    } catch {
      setRowError((prev) => ({ ...prev, [tool.id]: "网络错误，删除失败" }));
    }
  }

  return (
    <div className="p-8">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-zinc-900">Tool 库</h1>
            <p className="mt-1 text-sm text-zinc-500">
              opencode custom tool 脚本，被 Action 引用后在执行时供模型调用。
            </p>
          </div>
          <button
            onClick={() => setEditor({ mode: "create" })}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white transition-colors hover:bg-zinc-700"
          >
            新建 Tool
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
        ) : tools && tools.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 bg-white py-16 text-center text-sm text-zinc-400">
            还没有 Tool，点击右上角「新建 Tool」创建第一个。
          </div>
        ) : (
          <ul className="space-y-3">
            {(tools ?? []).map((tool) => {
              const names = refs?.get(tool.id) ?? null;
              return (
                <li
                  key={tool.id}
                  className="rounded-lg border border-zinc-200 bg-white p-4"
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
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-400">
                    <span>更新于 {fmtTime(tool.updatedAt)}</span>
                    {refs &&
                      (names && names.length > 0 ? (
                        <span>
                          被 {names.length} 个 Action 引用：{names.join("、")}
                        </span>
                      ) : (
                        <span>未被引用</span>
                      ))}
                  </div>
                  {rowError[tool.id] && (
                    <p className="mt-2 text-xs text-red-600">
                      {rowError[tool.id]}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {editor && (
        <ToolEditor
          initial={editor.mode === "edit" ? editor.tool : null}
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

function ToolEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: ToolRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [code, setCode] = useState(initial?.code ?? TOOL_TEMPLATE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
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
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-zinc-700">
              代码（完整的 opencode custom tool TypeScript 定义）
            </span>
            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              rows={22}
              spellCheck={false}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs leading-5 focus:border-zinc-500 focus:outline-none"
            />
          </label>
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
