"use client";
import type { ArtifactValidation } from "@/lib/artifact-contract";
import { ContractIssues } from "@/components/contract-issues";
import { PortValueView } from "./port-value-view";

const LEVEL = { file: "文件存在", json: "JSON 语法", schema: "JSON 契约" };

export function ArtifactValidationView({
  validation,
  runId,
}: {
  validation: ArtifactValidation;
  runId: string;
}) {
  const failed = validation.artifacts.some((artifact) => artifact.issues.length > 0);
  return (
    <section aria-label="产物契约验收" className="space-y-3 rounded-lg border border-zinc-200 p-3">
      <div className="flex items-center justify-between gap-2 text-sm font-medium">
        <h3>产物契约验收</h3>
        <span className={failed ? "text-red-700" : "text-emerald-700"}>
          {failed ? "未通过" : "通过"}
        </span>
      </div>
      <p className="text-xs text-zinc-500">
        模型执行已完成。这里只检查交付契约，业务质量尚未验收。
      </p>
      {validation.artifacts.map((artifact) => (
        <div key={artifact.port} className="space-y-2 border-t border-zinc-100 pt-3">
          <p className="text-xs font-medium">
            {artifact.port} · {LEVEL[artifact.validation]}
            {artifact.issues.length ? "未通过" : "通过"}
          </p>
          <p className="font-mono text-xs break-all text-zinc-500">{artifact.artifactPath}</p>
          <ContractIssues issues={artifact.issues} />
          {artifact.sha256 && (
            <details className="text-[10px] text-zinc-400">
              <summary className="cursor-pointer">校验文件 SHA-256</summary>
              <p className="mt-1 font-mono break-all">{artifact.sha256}</p>
            </details>
          )}
          {artifact.issues.length > 0 && artifact.file && (
            <PortValueView value={artifact.file} runId={runId} previewLabel="查看失败文件" />
          )}
        </div>
      ))}
    </section>
  );
}
