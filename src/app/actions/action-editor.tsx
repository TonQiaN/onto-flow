"use client";

/**
 * Action 编辑抽屉：小标签页组织「基本信息 / 被引用 / 修订历史」。
 *
 * 两处复用同一个组件：Action 库列表页，以及工作流画布上双击节点弹出的检查器
 * （src/app/workflows/[id]/action-inspector.tsx）。组件不读任何页面级状态，
 * 全部靠 props 注入，画布侧只是多传一个 onFork。
 *
 * ADR-0004：编辑的是共享 Action，改动波及全部引用它的工作流，因此
 * ① 头部常驻「被 N 处引用」提示；
 * ② 端口有增删改时，保存前先 POST /api/references/impact 预览，
 *    brokenEdges 非空则弹确认框列出会失效的连线，确认后才提交；
 * ③ 提供 onFork 时底部出现「复制为新 Action」——把**当前表单内容**另存为新实体，
 *    共享的原 Action 一字不改，调用方负责把引用改指到新 Action。
 *
 * 预载技能与可见 Tool（ADR-0016）：`skills` / `tools` 是候选清单——库页传全库，画布传
 * 所在工作流的技能集与 Tool 集。编辑器不知道自己开在哪个工作流里，「候选为什么比库里少」
 * 由画布侧解释；这里只保证已选却不在候选里的项目仍然可见、可取消，保存工作流时服务端
 * 会按子集关系拒绝越界项。预载的正文整段进入会话首条消息，token 估算摆在开关旁边。
 */
import { useCallback, useState } from "react";
import type { PortKind, ReasoningEffort } from "@/components/canvas/node-model";
import {
  type ActionDto,
  FolderPicker,
  type FolderRef,
  KindBadge,
  type ModelRow,
  notifyFoldersChanged,
  type ObjectTypeRow,
  readError,
  ReferencesPanel,
  RevisionPanel,
  type SkillRow,
  type ToolRow,
} from "@/components/library";
import { MAX_REENTRIES } from "@/lib/graph";
import { estimateTokens } from "@/lib/workflow-settings";

interface PortDraft {
  key: string;
  name: string;
  objectTypeId: string;
  /** 输出端口写到工作区哪个文件（ADR-0008）；输入端口不用 */
  artifactPath: string;
  /** 输出端口所属的具名出口（ADR-0009）；留空表示没有分支 */
  exitName: string;
}

interface NextPort {
  direction: "input" | "output";
  name: string;
  objectTypeId: string;
}

interface BrokenEdge {
  workflowId: string;
  workflowName: string;
  nodeLabel: string;
  portName: string;
  reason: string;
}

type TabKey = "basic" | "refs" | "revisions";

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: "basic", label: "基本信息" },
  { key: "refs", label: "被引用" },
  { key: "revisions", label: "修订历史" },
];

function toDrafts(action: ActionDto | null, direction: "input" | "output"): PortDraft[] {
  if (!action) return [];
  return action.ports
    .filter((p) => p.direction === direction)
    .sort((a, b) => a.position - b.position)
    .map((p) => ({
      key: crypto.randomUUID(),
      name: p.name,
      objectTypeId: p.objectTypeId,
      artifactPath: p.artifactPath ?? "",
      exitName: p.exitName ?? "",
    }));
}

/** 端口集合的等价签名：只看方向 + 名称 + 对象类型，顺序无关 */
function portSignature(ports: NextPort[]): string {
  return ports
    .map((p) => `${p.direction}\0${p.name}\0${p.objectTypeId}`)
    .sort()
    .join("\x01");
}

/** 取一个未被占用的「…副本」名字（副本、副本 2、副本 3…） */
async function uniqueCopyName(base: string): Promise<string> {
  const taken = new Set<string>();
  try {
    const res = await fetch(`/api/actions?q=${encodeURIComponent(base)}&pageSize=100`, {
      cache: "no-store",
    });
    if (res.ok) {
      const body = (await res.json()) as { items?: Array<{ name?: string }> };
      for (const item of body.items ?? []) if (typeof item.name === "string") taken.add(item.name);
    }
  } catch {
    // 查不到就先按「副本」提交，撞名由服务端 409 兜底
  }
  for (let i = 1; i <= 200; i += 1) {
    const candidate = i === 1 ? `${base} 副本` : `${base} 副本 ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} 副本 ${Date.now()}`;
}

export function ActionEditor({
  initial,
  initialFolder,
  refCount,
  models,
  objectTypes,
  skills,
  tools,
  onClose,
  onSaved,
  onRefresh,
  onDefinitionRestored,
  onFork,
  forkLabel = "复制为新 Action",
  forkHint,
}: {
  initial: ActionDto | null;
  /** create 模式是页面传入的默认归属（当前选中文件夹），edit 模式是实体现有归属 */
  initialFolder: FolderRef | null;
  /** 列表页已算好的被引用次数，用于常驻影响面提示 */
  refCount: number;
  models: ModelRow[];
  objectTypes: ObjectTypeRow[];
  /** 预载技能的候选：库页传全库，画布传所在工作流的技能集 */
  skills: SkillRow[];
  /** 可见 Tool 的候选：库页传全库，画布传所在工作流的 Tool 集 */
  tools: ToolRow[];
  onClose: () => void;
  /** 保存成功。saved 是服务端回写的最新 DTO（解析失败时为 null） */
  onSaved: (saved: ActionDto | null) => void;
  onRefresh: () => void;
  /** 修订恢复后回传服务端最新定义；画布用它即时刷新引用节点 */
  onDefinitionRestored?: (restored: ActionDto) => void;
  /**
   * 传了才显示「复制为新 Action」。回调拿到的是刚创建好的副本 DTO，
   * 由调用方决定怎么改引用（画布：把本节点的 actionId 指过去并保存整图）。
   */
  onFork?: (created: ActionDto) => void | Promise<void>;
  forkLabel?: string;
  forkHint?: string;
}) {
  const [tab, setTab] = useState<TabKey>("basic");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [rule, setRule] = useState(initial?.rule ?? "");
  const [modelId, setModelId] = useState(initial?.modelId ?? models[0]?.id ?? "");
  const [effort, setEffort] = useState<ReasoningEffort>(initial?.reasoningEffort ?? "high");
  // 重入上限只在这个 Action 是回边目标时才起作用（ADR-0009）；0 表示不参与循环。
  const [maxReentries, setMaxReentries] = useState<number>(initial?.maxReentries ?? 0);
  const [onExhausted, setOnExhausted] = useState<"fail" | "accept">(initial?.onExhausted ?? "fail");
  const [inputPorts, setInputPorts] = useState<PortDraft[]>(() => toDrafts(initial, "input"));
  const [outputPorts, setOutputPorts] = useState<PortDraft[]>(() => toDrafts(initial, "output"));
  const [preloadSkillIds, setPreloadSkillIds] = useState<string[]>(initial?.preloadSkillIds ?? []);
  const [toolIds, setToolIds] = useState<string[]>(initial?.toolIds ?? []);
  const [folder, setFolder] = useState<FolderRef | null>(initialFolder);
  /** 保存前的端口基线：回滚后会随之更新，保证影响预览比对的是当前库里的定义 */
  const [baseline, setBaseline] = useState<NextPort[]>(() =>
    (initial?.ports ?? []).map((p) => ({
      direction: p.direction,
      name: p.name,
      objectTypeId: p.objectTypeId,
    })),
  );
  const [saving, setSaving] = useState(false);
  const [forking, setForking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState<BrokenEdge[] | null>(null);

  /** 回滚后把服务端最新定义拉回表单，避免用陈旧表单再保存一次把回滚覆盖掉 */
  const reloadFromServer = useCallback(async () => {
    if (!initial) return;
    try {
      const res = await fetch(`/api/actions/${initial.id}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const dto = (await res.json()) as ActionDto;
      setName(dto.name);
      setDescription(dto.description);
      setPrompt(dto.prompt);
      setRule(dto.rule);
      setModelId(dto.modelId);
      setEffort(dto.reasoningEffort);
      setMaxReentries(dto.maxReentries);
      setOnExhausted(dto.onExhausted);
      setInputPorts(toDrafts(dto, "input"));
      setOutputPorts(toDrafts(dto, "output"));
      setPreloadSkillIds(dto.preloadSkillIds);
      setToolIds(dto.toolIds);
      setBaseline(
        dto.ports.map((p) => ({
          direction: p.direction,
          name: p.name,
          objectTypeId: p.objectTypeId,
        })),
      );
      onDefinitionRestored?.(dto);
    } catch {
      // 拉取失败保持当前表单
    }
  }, [initial, onDefinitionRestored]);

  function validate(): string | null {
    if (!name.trim()) return "名称不能为空";
    if (!prompt.trim()) return "Prompt 不能为空";
    if (!modelId) return "请选择模型";
    if (!Number.isSafeInteger(maxReentries) || maxReentries < 0 || maxReentries > MAX_REENTRIES) {
      return `重入上限必须是 0 到 ${MAX_REENTRIES} 之间的整数`;
    }
    for (const [label, ports] of [
      ["输入", inputPorts],
      ["输出", outputPorts],
    ] as const) {
      const seen = new Set<string>();
      for (const p of ports) {
        const portName = p.name.trim();
        if (!portName) return `${label}端口的端口名不能为空`;
        if (!p.objectTypeId) return `${label}端口「${portName}」未选择对象类型`;
        if (seen.has(portName)) return `${label}端口名「${portName}」重复`;
        seen.add(portName);
      }
    }
    return null;
  }

  function buildPayload() {
    return {
      name: name.trim(),
      description,
      prompt,
      rule,
      modelId,
      reasoningEffort: effort,
      maxReentries,
      onExhausted,
      ports: [
        ...inputPorts.map((p, i) => ({
          direction: "input" as const,
          name: p.name.trim(),
          objectTypeId: p.objectTypeId,
          position: i,
        })),
        ...outputPorts.map((p, i) => ({
          direction: "output" as const,
          name: p.name.trim(),
          objectTypeId: p.objectTypeId,
          position: i,
          artifactPath: p.artifactPath.trim(),
          exitName: p.exitName.trim(),
        })),
      ],
      preloadSkillIds,
      toolIds,
    };
  }

  /** 把当前选中的文件夹指派给某个 Action（新建/复制后补挂） */
  async function assignFolder(entityId: string) {
    if (!folder) return;
    try {
      await fetch("/api/folders/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityKind: "action",
          entityId,
          folderId: folder.id,
        }),
      });
      notifyFoldersChanged();
    } catch {
      // 归属没挂上不影响实体本身，静默即可
    }
  }

  /**
   * 「复制为新 Action」：把当前表单内容另存为新实体，原 Action 一字不改。
   * 名字自动加「副本」后缀并去重；撞名（409）时顺延重试。
   */
  async function fork() {
    if (!onFork) return;
    const problem = validate();
    if (problem) {
      setError(problem);
      setTab("basic");
      return;
    }
    setForking(true);
    setError(null);
    try {
      const payload = buildPayload();
      const base = payload.name;
      let name = await uniqueCopyName(base);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await fetch("/api/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, name }),
        });
        if (res.status === 409) {
          name = `${base} 副本 ${attempt + 2}`;
          continue;
        }
        if (!res.ok) {
          setError(`复制失败：${await readError(res)}`);
          return;
        }
        const created = (await res.json()) as ActionDto;
        if (folder) await assignFolder(created.id);
        await onFork(created);
        return;
      }
      setError("复制失败：名称一直冲突，请先改个名字再试");
    } catch {
      setError("网络错误，复制失败");
    } finally {
      setForking(false);
    }
  }

  /** 真正提交（影响确认之后走的也是这里） */
  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(initial ? `/api/actions/${initial.id}` : "/api/actions", {
        method: initial ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      if (!res.ok) {
        setError(await readError(res));
        // 关掉影响确认框，让抽屉底部的错误信息可见
        setImpact(null);
        return;
      }
      // 服务端回写的最新 DTO：画布靠它把节点端口刷新到最新
      const saved = (await res.json().catch(() => null)) as ActionDto | null;
      if (!initial && folder && saved?.id) {
        await assignFolder(saved.id);
      }
      setImpact(null);
      onSaved(saved);
    } catch {
      setError("网络错误，保存失败");
      setImpact(null);
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    const problem = validate();
    if (problem) {
      setError(problem);
      setTab("basic");
      return;
    }
    setError(null);

    const nextPorts: NextPort[] = buildPayload().ports.map((p) => ({
      direction: p.direction,
      name: p.name,
      objectTypeId: p.objectTypeId,
    }));

    // 端口无增删改则不必预览；新建的 Action 也不可能有既存连线
    const changed = initial !== null && portSignature(nextPorts) !== portSignature(baseline);
    if (!changed) {
      await submit();
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/references/impact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "action",
          id: initial.id,
          nextPorts,
        }),
      });
      if (!res.ok) {
        setError(`影响预览失败：${await readError(res)}（未保存，请重试）`);
        return;
      }
      const body = (await res.json()) as { brokenEdges?: BrokenEdge[] };
      const broken = body.brokenEdges ?? [];
      if (broken.length > 0) {
        setImpact(broken);
        return;
      }
    } catch {
      setError("网络错误，影响预览失败（未保存，请重试）");
      return;
    } finally {
      setSaving(false);
    }

    await submit();
  }

  function toggle(ids: string[], setIds: (v: string[]) => void, id: string) {
    setIds(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  }

  const skillById = new Map(skills.map((s) => [s.id, s]));
  const toolById = new Map(tools.map((t) => [t.id, t]));
  /** 已选却不在候选里：库里已删除，或从画布打开时越出了工作流集合；仍显示以便取消 */
  const strayPreloadIds = preloadSkillIds.filter((id) => !skillById.has(id));
  const strayToolIds = toolIds.filter((id) => !toolById.has(id));
  const preloadTokens = preloadSkillIds.reduce(
    (sum, id) => sum + estimateTokens(skillById.get(id)?.content ?? ""),
    0,
  );

  return (
    <div className="ff-fade-in fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="ff-slide-in-right flex h-full w-full max-w-3xl flex-col bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
          <div className="flex items-baseline gap-3">
            <h2 className="text-base font-semibold text-zinc-900">
              {initial ? "编辑 Action" : "新建 Action"}
            </h2>
            {initial && (
              <button
                type="button"
                onClick={() => setTab("refs")}
                className="text-xs text-zinc-500 underline decoration-dotted hover:text-zinc-800"
              >
                {refCount > 0
                  ? `此 Action 被 ${refCount} 处引用，改动会同时生效`
                  : "尚未被任何工作流引用"}
              </button>
            )}
          </div>
          <button onClick={onClose} className="text-sm text-zinc-400 hover:text-zinc-600">
            关闭
          </button>
        </div>

        {initial && (
          <div className="flex gap-1 border-b border-zinc-200 px-6">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                  tab === t.key
                    ? "border-zinc-900 text-zinc-900"
                    : "border-transparent text-zinc-500 hover:text-zinc-800"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {tab === "basic" && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-zinc-700">名称</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="如：简历硬性条件审查"
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-zinc-700">描述</span>
                  <input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="一句话说明这个 Action 做什么"
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
                  />
                </label>
              </div>

              <div>
                <span className="mb-1 block text-sm font-medium text-zinc-700">文件夹</span>
                <FolderPicker
                  kind="action"
                  entityId={initial?.id ?? ""}
                  value={folder}
                  onChange={(next) => {
                    setFolder(next);
                    if (initial) onRefresh();
                  }}
                />
                {!initial && (
                  <p className="mt-1 text-xs text-zinc-400">
                    新建的 Action 保存后才会真正归入文件夹。
                  </p>
                )}
              </div>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  Prompt（任务描述，可用 {"{{输入端口名}}"} 占位符）
                </span>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={10}
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs leading-5 focus:border-zinc-500 focus:outline-none"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-zinc-700">
                  Rule（执行时必须遵守的规则，注入上下文）
                </span>
                <textarea
                  value={rule}
                  onChange={(e) => setRule(e.target.value)}
                  rows={5}
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs leading-5 focus:border-zinc-500 focus:outline-none"
                />
              </label>

              <div className="grid grid-cols-2 gap-4">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-zinc-700">模型</span>
                  <select
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
                  >
                    <option value="">选择模型…</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-zinc-700">思考强度</span>
                  <select
                    value={effort}
                    onChange={(e) => setEffort(e.target.value as ReasoningEffort)}
                    className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
                  >
                    <option value="off">off（关闭）</option>
                    <option value="low">low（低）</option>
                    <option value="high">high（高）</option>
                    <option value="max">max（最大）</option>
                  </select>
                </label>
              </div>

              <PortListEditor
                title="输入端口"
                ports={inputPorts}
                setPorts={setInputPorts}
                objectTypes={objectTypes}
              />
              <PortListEditor
                title="输出端口"
                ports={outputPorts}
                setPorts={setOutputPorts}
                objectTypes={objectTypes}
                isOutput
              />

              <div>
                <span className="mb-1 block text-sm font-medium text-zinc-700">循环重入</span>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={MAX_REENTRIES}
                    value={maxReentries}
                    onChange={(e) => setMaxReentries(Number(e.target.value))}
                    className="w-20 rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-zinc-500 focus:outline-none"
                  />
                  <select
                    value={onExhausted}
                    onChange={(e) => setOnExhausted(e.target.value as "fail" | "accept")}
                    className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:border-zinc-500 focus:outline-none"
                  >
                    <option value="fail">次数耗尽则判失败</option>
                    <option value="accept">次数耗尽则接受最后一轮</option>
                  </select>
                </div>
                <p className="mt-1 text-xs text-zinc-400">
                  只有被回边指向的 Action 需要它。0 表示不可重入，画布上就连不出回边； 上限{" "}
                  {MAX_REENTRIES}——一轮开一个会话，轨迹面板读不下更多。
                </p>
              </div>
              {initial && refCount > 0 && (
                <p className="text-xs text-zinc-400">
                  端口改名、删除或换类型会让引用本 Action 的工作流连线失效，保存前会先给出影响预览。
                </p>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="mb-1 block text-sm font-medium text-zinc-700">预载技能</span>
                  <p className="mb-1.5 text-xs leading-5 text-zinc-500">
                    会话开始时以 <code className="font-mono">/技能</code>{" "}
                    注入，等同于在命令行敲斜杠命令；
                    正文整段进入每个会话的首条消息，是真实成本。只能预载所在工作流技能集里的技能，
                    技能集里其余的由模型看描述自行加载。
                  </p>
                  <div className="max-h-52 space-y-0.5 overflow-y-auto rounded-md border border-zinc-300 p-2">
                    {skills.length === 0 && strayPreloadIds.length === 0 ? (
                      <p className="px-1.5 py-1 text-xs text-zinc-400">没有可预载的技能</p>
                    ) : (
                      <>
                        {skills.map((s) => (
                          <label
                            key={s.id}
                            className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-sm hover:bg-zinc-50"
                          >
                            <input
                              type="checkbox"
                              checked={preloadSkillIds.includes(s.id)}
                              onChange={() => toggle(preloadSkillIds, setPreloadSkillIds, s.id)}
                              className="mt-1"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="text-zinc-800">{s.name}</span>
                              {s.description && (
                                <span className="ml-2 text-xs text-zinc-400">{s.description}</span>
                              )}
                            </span>
                            <span className="shrink-0 pt-0.5 text-xs text-zinc-400">
                              约 {estimateTokens(s.content)} token
                            </span>
                          </label>
                        ))}
                        {strayPreloadIds.map((id) => (
                          <label
                            key={id}
                            className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-sm text-amber-700 hover:bg-amber-50"
                            title={id}
                          >
                            <input
                              type="checkbox"
                              checked
                              onChange={() => toggle(preloadSkillIds, setPreloadSkillIds, id)}
                              className="mt-1"
                            />
                            <span className="min-w-0">
                              不在候选里的技能（{id.slice(0, 8)}…）：不在所在工作流的技能集里，
                              或已从库中删除；取消勾选或先去工作流设置里加入
                            </span>
                          </label>
                        ))}
                      </>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-zinc-400">
                    预载 {preloadSkillIds.length} 个，合计约 {preloadTokens} token / 会话
                  </p>
                </div>
                <div>
                  <span className="mb-1 block text-sm font-medium text-zinc-700">可见 Tool</span>
                  <p className="mb-1.5 text-xs leading-5 text-zinc-500">
                    只有勾选的 Tool 在本 Action 的会话里可见、可调用；所在工作流 Tool
                    集里其余的对它隐藏。 只能勾选 Tool 集里的 Tool。
                  </p>
                  <div className="max-h-52 space-y-0.5 overflow-y-auto rounded-md border border-zinc-300 p-2">
                    {tools.length === 0 && strayToolIds.length === 0 ? (
                      <p className="px-1.5 py-1 text-xs text-zinc-400">没有可见的 Tool 候选</p>
                    ) : (
                      <>
                        {tools.map((t) => (
                          <label
                            key={t.id}
                            className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-sm hover:bg-zinc-50"
                          >
                            <input
                              type="checkbox"
                              checked={toolIds.includes(t.id)}
                              onChange={() => toggle(toolIds, setToolIds, t.id)}
                              className="mt-1"
                            />
                            <span className="min-w-0">
                              <span className="text-zinc-800">{t.name}</span>
                              <span className="ml-2 font-mono text-xs text-zinc-500">
                                {t.publicName}
                              </span>
                              {t.description && (
                                <span className="ml-2 text-xs text-zinc-400">{t.description}</span>
                              )}
                            </span>
                          </label>
                        ))}
                        {strayToolIds.map((id) => (
                          <label
                            key={id}
                            className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-sm text-amber-700 hover:bg-amber-50"
                            title={id}
                          >
                            <input
                              type="checkbox"
                              checked
                              onChange={() => toggle(toolIds, setToolIds, id)}
                              className="mt-1"
                            />
                            <span className="min-w-0">
                              不在候选里的 Tool（{id.slice(0, 8)}…）：不在所在工作流的 Tool 集里，
                              或已从库中删除；取消勾选或先去工作流设置里加入
                            </span>
                          </label>
                        ))}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}

          {tab === "refs" && initial && <ReferencesPanel kind="action" id={initial.id} />}

          {tab === "revisions" && initial && (
            <RevisionPanel
              kind="action"
              id={initial.id}
              onRestored={() => {
                void reloadFromServer();
                onRefresh();
              }}
            />
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-zinc-200 px-6 py-4">
          {error ? (
            <p className="mr-auto text-sm text-red-600">{error}</p>
          ) : (
            forkHint &&
            onFork &&
            tab === "basic" && <p className="mr-auto max-w-md text-xs text-zinc-400">{forkHint}</p>
          )}
          {onFork && tab === "basic" && (
            <button
              type="button"
              onClick={() => void fork()}
              disabled={saving || forking}
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50"
            >
              {forking ? "复制中…" : forkLabel}
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
          >
            {tab === "basic" ? "取消" : "关闭"}
          </button>
          {tab === "basic" && (
            <button
              onClick={() => void save()}
              disabled={saving || forking}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          )}
        </div>
      </div>

      {impact && (
        <ImpactDialog
          broken={impact}
          saving={saving}
          onCancel={() => setImpact(null)}
          onConfirm={() => void submit()}
        />
      )}
    </div>
  );
}

/** 端口破坏性改动的确认框：列出会失效的连线，确认后才提交 */
function ImpactDialog({
  broken,
  saving,
  onCancel,
  onConfirm,
}: {
  broken: BrokenEdge[];
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const workflowCount = new Set(broken.map((b) => b.workflowId)).size;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        e.stopPropagation();
        if (!saving) onCancel();
      }}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-zinc-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-zinc-200 px-5 py-4">
          <h3 className="text-base font-semibold text-zinc-900">端口改动会破坏既有连线</h3>
          <p className="mt-1 text-sm text-red-600">
            将影响 {workflowCount} 个工作流的 {broken.length} 条连线。
          </p>
        </div>
        <ul className="max-h-72 divide-y divide-zinc-100 overflow-y-auto px-5">
          {broken.map((b, i) => (
            <li key={`${b.workflowId}:${b.portName}:${i}`} className="py-2.5">
              <p className="text-sm text-zinc-800">
                {b.workflowName}
                <span className="mx-1.5 text-zinc-300">·</span>
                <span className="text-zinc-600">节点 {b.nodeLabel}</span>
              </p>
              <p className="mt-0.5 text-xs text-zinc-500">{b.reason}</p>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-3 border-t border-zinc-200 px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={saving}
            className="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50"
          >
            {saving ? "保存中…" : "仍然保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PortListEditor({
  title,
  ports,
  setPorts,
  objectTypes,
  isOutput = false,
}: {
  title: string;
  ports: PortDraft[];
  setPorts: (v: PortDraft[]) => void;
  objectTypes: ObjectTypeRow[];
  /** 输出端口要多填产物路径与出口；输入端口两者都不适用 */
  isOutput?: boolean;
}) {
  const typeById = new Map(objectTypes.map((t) => [t.id, t]));

  function update(key: string, patch: Partial<PortDraft>) {
    setPorts(ports.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm font-medium text-zinc-700">{title}</span>
        <button
          onClick={() =>
            setPorts([
              ...ports,
              {
                key: crypto.randomUUID(),
                name: "",
                objectTypeId: "",
                artifactPath: "",
                exitName: "",
              },
            ])
          }
          className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-50"
        >
          + 添加
        </button>
      </div>
      {ports.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-300 px-3 py-2 text-xs text-zinc-400">
          （无{title}）
        </p>
      ) : (
        <div className="space-y-2">
          {ports.map((p) => {
            const selected = typeById.get(p.objectTypeId);
            const kind: PortKind | null = selected ? selected.kind : null;
            return (
              <div key={p.key} className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <input
                    value={p.name}
                    onChange={(e) => update(p.key, { name: e.target.value })}
                    placeholder="端口名"
                    className="w-44 rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-zinc-500 focus:outline-none"
                  />
                  <select
                    value={p.objectTypeId}
                    onChange={(e) => update(p.key, { objectTypeId: e.target.value })}
                    className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:border-zinc-500 focus:outline-none"
                  >
                    <option value="">选择对象类型…</option>
                    {objectTypes.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  {kind ? (
                    <KindBadge kind={kind} />
                  ) : (
                    <span className="inline-flex shrink-0 items-center rounded border border-zinc-200 px-1.5 py-0.5 font-mono text-xs text-zinc-300">
                      —
                    </span>
                  )}
                  <button
                    onClick={() => setPorts(ports.filter((x) => x.key !== p.key))}
                    className="shrink-0 rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                    title="删除此端口"
                  >
                    删除
                  </button>
                </div>
                {isOutput && (
                  <div className="flex items-center gap-2 pl-1">
                    <input
                      value={p.artifactPath}
                      onChange={(e) => update(p.key, { artifactPath: e.target.value })}
                      placeholder="产物路径，如 draft.md"
                      className="w-56 rounded-md border border-zinc-300 px-3 py-1 font-mono text-xs focus:border-zinc-500 focus:outline-none"
                    />
                    <input
                      value={p.exitName}
                      onChange={(e) => update(p.key, { exitName: e.target.value })}
                      placeholder="出口名（留空＝无分支）"
                      className="w-52 rounded-md border border-zinc-300 px-3 py-1 text-xs focus:border-zinc-500 focus:outline-none"
                    />
                    <span className="text-[11px] leading-4 text-zinc-400">
                      实质内容写进产物文件；同名出口的端口一起生效
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
