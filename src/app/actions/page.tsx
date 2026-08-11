"use client";

import { useCallback, useEffect, useState } from "react";
import { ActionEditor } from "./action-editor";
import {
  type ActionDto,
  EFFORT_LABEL,
  formatUsedBy,
  KIND_STYLE,
  type ModelRow,
  type ObjectTypeRow,
  readError,
  type SkillRow,
  type ToolRow,
} from "./shared";

export default function ActionsPage() {
  const [actions, setActions] = useState<ActionDto[] | null>(null);
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [objectTypes, setObjectTypes] = useState<ObjectTypeRow[] | null>(null);
  const [skills, setSkills] = useState<SkillRow[] | null>(null);
  const [tools, setTools] = useState<ToolRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [supportError, setSupportError] = useState<string | null>(null);
  const [editor, setEditor] = useState<
    { mode: "create" } | { mode: "edit"; action: ActionDto } | null
  >(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setSupportError(null);
    const fetchJson = async <T,>(url: string): Promise<T> => {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res));
      return (await res.json()) as T;
    };
    const [a, m, ot, s, t] = await Promise.allSettled([
      fetchJson<ActionDto[]>("/api/actions"),
      fetchJson<ModelRow[]>("/api/models"),
      fetchJson<ObjectTypeRow[]>("/api/object-types"),
      fetchJson<SkillRow[]>("/api/skills"),
      fetchJson<ToolRow[]>("/api/tools"),
    ]);
    if (a.status === "fulfilled") {
      setActions(a.value);
    } else {
      setActions(null);
      setLoadError(
        a.reason instanceof Error ? a.reason.message : "无法加载 Action 列表",
      );
    }
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
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const editorReady =
    models !== null && objectTypes !== null && skills !== null && tools !== null;
  const modelById = new Map((models ?? []).map((m) => [m.id, m]));

  async function remove(action: ActionDto) {
    if (!window.confirm(`确认删除 Action「${action.name}」？此操作不可撤销。`))
      return;
    setRowError((prev) => ({ ...prev, [action.id]: "" }));
    try {
      const res = await fetch(`/api/actions/${action.id}`, {
        method: "DELETE",
      });
      if (res.status === 409) {
        const data = (await res.json()) as { error?: string; usedBy?: unknown };
        const detail = formatUsedBy(data.usedBy);
        setRowError((prev) => ({
          ...prev,
          [action.id]: `${data.error ?? "该 Action 正被引用，无法删除"}${detail ? `。引用方：${detail}` : ""}`,
        }));
        return;
      }
      if (!res.ok) {
        const msg = await readError(res);
        setRowError((prev) => ({ ...prev, [action.id]: msg }));
        return;
      }
      void load();
    } catch {
      setRowError((prev) => ({ ...prev, [action.id]: "网络错误，删除失败" }));
    }
  }

  return (
    <div className="p-8">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-zinc-900">Action 库</h1>
            <p className="mt-1 text-sm text-zinc-500">
              可复用的原子工作单元：Prompt + Rule + 端口 + 模型 + 引用的 Skill /
              Tool。
            </p>
          </div>
          <button
            onClick={() => setEditor({ mode: "create" })}
            disabled={!editorReady}
            title={editorReady ? undefined : "基础数据未就绪"}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
          >
            新建 Action
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
        {supportError && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            {supportError}
            <button
              onClick={() => void load()}
              className="ml-3 underline hover:text-amber-900"
            >
              重试
            </button>
          </div>
        )}

        {loading ? (
          <p className="py-16 text-center text-sm text-zinc-400">加载中…</p>
        ) : actions && actions.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 bg-white py-16 text-center text-sm text-zinc-400">
            还没有 Action，点击右上角「新建 Action」创建第一个。
          </div>
        ) : (
          <ul className="space-y-3">
            {(actions ?? []).map((action) => {
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
                  className="rounded-lg border border-zinc-200 bg-white p-4"
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
                    <span>
                      模型：{model ? model.displayName : "（未知模型）"}
                    </span>
                    <span>思考强度：{EFFORT_LABEL[action.reasoningEffort]}</span>
                    <span>Skill × {action.skillIds.length}</span>
                    <span>Tool × {action.toolIds.length}</span>
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
        )}
      </div>

      {editor && models && objectTypes && skills && tools && (
        <ActionEditor
          initial={editor.mode === "edit" ? editor.action : null}
          models={models}
          objectTypes={objectTypes}
          skills={skills}
          tools={tools}
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
