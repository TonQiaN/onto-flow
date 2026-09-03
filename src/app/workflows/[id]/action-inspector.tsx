"use client";

/**
 * 画布上双击 Action 节点弹出的检查器（ADR-0004）。
 *
 * 它本身几乎没有 UI —— 编辑器复用 Action 库的同一个组件
 * （src/app/actions/action-editor.tsx，内含常驻引用提示、被引用面板、
 * 端口影响预览、修订历史四件套），这里只负责：
 * ① 打开时把该 Action 的最新定义从服务端拉一遍（画布上的清单可能已经陈旧）；
 * ② 注入画布语境的 onFork：「复制为新 Action 并替换本节点」；
 * ③ 把预载技能 / 可见 Tool 的候选收窄到所在工作流的技能集与 Tool 集（ADR-0016）。
 *    Action 是共享库实体：从库页打开时候选是全库，从画布打开只列本工作流集合里的项目，
 *    不在集合里的要先去工作流设置里加入。Action 已选却越出集合的项目在提示条里点名——
 *    它们在编辑器里以琥珀色行保留、只能取消勾选，保存整图时服务端会以 400 拒绝。
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ActionEditor } from "@/app/actions/action-editor";
import { readError } from "@/components/library";
import {
  outsideSet,
  pickBySet,
  type ActionDto,
  type ActionItem,
  type ModelRow,
  type ObjectTypeRow,
  type SkillRow,
  type ToolRow,
  type WorkflowSets,
} from "./types";

export interface InspectorTarget {
  /** 被双击的画布节点 */
  nodeId: string;
  action: ActionItem;
}

export function ActionInspector({
  target,
  workflowId,
  sets,
  models,
  objectTypes,
  skills,
  tools,
  onClose,
  onSaved,
  onForked,
}: {
  target: InspectorTarget;
  workflowId: string;
  /** 所在工作流的技能集与 Tool 集：候选只从这两个集合里出 */
  sets: WorkflowSets;
  models: ModelRow[];
  objectTypes: ObjectTypeRow[];
  /** 全库清单；这里按 sets 收窄后再交给编辑器 */
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

  const candidateSkills = useMemo(() => pickBySet(skills, sets.skillIds), [skills, sets.skillIds]);
  const candidateTools = useMemo(() => pickBySet(tools, sets.toolIds), [tools, sets.toolIds]);
  /** 已预载 / 已可见却不在工作流集合里的项目名：库页改出来的越界，画布上只能提示 */
  const strayPreloads = useMemo(() => {
    const nameById = new Map(skills.map((s) => [s.id, s.name]));
    return outsideSet(fresh.preloadSkillIds, sets.skillIds).map((id) => nameById.get(id) ?? id);
  }, [fresh.preloadSkillIds, sets.skillIds, skills]);
  const strayTools = useMemo(() => {
    const nameById = new Map(tools.map((t) => [t.id, t.name]));
    return outsideSet(fresh.toolIds, sets.toolIds).map((id) => nameById.get(id) ?? id);
  }, [fresh.toolIds, sets.toolIds, tools]);

  if (!ready) {
    return (
      <div className="ff-fade-in fixed inset-0 z-50 flex justify-end bg-black/30">
        <div className="flex h-full w-full max-w-3xl items-center justify-center bg-white text-sm text-zinc-400 shadow-xl">
          读取 Action 最新定义…
        </div>
      </div>
    );
  }

  const settingsHref = `/workflows/${encodeURIComponent(workflowId)}/settings`;

  return (
    <>
      <ActionEditor
        initial={fresh}
        initialFolder={target.action.folder}
        refCount={target.action.refCount}
        models={models}
        objectTypes={objectTypes}
        skills={candidateSkills}
        tools={candidateTools}
        onClose={onClose}
        onSaved={(saved) => {
          if (saved) onSaved(saved);
          onClose();
        }}
        onDefinitionRestored={onSaved}
        onRefresh={() => {
          /* 画布不维护列表分页，归属变化无需重拉 */
        }}
        onFork={async (created) => {
          await onForked(target.nodeId, created);
        }}
        forkLabel="复制为新 Action 并替换本节点"
        forkHint="只想改这一处时用它：把当前表单另存为新 Action，本节点改指新实体，原 Action 与其它工作流不受影响。"
      />

      {/*
        候选说明条：贴在抽屉底栏上方。编辑器本身不知道自己开在哪个工作流里，
        「候选为什么比库里少」只能由画布这一侧解释。层级压在抽屉（z-50）之上、
        编辑器的端口影响确认框（z-60）之下。
      */}
      <div
        data-testid="inspector-candidate-hint"
        className="pointer-events-none fixed inset-x-0 bottom-[68px] z-[55] flex justify-end"
      >
        <div
          className={`pointer-events-auto w-full max-w-3xl border-t px-6 py-2 text-xs leading-5 ${
            strayPreloads.length > 0 || strayTools.length > 0
              ? "border-amber-200 bg-amber-50 text-amber-800"
              : "border-zinc-200 bg-zinc-50 text-zinc-600"
          }`}
        >
          <p>
            预载技能与可见 Tool 的候选只列出本工作流技能集（{sets.skillIds.length}）与 Tool 集（
            {sets.toolIds.length}）里的项目；不在集合里的要先去
            <Link
              href={settingsHref}
              className="mx-1 underline decoration-dotted underline-offset-2 hover:text-zinc-900"
            >
              工作流设置
            </Link>
            里加入。
          </p>
          {strayPreloads.length > 0 && (
            <p>
              本 Action 预载的「{strayPreloads.join("」「")}」不在技能集里：保存工作流会被拒绝，
              请把它们加进技能集，或在 Action 库里取消预载。
            </p>
          )}
          {strayTools.length > 0 && (
            <p>
              本 Action 可见的 Tool「{strayTools.join("」「")}」不在 Tool 集里：保存工作流会被拒绝，
              请把它们加进 Tool 集，或在 Action 库里取消勾选。
            </p>
          )}
        </div>
      </div>

      {loadError && (
        <div className="fixed bottom-4 left-1/2 z-[70] -translate-x-1/2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 shadow">
          {loadError}
        </div>
      )}
    </>
  );
}
