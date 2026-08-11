"use client";

import { useState } from "react";
import {
  type ActionDto,
  type Kind,
  KindBadge,
  type ModelRow,
  type ObjectTypeRow,
  type ReasoningEffort,
  readError,
  type SkillRow,
  type ToolRow,
} from "./shared";

interface PortDraft {
  key: string;
  name: string;
  objectTypeId: string;
}

function toDrafts(action: ActionDto | null, direction: "input" | "output") {
  if (!action) return [];
  return action.ports
    .filter((p) => p.direction === direction)
    .sort((a, b) => a.position - b.position)
    .map((p) => ({
      key: crypto.randomUUID(),
      name: p.name,
      objectTypeId: p.objectTypeId,
    }));
}

export function ActionEditor({
  initial,
  models,
  objectTypes,
  skills,
  tools,
  onClose,
  onSaved,
}: {
  initial: ActionDto | null;
  models: ModelRow[];
  objectTypes: ObjectTypeRow[];
  skills: SkillRow[];
  tools: ToolRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [rule, setRule] = useState(initial?.rule ?? "");
  const [modelId, setModelId] = useState(
    initial?.modelId ?? models[0]?.id ?? "",
  );
  const [effort, setEffort] = useState<ReasoningEffort>(
    initial?.reasoningEffort ?? "max",
  );
  const [inputPorts, setInputPorts] = useState<PortDraft[]>(() =>
    toDrafts(initial, "input"),
  );
  const [outputPorts, setOutputPorts] = useState<PortDraft[]>(() =>
    toDrafts(initial, "output"),
  );
  const [skillIds, setSkillIds] = useState<string[]>(initial?.skillIds ?? []);
  const [toolIds, setToolIds] = useState<string[]>(initial?.toolIds ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function validate(): string | null {
    if (!name.trim()) return "名称不能为空";
    if (!prompt.trim()) return "Prompt 不能为空";
    if (!modelId) return "请选择模型";
    for (const [label, ports] of [
      ["输入", inputPorts],
      ["输出", outputPorts],
    ] as const) {
      const seen = new Set<string>();
      for (const p of ports) {
        const portName = p.name.trim();
        if (!portName) return `${label}端口的端口名不能为空`;
        if (!p.objectTypeId)
          return `${label}端口「${portName}」未选择对象类型`;
        if (seen.has(portName)) return `${label}端口名「${portName}」重复`;
        seen.add(portName);
      }
    }
    return null;
  }

  async function save() {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    const payload = {
      name: name.trim(),
      description,
      prompt,
      rule,
      modelId,
      reasoningEffort: effort,
      ports: [
        ...inputPorts.map((p, i) => ({
          direction: "input" as const,
          name: p.name.trim(),
          objectTypeId: p.objectTypeId,
          position: i,
        })),
        ...outputPorts.map((p, i) => ({
          direction: "output" as const,
          name: p.name.trim(),
          objectTypeId: p.objectTypeId,
          position: i,
        })),
      ],
      skillIds,
      toolIds,
    };
    try {
      const res = await fetch(
        initial ? `/api/actions/${initial.id}` : "/api/actions",
        {
          method: initial ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
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

  function toggle(
    ids: string[],
    setIds: (v: string[]) => void,
    id: string,
  ): void {
    setIds(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/30"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-3xl flex-col bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
          <h2 className="text-base font-semibold text-zinc-900">
            {initial ? "编辑 Action" : "新建 Action"}
          </h2>
          <button
            onClick={onClose}
            className="text-sm text-zinc-400 hover:text-zinc-600"
          >
            关闭
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-zinc-700">
                名称
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：集采计划生成"
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
                placeholder="一句话说明这个 Action 做什么"
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-zinc-700">
              Prompt（任务描述，可用 {"{{输入端口名}}"} 占位符）
            </span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={10}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs leading-5 focus:border-zinc-500 focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-zinc-700">
              Rule（执行时必须遵守的规则，注入上下文）
            </span>
            <textarea
              value={rule}
              onChange={(e) => setRule(e.target.value)}
              rows={5}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs leading-5 focus:border-zinc-500 focus:outline-none"
            />
          </label>

          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-zinc-700">
                模型
              </span>
              <select
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
              >
                <option value="">选择模型…</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-zinc-700">
                思考强度
              </span>
              <select
                value={effort}
                onChange={(e) => setEffort(e.target.value as ReasoningEffort)}
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
              >
                <option value="low">low（低）</option>
                <option value="medium">medium（中）</option>
                <option value="high">high（高）</option>
                <option value="max">max（最大）</option>
              </select>
            </label>
          </div>

          <PortListEditor
            title="输入端口"
            ports={inputPorts}
            setPorts={setInputPorts}
            objectTypes={objectTypes}
          />
          <PortListEditor
            title="输出端口"
            ports={outputPorts}
            setPorts={setOutputPorts}
            objectTypes={objectTypes}
          />

          <div className="grid grid-cols-2 gap-4">
            <div>
              <span className="mb-1 block text-sm font-medium text-zinc-700">
                引用 Skill（强制注入）
              </span>
              <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-md border border-zinc-300 p-2">
                {skills.length === 0 ? (
                  <p className="px-1.5 py-1 text-xs text-zinc-400">
                    Skill 库为空
                  </p>
                ) : (
                  skills.map((s) => (
                    <label
                      key={s.id}
                      className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-sm hover:bg-zinc-50"
                    >
                      <input
                        type="checkbox"
                        checked={skillIds.includes(s.id)}
                        onChange={() => toggle(skillIds, setSkillIds, s.id)}
                        className="mt-1"
                      />
                      <span className="min-w-0">
                        <span className="text-zinc-800">{s.name}</span>
                        {s.description && (
                          <span className="ml-2 text-xs text-zinc-400">
                            {s.description}
                          </span>
                        )}
                      </span>
                    </label>
                  ))
                )}
              </div>
            </div>
            <div>
              <span className="mb-1 block text-sm font-medium text-zinc-700">
                引用 Tool（执行时可调用）
              </span>
              <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-md border border-zinc-300 p-2">
                {tools.length === 0 ? (
                  <p className="px-1.5 py-1 text-xs text-zinc-400">
                    Tool 库为空
                  </p>
                ) : (
                  tools.map((t) => (
                    <label
                      key={t.id}
                      className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-sm hover:bg-zinc-50"
                    >
                      <input
                        type="checkbox"
                        checked={toolIds.includes(t.id)}
                        onChange={() => toggle(toolIds, setToolIds, t.id)}
                        className="mt-1"
                      />
                      <span className="min-w-0">
                        <span className="font-mono text-zinc-800">
                          {t.name}
                        </span>
                        {t.description && (
                          <span className="ml-2 text-xs text-zinc-400">
                            {t.description}
                          </span>
                        )}
                      </span>
                    </label>
                  ))
                )}
              </div>
            </div>
          </div>
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

function PortListEditor({
  title,
  ports,
  setPorts,
  objectTypes,
}: {
  title: string;
  ports: PortDraft[];
  setPorts: (v: PortDraft[]) => void;
  objectTypes: ObjectTypeRow[];
}) {
  const typeById = new Map(objectTypes.map((t) => [t.id, t]));

  function update(key: string, patch: Partial<PortDraft>) {
    setPorts(ports.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm font-medium text-zinc-700">{title}</span>
        <button
          onClick={() =>
            setPorts([
              ...ports,
              { key: crypto.randomUUID(), name: "", objectTypeId: "" },
            ])
          }
          className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-50"
        >
          + 添加
        </button>
      </div>
      {ports.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 px-3 py-2 text-xs text-zinc-400">
          （无{title}）
        </p>
      ) : (
        <div className="space-y-2">
          {ports.map((p) => {
            const selected = typeById.get(p.objectTypeId);
            const kind: Kind | null = selected ? selected.kind : null;
            return (
              <div key={p.key} className="flex items-center gap-2">
                <input
                  value={p.name}
                  onChange={(e) => update(p.key, { name: e.target.value })}
                  placeholder="端口名"
                  className="w-44 rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-zinc-500 focus:outline-none"
                />
                <select
                  value={p.objectTypeId}
                  onChange={(e) =>
                    update(p.key, { objectTypeId: e.target.value })
                  }
                  className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:border-zinc-500 focus:outline-none"
                >
                  <option value="">选择对象类型…</option>
                  {objectTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                {kind ? (
                  <KindBadge kind={kind} />
                ) : (
                  <span className="inline-flex shrink-0 items-center rounded border border-zinc-200 px-1.5 py-0.5 font-mono text-xs text-zinc-300">
                    —
                  </span>
                )}
                <button
                  onClick={() =>
                    setPorts(ports.filter((x) => x.key !== p.key))
                  }
                  className="shrink-0 rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                  title="删除此端口"
                >
                  删除
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
