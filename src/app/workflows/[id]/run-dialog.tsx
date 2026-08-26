"use client";

/**
 * 运行前的输入收集对话框：为每个输入节点按 Object Type kind 收集 PortValue。
 * text → textarea；json → textarea（提交前 JSON.parse 校验）；file → 上传（POST /api/uploads）。
 */
import { useEffect, useState } from "react";
import type { PortValue } from "@/lib/values";
import type { FilePreprocessor } from "@/lib/object-types";
import { KIND_LABEL, type PortKind } from "./types";

export interface RunInputSpec {
  nodeId: string;
  label: string;
  typeName: string;
  kind: PortKind;
  filePreprocessor: FilePreprocessor | null;
}

interface FieldState {
  text: string;
  file: PortValue | null;
  uploading: boolean;
  error: string | null;
}

const emptyField: FieldState = {
  text: "",
  file: null,
  uploading: false,
  error: null,
};

export function RunDialog({
  specs,
  submitting,
  onCancel,
  onSubmit,
}: {
  specs: RunInputSpec[];
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (inputs: Record<string, PortValue>) => void;
}) {
  const [fields, setFields] = useState<Record<string, FieldState>>(() =>
    Object.fromEntries(specs.map((s) => [s.nodeId, { ...emptyField }])),
  );

  const patch = (id: string, p: Partial<FieldState>) =>
    setFields((f) => ({ ...f, [id]: { ...f[id], ...p } }));

  const uploadFile = async (id: string, file: File) => {
    patch(id, { uploading: true, error: null, file: null });
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/uploads", { method: "POST", body: fd });
      const body = (await res.json()) as PortValue & { error?: string };
      if (!res.ok) throw new Error(body.error ?? "上传失败");
      patch(id, { file: body, uploading: false });
    } catch (err) {
      patch(id, {
        uploading: false,
        error: err instanceof Error ? err.message : "上传失败",
      });
    }
  };

  const submit = () => {
    const inputs: Record<string, PortValue> = {};
    let hasError = false;
    for (const spec of specs) {
      const f = fields[spec.nodeId] ?? emptyField;
      if (spec.kind === "file") {
        if (!f.file) {
          patch(spec.nodeId, { error: "请先上传文件" });
          hasError = true;
          continue;
        }
        inputs[spec.nodeId] = f.file;
      } else if (spec.kind === "json") {
        try {
          inputs[spec.nodeId] = { kind: "json", json: JSON.parse(f.text) };
          patch(spec.nodeId, { error: null });
        } catch {
          patch(spec.nodeId, { error: "不是合法 JSON" });
          hasError = true;
        }
      } else {
        inputs[spec.nodeId] = { kind: "text", text: f.text };
      }
    }
    if (!hasError) onSubmit(inputs);
  };

  const anyUploading = specs.some((s) => fields[s.nodeId]?.uploading);

  // Esc 关闭（提交过程中不打断）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [submitting, onCancel]);

  return (
    <div
      className="ff-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => {
        if (!submitting) onCancel();
      }}
    >
      <div
        className="ff-rise-in max-h-[85vh] w-[32rem] overflow-auto rounded-lg border border-zinc-200 bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-zinc-900">运行工作流</h2>
        <p className="mt-0.5 text-xs text-zinc-400">
          {specs.length > 0
            ? "为每个输入节点提供值后开始运行"
            : "该工作流没有输入节点，将直接开始运行"}
        </p>

        <div className="mt-4 flex flex-col gap-4">
          {specs.map((spec) => {
            const f = fields[spec.nodeId] ?? emptyField;
            return (
              <div key={spec.nodeId}>
                <label className="block text-sm font-medium text-zinc-800">
                  {spec.label}
                  <span className="ml-1.5 text-xs font-normal text-zinc-400">
                    {spec.typeName} · {KIND_LABEL[spec.kind]}
                  </span>
                </label>
                {spec.kind === "file" ? (
                  <div className="mt-1.5">
                    <input
                      type="file"
                      disabled={submitting || f.uploading}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        // 清空 value：上传失败后允许重选同一文件重试
                        e.target.value = "";
                        if (file) void uploadFile(spec.nodeId, file);
                      }}
                      className="block w-full text-xs text-zinc-600 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-xs file:text-white hover:file:bg-zinc-700"
                    />
                    {f.uploading && (
                      <p className="mt-1 text-xs text-zinc-400">上传中…</p>
                    )}
                    {f.file?.kind === "file" && (
                      <p className="mt-1 text-xs text-emerald-600">
                        已上传：{f.file.file.name}
                      </p>
                    )}
                    {spec.filePreprocessor === "pdf" && (
                      <p className="mt-1 text-xs leading-5 text-zinc-400">
                        支持 PDF、Markdown 与纯文本；PDF 会抽取文本层并逐页交给多模态模型核对。
                      </p>
                    )}
                  </div>
                ) : (
                  <textarea
                    value={f.text}
                    disabled={submitting}
                    onChange={(e) =>
                      patch(spec.nodeId, { text: e.target.value, error: null })
                    }
                    rows={spec.kind === "json" ? 5 : 4}
                    placeholder={
                      spec.kind === "json" ? "输入 JSON…" : "输入文本…"
                    }
                    className={`mt-1.5 w-full rounded-md border px-3 py-2 font-mono text-xs focus:outline-none ${
                      f.error
                        ? "border-red-400 focus:border-red-500"
                        : "border-zinc-300 focus:border-zinc-500"
                    }`}
                  />
                )}
                {f.error && (
                  <p className="mt-1 text-xs text-red-600">{f.error}</p>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-md border border-zinc-300 bg-white px-3.5 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || anyUploading}
            className="rounded-md bg-zinc-900 px-3.5 py-1.5 text-sm text-white hover:bg-zinc-700 disabled:opacity-50"
          >
            {submitting ? "提交中…" : "开始运行"}
          </button>
        </div>
      </div>
    </div>
  );
}
