"use client";

/**
 * 库实体卡片上的三枚徽章：归属、引用计数、对象类型。
 * 四个库页的卡片副信息是同一套（docs/DESIGN-V2.md 第五节），此前四页各抄一份，
 * 改一次图标或文案要改四个文件；分歧要靠再拆出来解决，不是给这里加开关。
 */
import type { PortKind } from "@/components/canvas/node-model";
import type { FolderRef } from "./types";

/** 文件夹徽章，点击即进入该文件夹（列表改按其子树过滤）；未归类不显示 */
export function FolderBadge({
  folder,
  onEnter,
}: {
  folder: FolderRef | null;
  onEnter: (id: string) => void;
}) {
  if (!folder) return null;
  return (
    <button
      type="button"
      title={`进入文件夹「${folder.path}」`}
      onClick={() => onEnter(folder.id)}
      className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2 py-0.5 text-[11px] text-zinc-600 hover:border-zinc-400 hover:text-zinc-900"
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="h-3 w-3 shrink-0 text-zinc-400"
        aria-hidden
      >
        <path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h2.9c.4 0 .78.16 1.06.44l.86.86h4.68c.83 0 1.5.67 1.5 1.5v6.2c0 .83-.67 1.5-1.5 1.5H3.25c-.83 0-1.5-.67-1.5-1.5v-7.5Z" />
      </svg>
      {folder.path}
    </button>
  );
}

/** 引用计数：0 时弱化显示 */
export function RefCount({ count }: { count: number }) {
  return count > 0 ? (
    <span className="text-zinc-500">{count} 处引用</span>
  ) : (
    <span className="text-zinc-300">未被引用</span>
  );
}

/** 对象类型三种底层形态的配色，Action 库的端口签名直接用类串拼 */
export const KIND_STYLE: Record<PortKind, string> = {
  text: "border-sky-200 bg-sky-50 text-sky-700",
  file: "border-amber-200 bg-amber-50 text-amber-700",
  json: "border-violet-200 bg-violet-50 text-violet-700",
};

/** 对象类型徽章：`shrink-0` 让它在卡片标题行被挤时不塌 */
export function KindBadge({ kind }: { kind: PortKind }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 font-mono text-xs ${KIND_STYLE[kind]}`}
    >
      {kind}
    </span>
  );
}
