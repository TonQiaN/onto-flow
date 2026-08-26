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

/**
 * PortValue 展示：text → 可折叠 pre；json → 格式化 JSON pre；
 * file → 文件名徽章；非法形态兜底为原始 JSON。
 */
export function PortValueView({ value }: { value: unknown }) {
  const pv = asPortValue(value);
  if (!pv) {
    return <pre className={PRE_CLS}>{JSON.stringify(value, null, 2)}</pre>;
  }
  switch (pv.kind) {
    case "text":
      return <CollapsibleText text={pv.text} />;
    case "json":
      return (
        <pre className={PRE_CLS}>{JSON.stringify(pv.json, null, 2)}</pre>
      );
    case "file":
      return (
        <div className="flex flex-wrap items-center gap-2">
          <span
            title={pv.file.mime || undefined}
            className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-100 px-2.5 py-1 text-xs text-zinc-700"
          >
            <span className="text-zinc-400">文件</span>
            <span className="font-medium">{pv.file.name}</span>
          </span>
          {pv.file.preprocessed?.kind === "pdf" && (
            <span className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs text-blue-700">
              PDF 已预处理 · {pv.file.preprocessed.pageCount} 页
            </span>
          )}
        </div>
      );
  }
}
