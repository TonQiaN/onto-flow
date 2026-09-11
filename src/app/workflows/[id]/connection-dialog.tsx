"use client";

import { useEffect, useRef, useState } from "react";
import { classifyEdges, connectionProblem, type GraphEdge, type ResolvedNode } from "@/lib/graph";

/** 为键盘与不便拖线的场景提供同一条连线入口，不另存一份图。 */
export function ConnectionDialog({
  nodes,
  edges,
  onAdd,
  onClose,
  onEdit,
}: {
  nodes: ResolvedNode[];
  edges: GraphEdge[];
  onAdd: (edge: GraphEdge) => void;
  onClose: () => void;
  onEdit: (nodeId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [id] = useState(() => crypto.randomUUID());
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const options = (direction: "inputs" | "outputs") =>
    nodes.flatMap((node) =>
      node[direction].map((port) => ({
        value: JSON.stringify([node.id, port.name]),
        nodeId: node.id,
        port: port.name,
        label: `${node.label} · ${port.name}（${port.objectTypeName}）`,
      })),
    );
  const outputs = options("outputs");
  const inputs = options("inputs");
  const from = outputs.find((o) => o.value === source);
  const to = inputs.find((o) => o.value === target);
  const candidate =
    from && to
      ? {
          id,
          sourceNodeId: from.nodeId,
          sourcePort: from.port,
          targetNodeId: to.nodeId,
          targetPort: to.port,
        }
      : null;
  const problem = candidate ? connectionProblem(nodes, edges, candidate) : undefined;
  const back = candidate && classifyEdges(nodes, [...edges, candidate]).backEdgeIds.has(id);
  const targetNode = nodes.find((node) => node.id === to?.nodeId);
  const count = candidate
    ? edges.filter(
        (e) => e.targetNodeId === candidate.targetNodeId && e.targetPort === candidate.targetPort,
      ).length
    : 0;
  return (
    <dialog
      ref={dialog}
      aria-labelledby="connection-title"
      onCancel={onClose}
      className="fixed inset-0 m-auto w-[min(36rem,calc(100vw-2rem))] rounded-xl border border-zinc-200 bg-white p-6 text-zinc-900 shadow-xl backdrop:bg-black/30"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (candidate && !problem) onAdd(candidate);
        }}
      >
        <h2 id="connection-title" className="text-lg font-semibold">
          添加连线
        </h2>
        <p className="mt-2 text-sm text-zinc-500">
          一个输入可以汇总多份产物；回边需要目标 Action 设置重入上限。
        </p>
        {[
          { title: "起点输出", value: source, options: outputs, change: setSource },
          { title: "终点输入", value: target, options: inputs, change: setTarget },
        ].map((field) => (
          <label key={field.title} className="mt-4 block text-sm font-medium">
            {field.title}
            <select
              autoFocus={field.title === "起点输出"}
              value={field.value}
              onChange={(e) => field.change(e.target.value)}
              className="mt-1.5 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">请选择端口</option>
              {field.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ))}
        {problem ? (
          <div role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {problem.message}
            {problem.nodeId && (
              <button
                type="button"
                onClick={() => onEdit(problem.nodeId!)}
                className="mt-2 block font-medium underline"
              >
                调整重入设置
              </button>
            )}
          </div>
        ) : (
          candidate && (
            <p role="status" className="mt-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
              {back
                ? `回边至「${targetNode?.label}」：最多重入 ${targetNode?.maxReentries} 次；耗尽时${targetNode?.onExhausted === "accept" ? "接受结果" : "报告失败"}。`
                : count > 0
                  ? `汇总输入：共 ${count + 1} 条入线，每轮接收已激活的产物列表。`
                  : "可以连接。"}
            </p>
          )
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={!candidate || !!problem}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-40"
          >
            连接
          </button>
        </div>
      </form>
    </dialog>
  );
}
