"use client";

/**
 * Tool 编辑抽屉：小标签页组织「基本信息 / 被引用 / 修订历史」。
 * 基本信息里内嵌 FolderPicker（新建时先收集，实体落库后再补一次归属指派）。
 *
 * Tool 是 OntoFlow 契约（ADR-0017）：作者只写模型可见的公名、描述、参数 schema、
 * 可选的返回值 schema 与超时，以及一个 execute 模块；cordis 包装归平台，作者永远
 * 看不到 `name / inject / apply`。两个 schema 在文本框里以 JSON 编辑，客户端先按
 * 写入口同一套规则（对象根、不含 type 数组）解析校验，见 tool-form.ts。
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
import { publicNameProblem, toolCodeProblem } from "@/lib/tool-names";
import {
  formatSchema,
  parseObjectSchemaText,
  parseOptionalObjectSchemaText,
  parseTimeoutText,
  TOOL_EXECUTE_TEMPLATE,
  TOOL_PARAMETERS_TEMPLATE,
} from "./tool-form";

/** tools 行：GET /api/tools/[id] 与列表项的形状 */
export interface ToolRow {
  id: string;
  /** 库里的展示名（中文） */
  name: string;
  /** 模型可见的工具名，全库唯一 */
  publicName: string;
  description: string;
  parameters: Record<string, unknown>;
  output: Record<string, unknown> | null;
  timeoutMs: number | null;
  /** execute 模块源码 */
  code: string;
  createdAt: string;
  updatedAt: string;
}

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
  const [publicName, setPublicName] = useState(initial?.publicName ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [parametersText, setParametersText] = useState(
    initial ? formatSchema(initial.parameters) : TOOL_PARAMETERS_TEMPLATE,
  );
  const [outputText, setOutputText] = useState(initial ? formatSchema(initial.output) : "");
  const [timeoutText, setTimeoutText] = useState(
    initial?.timeoutMs == null ? "" : String(initial.timeoutMs),
  );
  const [code, setCode] = useState(initial?.code ?? TOOL_EXECUTE_TEMPLATE);
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
      setPublicName(row.publicName);
      setDescription(row.description);
      setParametersText(formatSchema(row.parameters));
      setOutputText(formatSchema(row.output));
      setTimeoutText(row.timeoutMs == null ? "" : String(row.timeoutMs));
      setCode(row.code);
    } catch {
      // 拉取失败保持当前表单
    }
  }, [initial]);

  /** 客户端先做一遍写入口的校验；通过时返回载荷，否则返回错误文案 */
  function buildPayload():
    | { ok: true; payload: Record<string, unknown> }
    | { ok: false; error: string } {
    if (!name.trim()) return { ok: false, error: "名称不能为空" };
    const nameProblem = publicNameProblem(publicName.trim());
    if (nameProblem) return { ok: false, error: nameProblem };
    const parameters = parseObjectSchemaText(parametersText, "parameters");
    if (!parameters.ok) return parameters;
    const output = parseOptionalObjectSchemaText(outputText, "output");
    if (!output.ok) return output;
    const timeoutMs = parseTimeoutText(timeoutText);
    if (!timeoutMs.ok) return timeoutMs;
    const codeProblem = toolCodeProblem(code);
    if (codeProblem) return { ok: false, error: codeProblem };
    return {
      ok: true,
      payload: {
        name: name.trim(),
        publicName: publicName.trim(),
        description,
        parameters: parameters.value,
        output: output.value,
        timeoutMs: timeoutMs.value,
        code,
      },
    };
  }

  async function save() {
    const built = buildPayload();
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(initial ? `/api/tools/${initial.id}` : "/api/tools", {
        method: initial ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(built.payload),
      });
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
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-2xl flex-col bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
          <h2 className="text-base font-semibold text-zinc-900">
            {initial ? "编辑 Tool" : "新建 Tool"}
          </h2>
          <button onClick={onClose} className="text-sm text-zinc-400 hover:text-zinc-600">
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
              <div className="grid grid-cols-2 gap-4">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-zinc-700">
                    名称（库里的展示名）
                  </span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="如：校验评分结果"
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-zinc-700">
                    模型可见的工具名（publicName）
                  </span>
                  <input
                    value={publicName}
                    onChange={(e) => setPublicName(e.target.value)}
                    placeholder="如：validate_resume_match_result"
                    spellCheck={false}
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm focus:border-zinc-500 focus:outline-none"
                  />
                </label>
              </div>
              <p className="-mt-2 text-xs leading-5 text-zinc-400">
                公名小写字母开头，只含小写字母、数字与下划线，最长 64 位，全库唯一；它也是全局设置
                「默认停用的工具」与 Action「可见 Tool」收窄时用的名字。
              </p>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-zinc-700">描述</span>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="一句话说明这个 Tool 的用途（模型据此决定何时调用）"
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
                />
              </label>
              <div>
                <span className="mb-1 block text-sm font-medium text-zinc-700">文件夹</span>
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
                  参数 schema（parameters，对象根 JSON Schema）
                </span>
                <textarea
                  value={parametersText}
                  onChange={(e) => setParametersText(e.target.value)}
                  rows={9}
                  spellCheck={false}
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs leading-5 focus:border-zinc-500 focus:outline-none"
                />
                <span className="mt-1 block text-xs text-zinc-400">
                  上游 JSON Schema 子集：type 不能写成数组（如 [&quot;integer&quot;,
                  &quot;null&quot;]），可空字段直接省略。
                </span>
              </label>
              <div className="grid grid-cols-[1fr_12rem] gap-4">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-zinc-700">
                    返回值 schema（output，可选）
                  </span>
                  <textarea
                    value={outputText}
                    onChange={(e) => setOutputText(e.target.value)}
                    rows={5}
                    spellCheck={false}
                    placeholder="留空即不校验返回值"
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs leading-5 focus:border-zinc-500 focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-zinc-700">
                    单次调用超时（timeoutMs）
                  </span>
                  <input
                    value={timeoutText}
                    onChange={(e) => setTimeoutText(e.target.value)}
                    inputMode="numeric"
                    placeholder="留空即不限"
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm focus:border-zinc-500 focus:outline-none"
                  />
                  <span className="mt-1 block text-xs text-zinc-400">
                    毫秒；声明了才受超时策略约束。
                  </span>
                </label>
              </div>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  execute 模块（默认导出 async function execute(args, ctx)）
                </span>
                <textarea
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  rows={22}
                  spellCheck={false}
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs leading-5 focus:border-zinc-500 focus:outline-none"
                />
                <span className="mt-1 block text-xs text-zinc-400">
                  可以 import node: 内置模块与仓库依赖；不能 import @deepseek-ai/*——能力只经 ctx
                  拿， cordis 包装由平台生成。
                </span>
              </label>
            </>
          )}

          {tab === "refs" && initial && <ReferencesPanel kind="tool" id={initial.id} />}

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
