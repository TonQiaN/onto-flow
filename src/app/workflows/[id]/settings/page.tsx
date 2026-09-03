"use client";

/**
 * 工作流设置页——三层设置的中间层（ADR-0016）：工作流级指令、五个插件开关的覆盖、
 * MCP 子集、技能集与 Tool 集。上层声明、下层收窄：开关的「继承」显示全局值；MCP 只能从
 * 全局登记表里选；Action 的预载 ⊆ 技能集、可见 Tool ⊆ Tool 集由服务端在保存整图时校验
 * （400 指名 Action 与技能 / Tool），这里只在勾选框旁标出画布上哪些 Action 正预载 / 看见它，
 * 提醒取消勾选会让保存被拒。
 *
 * 保存只发本页字段（指令、开关覆盖、MCP 子集、两个集合），不发图：图整体缺省的 PUT 由服务端
 * 沿用库里当前的图做 ⊆ 校验与修订，画布在另一个标签页里的保存不会被这里读来的旧图覆盖。
 * GET 带回的 issues（图校验 + ⊆ 违反）在页顶列出：越界的预载 / 可见项要么勾回集合、要么去改 Action。
 * 与全局设置同一条纪律：改动在下一次运行生效，在跑的运行持有受理时的快照。
 */
import { fetchAllPages } from "@/components/library/fetch-all-pages";
import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import { readError } from "@/components/library";
import {
  COMPOSITION_TOGGLE_KEYS,
  DEFAULT_COMPOSITION_TOGGLES,
  effectiveToggles,
  estimateTokens,
  type CompositionToggleKey,
  type CompositionToggles,
  COMPOSITION_TOGGLE_LABELS,
  WORKFLOW_INSTRUCTIONS_MAX_BYTES,
} from "@/lib/workflow-settings";
import {
  actionNamesByEntity,
  fromToggleChoice,
  outsideSet,
  pruneToggles,
  skillTokenEstimate,
  toggleChoice,
  toggleId,
  toolTokenEstimate,
  type ActionDto,
  type NodeDto,
  type SkillRow,
  type ToggleChoice,
  type ToolRow,
  type WorkflowDetail,
} from "../types";

/** 全局设置里本页要看的两样：开关默认值（供「继承」显示）与 MCP 登记表 */
interface GlobalView {
  toggles: CompositionToggles;
  mcpServers: Array<{ name: string; enabled: boolean; transport: string }>;
}

const DEFAULT_GLOBAL: GlobalView = {
  toggles: { ...DEFAULT_COMPOSITION_TOGGLES },
  mcpServers: [],
};

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export default function WorkflowSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <WorkflowSettingsEditor workflowId={id} />;
}

function WorkflowSettingsEditor({ workflowId }: { workflowId: string }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 库清单或全局设置读不到时的旁注：页面照常可用，只是候选或「继承」值不全 */
  const [notes, setNotes] = useState<string[]>([]);
  /** GET 带回的图校验与 ⊆ 违反：受理会 422，保存整图会 400；这里列出来让人当场修 */
  const [issues, setIssues] = useState<string[]>([]);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nodes, setNodes] = useState<NodeDto[]>([]);
  const [instructions, setInstructions] = useState("");
  const [toggles, setToggles] = useState<Partial<CompositionToggles>>({});
  const [mcpServers, setMcpServers] = useState<string[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [toolIds, setToolIds] = useState<string[]>([]);

  const [global, setGlobal] = useState<GlobalView>(DEFAULT_GLOBAL);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [actions, setActions] = useState<ActionDto[]>([]);

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const applyDetail = useCallback((wf: WorkflowDetail) => {
    setName(wf.workflow.name);
    setDescription(wf.workflow.description ?? "");
    setNodes(wf.nodes ?? []);
    setInstructions(wf.workflow.instructions ?? "");
    setToggles(pruneToggles(wf.workflow.settings?.toggles ?? {}));
    setMcpServers(wf.workflow.settings?.mcpServers ?? []);
    setSkillIds(wf.workflow.skillIds ?? []);
    setToolIds(wf.workflow.toolIds ?? []);
    setIssues((wf.issues ?? []).map((issue) => issue.message));
  }, []);

  // ---------- 加载 ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 库列表是分页信封（DESIGN-V2 第一节），集合要全量，翻到底而不是只取第一页
        const [wfRes, settingsRes, skillRes, toolRes, actRes] = await Promise.all([
          fetch(`/api/workflows/${encodeURIComponent(workflowId)}`, { cache: "no-store" }),
          fetch("/api/settings", { cache: "no-store" }),
          fetchAllPages<SkillRow>("/api/skills?sort=name_asc", { cache: "no-store" }),
          fetchAllPages<ToolRow>("/api/tools?sort=name_asc", { cache: "no-store" }),
          fetchAllPages<ActionDto>("/api/actions?sort=name_asc", { cache: "no-store" }),
        ]);
        if (!wfRes.ok) throw new Error(await readError(wfRes));
        const wf = (await wfRes.json()) as WorkflowDetail;

        const nextNotes: string[] = [];
        let nextGlobal = DEFAULT_GLOBAL;
        if (settingsRes.ok) {
          const doc = (await settingsRes.json()) as {
            toggles?: Partial<CompositionToggles>;
            mcpServers?: Array<{ name: string; enabled?: boolean; transport?: string }>;
          };
          nextGlobal = {
            toggles: { ...DEFAULT_COMPOSITION_TOGGLES, ...pruneToggles(doc.toggles ?? {}) },
            mcpServers: (doc.mcpServers ?? []).map((server) => ({
              name: server.name,
              enabled: server.enabled !== false,
              transport: server.transport ?? "stdio",
            })),
          };
        } else {
          nextNotes.push("全局设置读取失败：「继承」显示的是出厂默认值，MCP 登记表为空。");
        }
        const skillRows = skillRes.ok ? skillRes.items : [];
        if (!skillRes.ok)
          nextNotes.push("Skill 库读取失败，技能集清单为空；已有集合保存时原样保留。");
        const toolRows = toolRes.ok ? toolRes.items : [];
        if (!toolRes.ok)
          nextNotes.push("Tool 库读取失败，Tool 集清单为空；已有集合保存时原样保留。");
        const actionRows = actRes.ok ? actRes.items : [];
        if (!actRes.ok)
          nextNotes.push("Action 库读取失败，无法标出画布上哪些 Action 在预载 / 使用集合项。");
        if (cancelled) return;

        applyDetail(wf);
        setGlobal(nextGlobal);
        setSkills(skillRows);
        setTools(toolRows);
        setActions(actionRows);
        setNotes(nextNotes);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflowId, applyDetail]);

  // 有未保存改动时离开页面给出确认
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const markDirty = useCallback(() => setDirty(true), []);

  // ---------- 派生 ----------
  const effective = useMemo(
    () => effectiveToggles(global.toggles, toggles),
    [global.toggles, toggles],
  );
  const actionById = useMemo(() => new Map(actions.map((a) => [a.id, a])), [actions]);
  const preloadedBy = useMemo(
    () => actionNamesByEntity(nodes, actionById, "preloadSkillIds"),
    [nodes, actionById],
  );
  const visibleTo = useMemo(
    () => actionNamesByEntity(nodes, actionById, "toolIds"),
    [nodes, actionById],
  );
  /** 子集里登记表没有的名字：受理时静默忽略，这里列出来让人能把它勾掉 */
  const unregisteredMcp = useMemo(
    () =>
      outsideSet(
        mcpServers,
        global.mcpServers.map((s) => s.name),
      ),
    [mcpServers, global.mcpServers],
  );
  const instructionBytes = utf8Bytes(instructions);
  const instructionTooLong = instructionBytes > WORKFLOW_INSTRUCTIONS_MAX_BYTES;

  // ---------- 保存 ----------
  async function save() {
    if (instructionTooLong) {
      setError("工作流指令不能超过 64 KiB");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // 只发设置与集合：图整体缺省时服务端沿用库里当前的图，画布并发保存的图不会被这里
      // 读来的旧图覆盖（评审指出的读-改-写竞争）。
      const res = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instructions,
          settings: { toggles: pruneToggles(toggles), mcpServers },
          skillIds,
          toolIds,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | (WorkflowDetail & { error?: string })
        | null;
      if (!res.ok) {
        setError(body?.error ?? "保存失败");
        return;
      }
      if (body?.workflow) applyDetail(body);
      setDirty(false);
      setSavedAt(new Date());
    } catch {
      setError("网络错误，保存失败");
    } finally {
      setSaving(false);
    }
  }

  // ---------- 渲染 ----------
  if (loading) {
    return <p className="p-8 text-sm text-zinc-400">加载工作流设置…</p>;
  }
  if (loadError) {
    return (
      <div className="p-8">
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError}
        </div>
        <Link
          href="/workflows"
          className="mt-4 inline-block text-sm text-zinc-500 underline hover:text-zinc-800"
        >
          返回工作流列表
        </Link>
      </div>
    );
  }

  const canvasHref = `/workflows/${encodeURIComponent(workflowId)}`;

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <nav className="flex items-center gap-2 text-sm text-zinc-500">
        <Link href="/workflows" className="hover:text-zinc-900">
          工作流
        </Link>
        <span className="text-zinc-300">/</span>
        <Link href={canvasHref} className="max-w-xs truncate hover:text-zinc-900" title="打开画布">
          {name || "（未命名）"}
        </Link>
        <span className="text-zinc-300">/</span>
        <span className="text-zinc-700">设置</span>
      </nav>
      <div className="mt-2 flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-semibold text-zinc-900">工作流设置</h1>
        <Link
          href={canvasHref}
          className="shrink-0 text-sm text-zinc-500 underline decoration-dotted underline-offset-2 hover:text-zinc-900"
        >
          回到画布
        </Link>
      </div>
      <p className="mt-1 text-sm text-zinc-500">
        这一层声明本工作流有什么：共同指令、插件开关的覆盖、启用的 MCP 子集、技能集与 Tool 集。
        全局设置给默认值，Action 只在技能集里选预载、在 Tool 集里选可见。改动在<b>下一次运行</b>
        生效， 在跑的运行持有受理时的快照。
      </p>
      {description && <p className="mt-1 text-xs text-zinc-400">{description}</p>}

      {notes.length > 0 && (
        <ul className="mt-4 space-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {issues.length > 0 && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          <p className="font-medium">
            受理前要处理的问题（运行会被拒绝，画布保存整图也会被拒绝）：
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 指令 */}
      <Section
        title="工作流指令（AGENTS.md）"
        hint="原样写进运行工作区的 AGENTS.md，本工作流每个 Action 的每个会话都会读到；留空时只写一行工作流名。必须遵守的东西放这里或 Action 的规则里，技能只是可用能力。"
      >
        <textarea
          value={instructions}
          onChange={(e) => {
            setInstructions(e.target.value);
            markDirty();
          }}
          rows={10}
          placeholder={`# ${name || "工作流名"}\n\n（写给本工作流全部 Action 的共同约定）`}
          className={`w-full rounded-md border px-3 py-2 font-mono text-xs leading-5 focus:outline-none ${
            instructionTooLong
              ? "border-red-300 focus:border-red-500"
              : "border-zinc-300 focus:border-zinc-500"
          }`}
        />
        <p className={`text-xs ${instructionTooLong ? "text-red-600" : "text-zinc-400"}`}>
          ≈ {estimateTokens(instructions).toLocaleString("zh-CN")} tokens ·{" "}
          {instructionBytes.toLocaleString("zh-CN")} /{" "}
          {WORKFLOW_INSTRUCTIONS_MAX_BYTES.toLocaleString("zh-CN")} 字节
          {instructionTooLong && "，超过上限"}
        </p>
      </Section>

      {/* 插件开关 */}
      <Section
        title="插件开关"
        hint="只有这五组能按工作流切换。「继承」跟随全局设置里的默认值；开或关是本工作流的覆盖，受理时合成生效开关并冻结进运行快照。"
      >
        <div className="overflow-hidden rounded-md border border-zinc-200">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-1.5 font-medium">开关</th>
                <th className="w-52 px-3 py-1.5 font-medium">本工作流</th>
                <th className="w-20 px-3 py-1.5 font-medium">生效</th>
              </tr>
            </thead>
            <tbody>
              {COMPOSITION_TOGGLE_KEYS.map((key) => (
                <ToggleRow
                  key={key}
                  toggleKey={key}
                  choice={toggleChoice(toggles[key])}
                  globalValue={global.toggles[key]}
                  effectiveValue={effective[key]}
                  onChange={(choice) => {
                    const value = fromToggleChoice(choice);
                    setToggles((prev) => {
                      const next = { ...prev };
                      if (value === undefined) delete next[key];
                      else next[key] = value;
                      return next;
                    });
                    markDirty();
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* MCP 子集 */}
      <Section
        title="MCP 服务器"
        hint="从全局登记表里选本工作流要接的服务器。只有全局启用且在这里勾选的才会进入运行的组合；全局停用的服务器即使勾了也不生效。"
        action={
          <Link
            href="/settings"
            className="text-xs text-zinc-500 underline decoration-dotted underline-offset-2 hover:text-zinc-900"
          >
            管理登记表
          </Link>
        }
      >
        {global.mcpServers.length === 0 && unregisteredMcp.length === 0 ? (
          <Empty>（全局还没有登记任何 MCP 服务器）</Empty>
        ) : (
          <div className="space-y-0.5 rounded-md border border-zinc-200 p-2">
            {global.mcpServers.map((server) => (
              <label
                key={server.name}
                className="flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 text-sm hover:bg-zinc-50"
              >
                <input
                  type="checkbox"
                  checked={mcpServers.includes(server.name)}
                  onChange={() => {
                    setMcpServers(toggleId(mcpServers, server.name));
                    markDirty();
                  }}
                />
                <span className="font-mono text-zinc-800">{server.name}</span>
                <span className="text-xs text-zinc-400">{server.transport}</span>
                {!server.enabled && (
                  <span className="rounded border border-amber-200 bg-amber-50 px-1 text-[11px] text-amber-700">
                    全局已停用，勾选也不生效
                  </span>
                )}
              </label>
            ))}
            {unregisteredMcp.map((serverName) => (
              <label
                key={serverName}
                className="flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 text-sm hover:bg-zinc-50"
              >
                <input
                  type="checkbox"
                  checked
                  onChange={() => {
                    setMcpServers(toggleId(mcpServers, serverName));
                    markDirty();
                  }}
                />
                <span className="font-mono text-zinc-800">{serverName}</span>
                <span className="rounded border border-zinc-200 bg-zinc-50 px-1 text-[11px] text-zinc-500">
                  登记表里没有这个名字，受理时会被忽略
                </span>
              </label>
            ))}
          </div>
        )}
      </Section>

      {/* 技能集 */}
      <Section
        title={`技能集（${skillIds.length}）`}
        hint="勾选的技能物化进运行工作区，本工作流每个 Action 都看得见名字与描述、由模型自行决定加载；Action 只能从这里选预载。估算是预载时整段 SKILL.md 正文进入会话首条消息的 token 量。"
        action={
          <Link
            href="/skills"
            className="text-xs text-zinc-500 underline decoration-dotted underline-offset-2 hover:text-zinc-900"
          >
            打开 Skill 库
          </Link>
        }
      >
        {skills.length === 0 ? (
          <Empty>（Skill 库为空）</Empty>
        ) : (
          <div className="space-y-0.5 rounded-md border border-zinc-200 p-2">
            {skills.map((skill) => {
              const users = preloadedBy.get(skill.id);
              return (
                <SetItem
                  key={skill.id}
                  checked={skillIds.includes(skill.id)}
                  onToggle={() => {
                    setSkillIds(toggleId(skillIds, skill.id));
                    markDirty();
                  }}
                  name={skill.name}
                  description={skill.description}
                  tokens={skillTokenEstimate(skill)}
                  tokensHint="预载时进入会话首条消息的估算"
                  badge={
                    users && users.length > 0
                      ? skillIds.includes(skill.id)
                        ? `被 Action「${users.join("」「")}」预载，移出后保存会被拒绝`
                        : `被 Action「${users.join("」「")}」预载但不在技能集里：勾上它，或去改 Action`
                      : null
                  }
                />
              );
            })}
          </div>
        )}
      </Section>

      {/* Tool 集 */}
      <Section
        title={`Tool 集（${toolIds.length}）`}
        hint="勾选的 Tool 全部物化进运行，但只对勾选了它的 Action 可见；Action 只能从这里选可见 Tool。估算是公名、描述与参数 schema 进入每个可见会话工具清单的 token 量。"
        action={
          <Link
            href="/tools"
            className="text-xs text-zinc-500 underline decoration-dotted underline-offset-2 hover:text-zinc-900"
          >
            打开 Tool 库
          </Link>
        }
      >
        {tools.length === 0 ? (
          <Empty>（Tool 库为空）</Empty>
        ) : (
          <div className="space-y-0.5 rounded-md border border-zinc-200 p-2">
            {tools.map((tool) => {
              const users = visibleTo.get(tool.id);
              return (
                <SetItem
                  key={tool.id}
                  checked={toolIds.includes(tool.id)}
                  onToggle={() => {
                    setToolIds(toggleId(toolIds, tool.id));
                    markDirty();
                  }}
                  name={tool.name}
                  code={tool.publicName}
                  description={tool.description}
                  tokens={toolTokenEstimate(tool)}
                  tokensHint="进入每个可见会话工具清单的估算"
                  badge={
                    users && users.length > 0
                      ? toolIds.includes(tool.id)
                        ? `Action「${users.join("」「")}」可见，移出后保存会被拒绝`
                        : `Action「${users.join("」「")}」可见但不在 Tool 集里：勾上它，或去改 Action`
                      : null
                  }
                />
              );
            })}
          </div>
        )}
      </Section>

      <div className="sticky bottom-0 mt-6 flex items-center gap-3 border-t border-zinc-200 bg-white/90 py-3 backdrop-blur">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm text-white hover:bg-zinc-700 disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存设置"}
        </button>
        <span className={`text-xs ${dirty ? "text-amber-600" : "text-zinc-400"}`}>
          {saving
            ? "保存中…"
            : dirty
              ? "有未保存的改动"
              : savedAt
                ? `已保存 ${savedAt.toLocaleTimeString("zh-CN", { hour12: false })}`
                : "已同步"}
        </span>
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}

function ToggleRow({
  toggleKey,
  choice,
  globalValue,
  effectiveValue,
  onChange,
}: {
  toggleKey: CompositionToggleKey;
  choice: ToggleChoice;
  globalValue: boolean;
  effectiveValue: boolean;
  onChange: (choice: ToggleChoice) => void;
}) {
  const meta = COMPOSITION_TOGGLE_LABELS[toggleKey];
  return (
    <tr className="border-t border-zinc-100 align-top">
      <td className="px-3 py-2">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-zinc-800">{meta.label}</span>
          <span className="font-mono text-[11px] text-zinc-400">{toggleKey}</span>
        </div>
        <p className="mt-0.5 text-xs leading-5 text-zinc-500">{meta.hint}</p>
      </td>
      <td className="px-3 py-2">
        <select
          value={choice}
          onChange={(e) => onChange(e.target.value as ToggleChoice)}
          data-testid={`toggle-${toggleKey}`}
          className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm focus:border-zinc-500 focus:outline-none"
        >
          <option value="inherit">继承全局（{globalValue ? "开" : "关"}）</option>
          <option value="on">开</option>
          <option value="off">关</option>
        </select>
      </td>
      <td className="px-3 py-2">
        <span
          className={`rounded border px-1.5 py-0.5 text-xs ${
            effectiveValue
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-zinc-200 bg-zinc-50 text-zinc-500"
          }`}
        >
          {effectiveValue ? "开" : "关"}
        </span>
      </td>
    </tr>
  );
}

function SetItem({
  checked,
  onToggle,
  name,
  code,
  description,
  tokens,
  tokensHint,
  badge,
}: {
  checked: boolean;
  onToggle: () => void;
  name: string;
  /** Tool 的公名（模型看见的名字） */
  code?: string;
  description: string;
  tokens: number;
  tokensHint: string;
  /** 画布上哪些 Action 正预载 / 看见它 */
  badge: string | null;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded px-2 py-1.5 hover:bg-zinc-50">
      <input type="checkbox" checked={checked} onChange={onToggle} className="mt-1" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm text-zinc-800">{name}</span>
          {code && <span className="font-mono text-xs text-zinc-500">{code}</span>}
          <span className="font-mono text-[11px] text-zinc-400" title={tokensHint}>
            ≈ {tokens.toLocaleString("zh-CN")} tokens
          </span>
          {badge && (
            <span className="rounded border border-sky-200 bg-sky-50 px-1 text-[11px] text-sky-700">
              {badge}
            </span>
          )}
        </span>
        {description && (
          <span className="mt-0.5 block text-xs leading-5 text-zinc-500">{description}</span>
        )}
      </span>
    </label>
  );
}

function Section({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-zinc-800">{title}</h2>
          {hint && <p className="mt-0.5 text-xs leading-5 text-zinc-500">{hint}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-zinc-300 px-3 py-2 text-xs text-zinc-400">
      {children}
    </p>
  );
}
