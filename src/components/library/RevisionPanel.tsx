"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ENTITY_KIND_API,
  type EntityKind,
  formatTime,
  readError,
  type RevisionDetail,
  type RevisionSummary,
} from "./types";

/* --------------------------- 定义归一（diff 前置） --------------------------- */

/**
 * diff 的两边来源不同形状，必须先归一到「同一份定义契约」再比，否则全是假差异：
 * ① 修订 payload 是各 writer 里 revisionPayload() 写入的**扁平定义**
 *    （见 src/server/writers/*.ts），也正是回滚时重放给 PUT 的载荷；
 * ② 「当前定义」来自 GET /api/<库>/[id]，workflow 是信封、action 是带派生字段的 DTO。
 *
 * 归一规则 = writer 的 revisionPayload 字段集：
 * 只保留写入路径真正接受的字段，DTO 派生字段（ports.id/objectTypeName/kind、
 * folder/refCount）、行主键与时间戳、以及 workflow 的 issues 一律不属于定义。
 * 两边都过同一个函数，diff 结果才等于「回滚后真正会变的东西」。
 */
type Rec = Record<string, unknown>;

const DEFINITION_KEYS: Record<EntityKind, readonly string[]> = {
  workflow: ["name", "description", "nodes", "edges"],
  action: [
    "name",
    "description",
    "prompt",
    "rule",
    "modelId",
    "reasoningEffort",
    "ports",
    "skillIds",
    "toolIds",
  ],
  skill: ["name", "description", "content"],
  tool: ["name", "description", "code"],
  // builtin 不在 parseObjectTypePayload 的接受范围内（内置类型根本不可改），
  // 不属于定义；早期种子修订里带过它，这里一并裁掉，免得每次都报一条假删除。
  object_type: ["name", "kind", "description", "jsonSchema"],
};

const PORT_KEYS = ["direction", "name", "objectTypeId", "position"] as const;
const NODE_KEYS = [
  "id",
  "kind",
  "actionId",
  "objectTypeId",
  "label",
  "x",
  "y",
] as const;
const EDGE_KEYS = [
  "id",
  "sourceNodeId",
  "sourcePort",
  "targetNodeId",
  "targetPort",
] as const;

function asRecord(value: unknown): Rec | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : null;
}

/** 只取存在的键：缺席的键保持缺席，才能如实报「新增/删除」而不是「修改成空」 */
function pick(src: Rec, keys: readonly string[]): Rec {
  const out: Rec = {};
  for (const key of keys) if (key in src) out[key] = src[key];
  return out;
}

function projectItems(value: unknown, keys: readonly string[]): unknown[] {
  return (value as unknown[]).map((item) => {
    const rec = asRecord(item);
    return rec ? pick(rec, keys) : item;
  });
}

/**
 * 端口是集合语义（唯一键是 direction+name，position 只在同方向内定序）。
 * 修订 payload 的顺序是「先全部 input 再全部 output」，而 DTO 是按 position
 * 全局升序 join 出来的——同 position 的输入输出会交错，顺序天然对不上。
 * 两边统一按 (direction, position, name) 定序，避免顺序差异被当成字段差异。
 */
function comparePorts(a: unknown, b: unknown): number {
  const ra = asRecord(a) ?? {};
  const rb = asRecord(b) ?? {};
  const rank = (v: unknown) => (v === "output" ? 1 : 0);
  const byDirection = rank(ra.direction) - rank(rb.direction);
  if (byDirection !== 0) return byDirection;
  const pa = typeof ra.position === "number" ? ra.position : 0;
  const pb = typeof rb.position === "number" ? rb.position : 0;
  if (pa !== pb) return pa - pb;
  return String(ra.name ?? "").localeCompare(String(rb.name ?? ""));
}

/** 图的节点/连线同样是集合，落库顺序无语义，两边都按 id 定序 */
function compareById(a: unknown, b: unknown): number {
  const ra = asRecord(a) ?? {};
  const rb = asRecord(b) ?? {};
  return String(ra.id ?? "").localeCompare(String(rb.id ?? ""));
}

/** 把一份定义（修订 payload 或当前定义）裁剪并定序成规范形态 */
function normalizeDefinition(kind: EntityKind, value: unknown): unknown {
  const rec = asRecord(value);
  if (!rec) return value;
  const out = pick(rec, DEFINITION_KEYS[kind]);
  if (kind === "action" && Array.isArray(out.ports))
    out.ports = projectItems(out.ports, PORT_KEYS).sort(comparePorts);
  if (kind === "workflow") {
    if (Array.isArray(out.nodes))
      out.nodes = projectItems(out.nodes, NODE_KEYS).sort(compareById);
    if (Array.isArray(out.edges))
      out.edges = projectItems(out.edges, EDGE_KEYS).sort(compareById);
  }
  return out;
}

/**
 * 把 GET /api/<库>/[id] 的响应体摊平成定义形状。
 * workflow 单独一档：它返回的是信封 { workflow, nodes, edges, issues }，
 * 直接拿去比会把 name/description 报成删除，还多出 workflow.x 与 issues.x 的假新增。
 */
function currentDefinition(kind: EntityKind, body: unknown): unknown {
  if (kind !== "workflow") return normalizeDefinition(kind, body);
  const envelope = asRecord(body);
  const workflow = envelope ? asRecord(envelope.workflow) : null;
  if (!envelope || !workflow) return null;
  return normalizeDefinition(kind, {
    name: workflow.name,
    description: workflow.description,
    nodes: envelope.nodes,
    edges: envelope.edges,
  });
}

/* ------------------------------ 字段级 diff ------------------------------ */

type DiffType = "added" | "removed" | "changed";

interface DiffRow {
  path: string;
  type: DiffType;
  /** 该版本里的值 */
  before: string;
  /** 当前定义里的值 */
  after: string;
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "";
  return JSON.stringify(v, null, 2) ?? String(v);
}

/** 对象扁平化成 path → 值：`ports[0].name`、`model.displayName` */
function flatten(
  value: unknown,
  prefix: string,
  out: Map<string, unknown>,
): Map<string, unknown> {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.set(prefix || "(root)", "[]");
      return out;
    }
    value.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out));
    return out;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      out.set(prefix || "(root)", "{}");
      return out;
    }
    for (const [k, v] of entries)
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out.set(prefix || "(root)", value);
  return out;
}

/** 与实体定义无关的噪声字段（时间戳、顶层主键）不参与比较 */
function isIgnored(path: string): boolean {
  if (path === "id") return true;
  const last = (path.split(".").pop() ?? "").replace(/\[\d+\]$/, "");
  return last === "createdAt" || last === "updatedAt";
}

function diffDefinitions(before: unknown, after: unknown): DiffRow[] {
  const a = flatten(before, "", new Map());
  const b = flatten(after, "", new Map());
  const paths = new Set([...a.keys(), ...b.keys()]);
  const rows: DiffRow[] = [];
  for (const path of paths) {
    if (isIgnored(path)) continue;
    const hasA = a.has(path);
    const hasB = b.has(path);
    const va = formatValue(a.get(path));
    const vb = formatValue(b.get(path));
    if (hasA && hasB) {
      if (va !== vb)
        rows.push({ path, type: "changed", before: va, after: vb });
    } else if (hasB) {
      rows.push({ path, type: "added", before: "", after: vb });
    } else {
      rows.push({ path, type: "removed", before: va, after: "" });
    }
  }
  rows.sort((x, y) => x.path.localeCompare(y.path));
  return rows;
}

const DIFF_STYLE: Record<DiffType, { label: string; className: string }> = {
  added: {
    label: "新增",
    className: "border-emerald-200 bg-emerald-50 text-emerald-800",
  },
  removed: { label: "删除", className: "border-red-200 bg-red-50 text-red-800" },
  changed: {
    label: "修改",
    className: "border-amber-200 bg-amber-50 text-amber-800",
  },
};

const HEAD_TAIL_LINES = 3;

/** 长文本值折叠：只显示前后各 3 行，可展开全文 */
function ValueBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  const long = lines.length > HEAD_TAIL_LINES * 2 + 1;
  if (!text) return <span className="text-zinc-400">（空）</span>;
  const shown =
    long && !expanded
      ? [
          ...lines.slice(0, HEAD_TAIL_LINES),
          `… 省略 ${lines.length - HEAD_TAIL_LINES * 2} 行 …`,
          ...lines.slice(lines.length - HEAD_TAIL_LINES),
        ]
      : lines;
  return (
    <div>
      <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-4">
        {shown.join("\n")}
      </pre>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] text-zinc-500 underline hover:text-zinc-800"
        >
          {expanded ? "收起" : "展开全文"}
        </button>
      )}
    </div>
  );
}

function DiffRowView({ row }: { row: DiffRow }) {
  const style = DIFF_STYLE[row.type];
  return (
    <li className={`rounded-md border px-3 py-2 ${style.className}`}>
      <div className="flex items-center gap-2">
        <span className="rounded bg-white/70 px-1 text-[10px]">
          {style.label}
        </span>
        <span className="truncate font-mono text-xs">{row.path}</span>
      </div>
      <div className="mt-1.5 space-y-1.5">
        {row.type !== "added" && (
          <div>
            <p className="text-[11px] opacity-70">该版本</p>
            <ValueBlock text={row.before} />
          </div>
        )}
        {row.type !== "removed" && (
          <div>
            <p className="text-[11px] opacity-70">当前</p>
            <ValueBlock text={row.after} />
          </div>
        )}
      </div>
    </li>
  );
}

/* ------------------------------- 面板本体 ------------------------------- */

interface RevisionListResponse {
  items?: RevisionSummary[];
}

/** 修订历史：列表 + 与当前定义的字段级 diff + 回滚 + pin/备注 */
export function RevisionPanel({
  kind,
  id,
  onRestored,
}: {
  kind: EntityKind;
  id: string;
  onRestored?: () => void;
}) {
  const [revisions, setRevisions] = useState<RevisionSummary[] | null>(null);
  const [current, setCurrent] = useState<unknown>(null);
  const [details, setDetails] = useState<Record<string, RevisionDetail>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [noteEditId, setNoteEditId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  const load = useCallback(async () => {
    if (!id) {
      setRevisions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setDetails({});
    try {
      const [listRes, currentRes] = await Promise.all([
        fetch(
          `/api/revisions?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`,
          { cache: "no-store" },
        ),
        fetch(`${ENTITY_KIND_API[kind]}/${encodeURIComponent(id)}`, {
          cache: "no-store",
        }),
      ]);
      if (!listRes.ok) {
        setError(await readError(listRes));
        setRevisions(null);
        return;
      }
      const data = (await listRes.json()) as
        | RevisionSummary[]
        | RevisionListResponse;
      setRevisions(Array.isArray(data) ? data : (data.items ?? []));
      // 当前定义先归一成与修订 payload 同一形状再入 state，diff 才有可比性
      setCurrent(
        currentRes.ok
          ? currentDefinition(kind, await currentRes.json())
          : null,
      );
    } catch {
      setError("网络错误，无法加载修订历史");
      setRevisions(null);
    } finally {
      setLoading(false);
    }
  }, [kind, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const openRevision = async (rev: RevisionSummary) => {
    if (expanded === rev.id) {
      setExpanded(null);
      return;
    }
    setExpanded(rev.id);
    if (details[rev.id]) return;
    setBusyId(rev.id);
    try {
      const res = await fetch(`/api/revisions/${encodeURIComponent(rev.id)}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const detail = (await res.json()) as RevisionDetail;
      setDetails((prev) => ({ ...prev, [rev.id]: detail }));
    } catch {
      setError("网络错误，无法加载该版本内容");
    } finally {
      setBusyId(null);
    }
  };

  const patch = async (revId: string, body: { pinned?: boolean; note?: string }) => {
    setBusyId(revId);
    setError(null);
    try {
      const res = await fetch(`/api/revisions/${encodeURIComponent(revId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setRevisions((prev) =>
        (prev ?? []).map((r) => (r.id === revId ? { ...r, ...body } : r)),
      );
    } catch {
      setError("网络错误，修订未更新");
    } finally {
      setBusyId(null);
    }
  };

  const restore = async (revId: string) => {
    setBusyId(revId);
    setError(null);
    try {
      const res = await fetch(
        `/api/revisions/${encodeURIComponent(revId)}/restore`,
        { method: "POST" },
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setConfirmId(null);
      setExpanded(null);
      await load();
      onRestored?.();
    } catch {
      setError("网络错误，回滚失败");
    } finally {
      setBusyId(null);
    }
  };

  const diffCache = useMemo(() => {
    const detail = expanded ? details[expanded] : undefined;
    if (!detail) return null;
    // 修订 payload 也过一遍归一：老版本可能带过已不属于定义的字段（如 object_type
    // 种子版里的 builtin），且端口/节点顺序要与当前定义用同一套定序规则。
    return diffDefinitions(normalizeDefinition(kind, detail.payload), current);
  }, [expanded, details, current, kind]);

  return (
    <section className="rounded-lg border border-zinc-200 bg-white">
      <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <h3 className="text-sm font-semibold text-zinc-900">修订历史</h3>
        <span className="text-xs text-zinc-500">
          {loading ? "加载中…" : `共 ${revisions?.length ?? 0} 版`}
        </span>
      </header>

      {error && (
        <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">
          {error}
          <button
            type="button"
            onClick={() => void load()}
            className="ml-2 underline hover:text-red-900"
          >
            重试
          </button>
        </div>
      )}

      {loading ? (
        <p className="py-8 text-center text-xs text-zinc-400">加载中…</p>
      ) : !revisions || revisions.length === 0 ? (
        <p className="py-8 text-center text-xs text-zinc-400">暂无修订记录</p>
      ) : (
        <ul className="divide-y divide-zinc-100">
          {revisions.map((rev) => {
            const isOpen = expanded === rev.id;
            const busy = busyId === rev.id;
            return (
              <li key={rev.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => void openRevision(rev)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-zinc-500">
                        {isOpen ? "▾" : "▸"}
                      </span>
                      <span className="text-sm font-medium text-zinc-900">
                        v{rev.versionNo}
                      </span>
                      {rev.pinned && (
                        <span className="rounded border border-amber-200 bg-amber-50 px-1 text-[10px] text-amber-700">
                          已固定
                        </span>
                      )}
                      <span className="text-xs text-zinc-400">
                        {formatTime(rev.createdAt)}
                      </span>
                    </div>
                    <p className="mt-0.5 pl-5 text-xs text-zinc-500">
                      {rev.note || "（无备注）"}
                    </p>
                  </button>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void patch(rev.id, { pinned: !rev.pinned })}
                      className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                    >
                      {rev.pinned ? "取消固定" : "固定"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setNoteEditId(rev.id);
                        setNoteDraft(rev.note ?? "");
                      }}
                      className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                    >
                      备注
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmId(rev.id)}
                      className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      回滚
                    </button>
                  </div>
                </div>

                {noteEditId === rev.id && (
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      autoFocus
                      value={noteDraft}
                      onChange={(e) => setNoteDraft(e.target.value)}
                      placeholder="这一版改了什么…"
                      className="flex-1 rounded-md border border-zinc-300 px-2 py-1 text-xs focus:border-zinc-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void patch(rev.id, { note: noteDraft }).then(() =>
                          setNoteEditId(null),
                        )
                      }
                      className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs text-white hover:bg-zinc-700 disabled:opacity-50"
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      onClick={() => setNoteEditId(null)}
                      className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                    >
                      取消
                    </button>
                  </div>
                )}

                {confirmId === rev.id && (
                  <div className="mt-2 flex items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    <span className="flex-1">
                      确认回滚到 v{rev.versionNo}？当前定义会被这一版覆盖（回滚动作本身也会另存一版修订）。
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void restore(rev.id)}
                      className="rounded-md bg-red-600 px-2.5 py-1 text-xs text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {busy ? "回滚中…" : "确认回滚"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmId(null)}
                      className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs text-red-600 hover:bg-red-50"
                    >
                      取消
                    </button>
                  </div>
                )}

                {isOpen && (
                  <div className="mt-3 rounded-md border border-zinc-200 bg-zinc-50 p-3">
                    {!details[rev.id] ? (
                      <p className="text-xs text-zinc-400">加载该版本内容…</p>
                    ) : !current ? (
                      <p className="text-xs text-zinc-400">
                        当前定义不可读，无法比较。
                      </p>
                    ) : !diffCache || diffCache.length === 0 ? (
                      <p className="text-xs text-zinc-500">
                        与当前定义一致，无差异。
                      </p>
                    ) : (
                      <>
                        <p className="mb-2 text-xs text-zinc-500">
                          与当前定义相比有 {diffCache.length} 处差异
                        </p>
                        <ul className="space-y-2">
                          {diffCache.map((row) => (
                            <DiffRowView key={row.path} row={row} />
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
