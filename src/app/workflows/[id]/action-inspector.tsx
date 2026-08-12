"use client";

/**
 * 画布上双击 Action 节点弹出的检查器（ADR-0004）。
 *
 * 它本身几乎没有 UI —— 编辑器复用 Action 库的同一个组件
 * （src/app/actions/action-editor.tsx，内含常驻引用提示、被引用面板、
 * 端口影响预览、修订历史四件套），这里只负责：
 * ① 打开时把该 Action 的最新定义从服务端拉一遍（画布上的清单可能已经陈旧）；
 * ② 注入画布语境的 onFork：「复制为新 Action 并替换本节点」。
 */
import { useEffect, useState } from "react";
import { ActionEditor } from "@/app/actions/action-editor";
import { readError, type Tag } from "@/components/library";
import type {
  ActionDto,
  ActionItem,
  ModelRow,
  ObjectTypeRow,
  SkillRow,
  ToolRow,
} from "./types";

export interface InspectorTarget {
  /** 被双击的画布节点 */
  nodeId: string;
  action: ActionItem;
}

export function ActionInspector({
  target,
  models,
  objectTypes,
  skills,
  tools,
  onClose,
  onSaved,
  onForked,
}: {
  target: InspectorTarget;
  models: ModelRow[];
  objectTypes: ObjectTypeRow[];
  skills: SkillRow[];
  tools: ToolRow[];
  onClose: () => void;
  /** 共享 Action 保存成功：调用方刷新画布上引用它的全部节点 */
  onSaved: (saved: ActionDto) => void;
  /** 已创建副本：调用方把本节点指向新 Action 并保存整图 */
  onForked: (nodeId: string, created: ActionDto) => Promise<void> | void;
}) {
  const [fresh, setFresh] = useState<ActionDto>(target.action);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // 画布的 Action 清单是进页面时拉的，编辑前先对齐服务端最新定义
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/actions/${target.action.id}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          if (!cancelled) setLoadError(await readError(res));
          return;
        }
        const dto = (await res.json()) as ActionDto;
        if (!cancelled) setFresh(dto);
      } catch {
        if (!cancelled) setLoadError("网络错误，读取的是画布上的旧定义");
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target.action.id]);

  if (!ready) {
    return (
      <div className="ff-fade-in fixed inset-0 z-50 flex justify-end bg-black/30">
        <div className="flex h-full w-full max-w-3xl items-center justify-center bg-white text-sm text-zinc-400 shadow-xl">
          读取 Action 最新定义…
        </div>
      </div>
    );
  }

  const tags: Tag[] = target.action.tags;

  return (
    <>
      <ActionEditor
        initial={fresh}
        initialTags={tags}
        refCount={target.action.refCount}
        models={models}
        objectTypes={objectTypes}
        skills={skills}
        tools={tools}
        onClose={onClose}
        onSaved={(saved) => {
          if (saved) onSaved(saved);
          onClose();
        }}
        onRefresh={() => {
          /* 画布不维护列表分页，标签变化无需重拉 */
        }}
        onFork={async (created) => {
          await onForked(target.nodeId, created);
        }}
        forkLabel="复制为新 Action 并替换本节点"
        forkHint="只想改这一处时用它：把当前表单另存为新 Action，本节点改指新实体，原 Action 与其它工作流不受影响。"
      />
      {loadError && (
        <div className="fixed bottom-4 left-1/2 z-[70] -translate-x-1/2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 shadow">
          {loadError}
        </div>
      )}
    </>
  );
}
