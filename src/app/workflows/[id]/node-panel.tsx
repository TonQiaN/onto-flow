"use client";

/**
 * 编辑器左侧节点面板。
 *
 * - Action 清单按文件夹路径分组浏览（单归属，ADR-0005）+ 关键词搜索；未归类沉底。
 * - 卡片显示端口签名（带类型色点）与引用计数。
 * - 点击或拖拽入画布；输入/输出节点先选对象类型，选择器同样带搜索。
 * - 整个面板可折叠，把宽度让给画布。
 */
import { useMemo, useState } from "react";
import { typeColor } from "@/components/canvas/node-model";
import type { ObjectTypeRow } from "@/components/library";
import { actionPorts, type ActionItem } from "./types";

export const ACTION_DRAG_MIME = "application/ontoflow-action";

// 前置空格保证 key 不会与叫「未归类」的真实文件夹路径撞车
const UNFILED = " 未归类";

interface Group {
  key: string;
  label: string;
  items: ActionItem[];
}

function groupByFolder(items: ActionItem[]): Group[] {
  const map = new Map<string, ActionItem[]>();
  for (const item of items) {
    const key = item.folder ? item.folder.path : UNFILED;
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return [...map.entries()]
    .map(([key, list]) => ({
      key,
      label: key === UNFILED ? "未归类" : key,
      items: [...list].sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN")),
    }))
    .sort((a, b) => {
      // 「未归类」永远沉底
      if (a.key === UNFILED) return 1;
      if (b.key === UNFILED) return -1;
      return a.label.localeCompare(b.label, "zh-Hans-CN");
    });
}

export function NodePanel({
  actions,
  objectTypes,
  onAddAction,
  onAddIO,
}: {
  actions: ActionItem[];
  objectTypes: ObjectTypeRow[];
  onAddAction: (action: ActionItem) => void;
  onAddIO: (kind: "input" | "output", type: ObjectTypeRow) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [picker, setPicker] = useState<"input" | "output" | null>(null);
  const [typeQuery, setTypeQuery] = useState("");
  const [query, setQuery] = useState("");
  const [foldedGroups, setFoldedGroups] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return actions;
    return actions.filter(
      (a) =>
        a.name.toLowerCase().includes(keyword) ||
        a.description.toLowerCase().includes(keyword) ||
        a.ports.some((p) => `${p.name}${p.objectTypeName}`.toLowerCase().includes(keyword)),
    );
  }, [actions, query]);

  const groups = useMemo(() => groupByFolder(filtered), [filtered]);

  const visibleTypes = useMemo(() => {
    const keyword = typeQuery.trim().toLowerCase();
    if (!keyword) return objectTypes;
    return objectTypes.filter(
      (t) => t.name.toLowerCase().includes(keyword) || t.kind.toLowerCase().includes(keyword),
    );
  }, [objectTypes, typeQuery]);

  if (collapsed) {
    return (
      <aside className="flex w-11 shrink-0 flex-col items-center gap-3 border-r border-zinc-200 bg-white py-3">
        <button
          type="button"
          title="展开节点面板"
          onClick={() => setCollapsed(false)}
          className="rounded-md border border-zinc-300 px-1.5 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
        >
          »
        </button>
        <span
          className="text-[11px] tracking-widest text-zinc-400"
          style={{ writingMode: "vertical-rl" }}
        >
          节点面板 · {actions.length}
        </span>
      </aside>
    );
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-200 bg-white">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2.5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-zinc-900">节点面板</h2>
          <p className="mt-0.5 truncate text-[11px] text-zinc-400">点击或拖拽加入画布</p>
        </div>
        <button
          type="button"
          title="折叠面板"
          onClick={() => setCollapsed(true)}
          className="ml-auto shrink-0 rounded-md border border-zinc-300 px-1.5 py-1 text-xs text-zinc-500 hover:bg-zinc-50"
        >
          «
        </button>
      </div>

      {/* ---- 输入 / 输出内置节点 ---- */}
      <div className="border-b border-zinc-200 p-3">
        <div className="grid grid-cols-2 gap-2">
          {(["input", "output"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setPicker(picker === k ? null : k);
                setTypeQuery("");
              }}
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
          <div className="ff-rise-in mt-2 rounded-md border border-zinc-200 bg-zinc-50 p-1.5">
            <input
              autoFocus
              value={typeQuery}
              onChange={(e) => setTypeQuery(e.target.value)}
              placeholder="搜索对象类型…"
              className="mb-1 w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs focus:border-zinc-500 focus:outline-none"
            />
            <div className="max-h-56 overflow-auto">
              {visibleTypes.map((t) => (
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
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-400">
                    {t.kind}
                  </span>
                </button>
              ))}
              {visibleTypes.length === 0 && (
                <p className="px-2 py-2 text-xs text-zinc-400">
                  {objectTypes.length === 0 ? "暂无对象类型" : "没有匹配的对象类型"}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ---- Action 检索条 ---- */}
      <div className="space-y-2 border-b border-zinc-200 px-3 py-2.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索 Action / 端口…"
          className="w-full rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs focus:border-zinc-500 focus:outline-none"
        />
        <div className="flex items-center">
          <span className="ml-auto text-[11px] tabular-nums text-zinc-400">
            {filtered.length} / {actions.length}
          </span>
        </div>
      </div>

      {/* ---- Action 分组清单 ---- */}
      <div className="flex-1 overflow-auto px-3 py-2.5">
        {actions.length === 0 ? (
          <p className="text-xs text-zinc-400">暂无 Action，请先到 Action 库创建</p>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-zinc-400">没有符合当前筛选条件的 Action</p>
        ) : (
          <div className="space-y-3">
            {groups.map((group) => {
              const folded = foldedGroups.has(group.key);
              return (
                <div key={group.key}>
                  <button
                    type="button"
                    onClick={() =>
                      setFoldedGroups((prev) => {
                        const next = new Set(prev);
                        if (next.has(group.key)) next.delete(group.key);
                        else next.add(group.key);
                        return next;
                      })
                    }
                    className="mb-1.5 flex w-full items-center gap-1 text-left text-[11px] font-medium uppercase tracking-wide text-zinc-400 hover:text-zinc-700"
                  >
                    <span className="w-3">{folded ? "▸" : "▾"}</span>
                    <span className="truncate">{group.label}</span>
                    <span className="ml-auto tabular-nums">{group.items.length}</span>
                  </button>
                  {!folded && (
                    <div className="flex flex-col gap-2">
                      {group.items.map((a) => (
                        <ActionCard key={`${group.key}:${a.id}`} action={a} onAdd={onAddAction} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}

/** Action 卡片：名称 + 端口签名（带类型色点）+ 引用计数 */
function ActionCard({
  action,
  onAdd,
}: {
  action: ActionItem;
  onAdd: (action: ActionItem) => void;
}) {
  const inputs = actionPorts(action, "input");
  const outputs = actionPorts(action, "output");

  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(ACTION_DRAG_MIME, action.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => onAdd(action)}
      title={action.description || action.name}
      className="cursor-grab rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-left shadow-sm transition-all hover:-translate-y-px hover:border-zinc-400 hover:shadow active:cursor-grabbing"
    >
      <span className="block truncate text-sm font-medium text-zinc-900">{action.name}</span>

      <span className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-zinc-500">
        {inputs.length === 0 ? (
          <span className="text-zinc-300">无输入</span>
        ) : (
          inputs.map((p) => <PortChip key={p.id} port={p} />)
        )}
        <span className="px-0.5 font-mono text-zinc-300">→</span>
        {outputs.length === 0 ? (
          <span className="text-zinc-300">无输出</span>
        ) : (
          outputs.map((p) => <PortChip key={p.id} port={p} />)
        )}
      </span>

      <span className="mt-1 flex items-center gap-2 text-[10px]">
        {action.refCount > 0 ? (
          <span className="text-zinc-400">{action.refCount} 处引用</span>
        ) : (
          <span className="text-zinc-300">未被引用</span>
        )}
      </span>
    </button>
  );
}

function PortChip({
  port,
}: {
  port: { name: string; objectTypeId: string; objectTypeName: string };
}) {
  return (
    <span
      title={`${port.name}（${port.objectTypeName}）`}
      className="inline-flex max-w-[6.5rem] items-center gap-1 rounded border border-zinc-200 px-1 py-px"
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: typeColor(port.objectTypeId) }}
      />
      <span className="truncate">{port.objectTypeName}</span>
    </span>
  );
}
