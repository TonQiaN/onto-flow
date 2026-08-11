"use client";

import { useCallback, useEffect, useState } from "react";

interface SkillRow {
  id: string;
  name: string;
  description: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

interface ActionRef {
  id: string;
  name: string;
  skillIds: string[];
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

export default function SkillsPage() {
  const [skills, setSkills] = useState<SkillRow[] | null>(null);
  const [refs, setRefs] = useState<Map<string, string[]> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editor, setEditor] = useState<
    { mode: "create" } | { mode: "edit"; skill: SkillRow } | null
  >(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/skills", { cache: "no-store" });
      if (!res.ok) {
        setLoadError(await readError(res));
        setSkills(null);
        return;
      }
      setSkills((await res.json()) as SkillRow[]);
    } catch {
      setLoadError("网络错误，无法加载 Skill 列表");
      setSkills(null);
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
        for (const skillId of a.skillIds ?? []) {
          const list = map.get(skillId) ?? [];
          list.push(a.name);
          map.set(skillId, list);
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

  async function remove(skill: SkillRow) {
    if (!window.confirm(`确认删除 Skill「${skill.name}」？此操作不可撤销。`))
      return;
    setRowError((prev) => ({ ...prev, [skill.id]: "" }));
    try {
      const res = await fetch(`/api/skills/${skill.id}`, { method: "DELETE" });
      if (res.status === 409) {
        const data = (await res.json()) as { error?: string; usedBy?: unknown };
        const detail = formatUsedBy(data.usedBy);
        setRowError((prev) => ({
          ...prev,
          [skill.id]: `${data.error ?? "该 Skill 正被引用，无法删除"}${detail ? `。引用方：${detail}` : ""}`,
        }));
        return;
      }
      if (!res.ok) {
        setRowError((prev) => ({ ...prev, [skill.id]: "" }));
        const msg = await readError(res);
        setRowError((prev) => ({ ...prev, [skill.id]: msg }));
        return;
      }
      void load();
    } catch {
      setRowError((prev) => ({ ...prev, [skill.id]: "网络错误，删除失败" }));
    }
  }

  return (
    <div className="p-8">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-zinc-900">Skill 库</h1>
            <p className="mt-1 text-sm text-zinc-500">
              命名 prompt 片段，被 Action 引用后在执行时强制注入会话。
            </p>
          </div>
          <button
            onClick={() => setEditor({ mode: "create" })}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white transition-colors hover:bg-zinc-700"
          >
            新建 Skill
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
        ) : skills && skills.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 bg-white py-16 text-center text-sm text-zinc-400">
            还没有 Skill，点击右上角「新建 Skill」创建第一个。
          </div>
        ) : (
          <ul className="space-y-3">
            {(skills ?? []).map((skill) => {
              const names = refs?.get(skill.id) ?? null;
              return (
                <li
                  key={skill.id}
                  className="rounded-lg border border-zinc-200 bg-white p-4"
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
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-400">
                    <span>更新于 {fmtTime(skill.updatedAt)}</span>
                    {refs &&
                      (names && names.length > 0 ? (
                        <span>
                          被 {names.length} 个 Action 引用：{names.join("、")}
                        </span>
                      ) : (
                        <span>未被引用</span>
                      ))}
                  </div>
                  {rowError[skill.id] && (
                    <p className="mt-2 text-xs text-red-600">
                      {rowError[skill.id]}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {editor && (
        <SkillEditor
          initial={editor.mode === "edit" ? editor.skill : null}
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

function SkillEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: SkillRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [content, setContent] = useState(initial?.content ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) {
      setError("名称不能为空");
      return;
    }
    if (!content.trim()) {
      setError("内容不能为空");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        initial ? `/api/skills/${initial.id}` : "/api/skills",
        {
          method: initial ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), description, content }),
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
            {initial ? "编辑 Skill" : "新建 Skill"}
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
              placeholder="如：集采计划编制规范"
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
              placeholder="一句话说明这个 Skill 的用途"
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-zinc-700">
              内容（Markdown，注入会话上下文）
            </span>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={18}
              placeholder="Skill 全文…"
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
