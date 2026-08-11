"use client";

/**
 * 编辑器左侧节点面板：Action 清单（点击/拖拽入画布）+ 输入/输出节点（先选 Object Type）。
 */
import { useState } from "react";
import {
  portSignature,
  typeColor,
  type ActionDto,
  type ObjectTypeRow,
} from "./types";

export const ACTION_DRAG_MIME = "application/flowforge-action";

export function NodePanel({
  actions,
  objectTypes,
  onAddAction,
  onAddIO,
}: {
  actions: ActionDto[];
  objectTypes: ObjectTypeRow[];
  onAddAction: (action: ActionDto) => void;
  onAddIO: (kind: "input" | "output", type: ObjectTypeRow) => void;
}) {
  const [picker, setPicker] = useState<"input" | "output" | null>(null);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-white">
      <div className="border-b border-zinc-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-zinc-900">节点面板</h2>
        <p className="mt-0.5 text-xs text-zinc-400">点击或拖拽 Action 到画布</p>
      </div>

      <div className="border-b border-zinc-200 p-3">
        <div className="grid grid-cols-2 gap-2">
          {(["input", "output"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setPicker(picker === k ? null : k)}
              className={`rounded-md border px-2 py-1.5 text-xs transition-colors ${
                picker === k
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-300 text-zinc-700 hover:bg-zinc-50"
              }`}
            >
              {k === "input" ? "＋ 输入节点" : "＋ 输出节点"}
            </button>
          ))}
        </div>
        {picker && (
          <div className="mt-2 rounded-md border border-zinc-200 bg-zinc-50 p-1">
            <p className="px-2 py-1 text-[11px] text-zinc-500">
              选择对象类型：
            </p>
            <div className="max-h-56 overflow-auto">
              {objectTypes.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    onAddIO(picker, t);
                    setPicker(null);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-800 hover:bg-white"
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: typeColor(t.id) }}
                  />
                  <span className="truncate">{t.name}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-zinc-400">
                    {t.kind}
                  </span>
                </button>
              ))}
              {objectTypes.length === 0 && (
                <p className="px-2 py-1 text-xs text-zinc-400">暂无对象类型</p>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto p-3">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
          Action 清单
        </p>
        <div className="flex flex-col gap-2">
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(ACTION_DRAG_MIME, a.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => onAddAction(a)}
              className="cursor-grab rounded-lg border border-zinc-200 bg-white px-3 py-2 text-left shadow-sm transition-colors hover:border-zinc-400 active:cursor-grabbing"
            >
              <span className="block truncate text-sm font-medium text-zinc-900">
                {a.name}
              </span>
              <span className="mt-0.5 block text-[11px] leading-4 text-zinc-400">
                {portSignature(a)}
              </span>
            </button>
          ))}
          {actions.length === 0 && (
            <p className="text-xs text-zinc-400">
              暂无 Action，请先到 Action 库创建
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}
