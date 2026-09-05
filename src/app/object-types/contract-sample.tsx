"use client";
import { useEffect, useRef, useState } from "react";
import type { ContractIssue } from "@/lib/artifact-contract";
import { ContractIssues } from "@/components/contract-issues";
import { readError } from "@/components/library";

export function ContractSample({ jsonSchema }: { jsonSchema: string }) {
  const [content, setContent] = useState("{}");
  const [result, setResult] = useState<{ valid: boolean; issues: ContractIssue[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  useEffect(() => {
    version.current++;
    setResult(null);
    setError(null);
    setBusy(false);
  }, [jsonSchema, content]);
  async function validate() {
    const current = ++version.current;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/object-types/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, jsonSchema: jsonSchema.trim() || null }),
      });
      if (!res.ok) {
        const message = await readError(res);
        if (current === version.current) setError(message);
        return;
      }
      const data = (await res.json()) as { valid: boolean; issues: ContractIssue[] };
      if (current === version.current) setResult(data);
    } catch {
      if (current === version.current) setError("网络错误，校验失败，请重试");
    } finally {
      if (current === version.current) setBusy(false);
    }
  }
  return (
    <section
      className="rounded-lg border border-zinc-200 bg-zinc-50 p-3"
      aria-label="JSON 契约样例校验"
    >
      <label className="block text-sm font-medium">
        JSON 样例
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={5}
          spellCheck={false}
          className="mt-2 w-full rounded-md border border-zinc-300 bg-white p-2 font-mono text-xs"
        />
      </label>
      <div className="my-3 flex items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">使用上面的当前契约校验，不调用模型。</p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void validate()}
          className="shrink-0 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs disabled:opacity-50"
        >
          {busy ? "校验中…" : "校验样例"}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {result && (
        <div role="status">
          <p
            className={`mb-2 text-sm font-medium ${result.valid ? "text-emerald-700" : "text-red-700"}`}
          >
            {result.valid ? "样例通过契约校验" : "样例未通过契约校验"}
          </p>
          <ContractIssues issues={result.issues} />
        </div>
      )}
    </section>
  );
}
