"use client";

import {
  durationText,
  formatCost,
  formatDateTime,
  formatTokens,
  sumTokens,
  toMillis,
  type RunNodeRow,
} from "../lib";
import { STATUS_DOT, StatusBadge } from "../status-badge";
import { PortValueView } from "./port-value-view";
import { SnapshotView } from "./snapshot-view";

function PortSection({
  title,
  entries,
}: {
  title: string;
  entries: [string, unknown][];
}) {
  return (
    <div className="mt-3">
      <div className="mb-1.5 text-xs font-medium text-zinc-400">{title}</div>
      <div className="space-y-2">
        {entries.map(([name, value]) => (
          <div key={name}>
            <div className="mb-1 font-mono text-xs text-zinc-500">{name}</div>
            <PortValueView value={value} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** 用量明细行：只有真的产生过用量的节点才显示（输入/输出节点恒为 0） */
function UsageLine({ node }: { node: RunNodeRow }) {
  const tokens = sumTokens(node);
  if (tokens === 0 && node.cost === 0) return null;
  const parts = [
    `输入 ${formatTokens(node.inputTokens)}`,
    `输出 ${formatTokens(node.outputTokens)}`,
    `推理 ${formatTokens(node.reasoningTokens)}`,
    `缓存读 ${formatTokens(node.cacheReadTokens)}`,
    `缓存写 ${formatTokens(node.cacheWriteTokens)}`,
  ];
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-zinc-50 px-3 py-2 font-mono text-xs text-zinc-500">
      <span className="text-zinc-700">token {formatTokens(tokens)}</span>
      <span className="text-zinc-700">费用 {formatCost(node.cost)}</span>
      <span className="text-zinc-300">|</span>
      <span>{parts.join(" · ")}</span>
    </div>
  );
}

/**
 * 节点时间线卡片：label + 状态徽章 + 耗时 + 用量 + 输入/输出 +
 * 错误全文 + 运行快照。
 */
export function NodeCard({ node }: { node: RunNodeRow }) {
  const started = toMillis(node.startedAt);
  const inputs = Object.entries(node.inputs ?? {});
  const outputs = Object.entries(node.outputs ?? {});
  return (
    <div className="relative pl-8">
      <span
        className={`absolute top-5 left-0 h-2.5 w-2.5 rounded-full ${
          STATUS_DOT[node.status] ?? "bg-zinc-300"
        }`}
      />
      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium text-zinc-900">{node.label}</span>
          <StatusBadge status={node.status} />
          <span className="ml-auto text-xs text-zinc-500">
            {started != null && <>开始 {formatDateTime(started)} · </>}
            耗时 {durationText(node.startedAt, node.finishedAt)}
          </span>
        </div>
        <UsageLine node={node} />
        {inputs.length > 0 && <PortSection title="输入" entries={inputs} />}
        {outputs.length > 0 && <PortSection title="输出" entries={outputs} />}
        {node.error && (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm break-words whitespace-pre-wrap text-red-700">
            {node.error}
          </div>
        )}
        <SnapshotView snapshot={node.snapshot} />
      </div>
    </div>
  );
}
