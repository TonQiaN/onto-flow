"use client";

import { useState } from "react";
import { asPortValue } from "../lib";

const PRE_CLS =
  "max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-zinc-50 p-2.5 font-mono text-xs leading-5 text-zinc-700";

/** 超过此长度的文本折叠展示 */
const TEXT_COLLAPSE_LIMIT = 600;

function CollapsibleText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const overflow = text.length > TEXT_COLLAPSE_LIMIT;
  const shown =
    expanded || !overflow ? text : `${text.slice(0, TEXT_COLLAPSE_LIMIT)}…`;
  return (
    <div>
      <pre className={expanded ? `${PRE_CLS} max-h-none` : PRE_CLS}>
        {shown}
      </pre>
      {overflow && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs text-zinc-500 underline transition-colors hover:text-zinc-900"
        >
          {expanded ? "收起" : `展开全文（共 ${text.length} 字）`}
        </button>
      )}
    </div>
  );
}

interface FilePreviewState {
  status: "idle" | "loading" | "loaded" | "error";
  content?: string;
  truncated?: boolean;
  size?: number;
  error?: string;
}

/**
 * 文件值的按需正文预览：点「查看内容」才打 GET /api/runs/[id]/files。
 * ADR-0012 后输入与产物一律是文件，这里是运行详情看到实质内容的唯一入口；
 * 二进制/超界/已清理由接口报错，原样展示给人。
 */
function FileValue({
  runId,
  file,
}: {
  runId: string;
  file: { path: string; name: string; mime: string };
}) {
  const [preview, setPreview] = useState<FilePreviewState>({ status: "idle" });

  const load = async () => {
    setPreview({ status: "loading" });
    try {
      const res = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/files?path=${encodeURIComponent(file.path)}`,
        { cache: "no-store" },
      );
      const body = (await res.json()) as {
        content?: string;
        truncated?: boolean;
        size?: number;
        error?: string;
      };
      if (!res.ok) {
        setPreview({ status: "error", error: body?.error ?? "读取失败" });
        return;
      }
      setPreview({
        status: "loaded",
        content: body.content ?? "",
        truncated: body.truncated === true,
        size: body.size,
      });
    } catch {
      setPreview({ status: "error", error: "网络错误，读取失败" });
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span
          title={file.mime || undefined}
          className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-100 px-2.5 py-1 text-xs text-zinc-700"
        >
          <span className="text-zinc-400">文件</span>
          <span className="font-medium">{file.name}</span>
        </span>
        {preview.status !== "loaded" && (
          <button
            type="button"
            onClick={() => void load()}
            disabled={preview.status === "loading"}
            className="text-xs text-zinc-500 underline transition-colors hover:text-zinc-900 disabled:opacity-50"
          >
            {preview.status === "loading" ? "读取中…" : "查看内容"}
          </button>
        )}
        {preview.status === "loaded" && (
          <button
            type="button"
            onClick={() => setPreview({ status: "idle" })}
            className="text-xs text-zinc-500 underline transition-colors hover:text-zinc-900"
          >
            收起
          </button>
        )}
      </div>
      {preview.status === "error" && (
        <p className="mt-1 text-xs text-red-700">{preview.error}</p>
      )}
      {preview.status === "loaded" && (
        <div className="mt-2">
          <CollapsibleText text={preview.content ?? ""} />
          {preview.truncated && (
            <p className="mt-1 text-xs text-amber-700">
              预览已截断（文件共 {preview.size} 字节），全文在工作区文件里
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** PortValue 展示：ADR-0012 后只接受文件引用，不保留旧内联值的兼容渲染。 */
export function PortValueView({ value, runId }: { value: unknown; runId?: string }) {
  // 输入端口的值恒是 PortValue[]（一个口可接多条入线的汇总），逐项渲染，
  // 否则数组落到 JSON dump、文件值的预览入口在输入区永远不出现。
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-xs text-zinc-400">（无）</span>;
    }
    return (
      <div className="space-y-2">
        {value.map((item, index) => (
          <PortValueView key={index} value={item} runId={runId} />
        ))}
      </div>
    );
  }
  const pv = asPortValue(value);
  if (!pv || pv.kind !== "file") {
    return <span className="text-xs text-red-700">非文件值不符合当前运行契约</span>;
  }
  if (runId) return <FileValue runId={runId} file={pv.file} />;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        title={pv.file.mime || undefined}
        className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-100 px-2.5 py-1 text-xs text-zinc-700"
      >
        <span className="text-zinc-400">文件</span>
        <span className="font-medium">{pv.file.name}</span>
      </span>
    </div>
  );
}
