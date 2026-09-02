"use client";

/**
 * 运行详情的「设置快照」折叠区：受理时冻结进 runs.settings_snapshot 的三层设置
 * （ADR-0016）——生效开关及其来源、生效的 MCP、工作流的技能集与 Tool 集、全局默认停用的工具，
 * 以及两份指令的 sha256（正文落在运行目录，这里只给摘要）。它回答「那次为什么有 web_search」；
 * 改全局或工作流设置只影响下一次运行。
 */
import { useState } from "react";
import {
  COMPOSITION_TOGGLE_KEYS,
  type CompositionToggles,
  type RunSettingsSnapshot,
} from "@/lib/workflow-settings";
import { COMPOSITION_TOGGLE_LABELS } from "@/lib/workflow-settings";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asToggles(value: unknown): CompositionToggles {
  const raw = asRecord(value);
  const result = {} as CompositionToggles;
  for (const key of COMPOSITION_TOGGLE_KEYS) result[key] = raw[key] === true;
  return result;
}

function asOverrides(value: unknown): Partial<CompositionToggles> {
  const raw = asRecord(value);
  const result: Partial<CompositionToggles> = {};
  for (const key of COMPOSITION_TOGGLE_KEYS) {
    if (typeof raw[key] === "boolean") result[key] = raw[key] as boolean;
  }
  return result;
}

/** 宽松解析 runs.settings_snapshot：三层任一缺失就当没有快照（早于三层设置的运行为 null） */
export function asRunSettingsSnapshot(value: unknown): RunSettingsSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  if (!o.global || !o.workflow || !o.effective) return null;
  const global = asRecord(o.global);
  const workflow = asRecord(o.workflow);
  const workflowSettings = asRecord(workflow.settings);
  const effective = asRecord(o.effective);
  return {
    global: {
      toggles: asToggles(global.toggles),
      mcpServers: asStrings(global.mcpServers),
      disabledTools: asStrings(global.disabledTools),
      defaultInstructionsSha256: str(global.defaultInstructionsSha256),
    },
    workflow: {
      settings: {
        toggles: asOverrides(workflowSettings.toggles),
        mcpServers: asStrings(workflowSettings.mcpServers),
      },
      instructionsSha256: str(workflow.instructionsSha256),
      skills: (Array.isArray(workflow.skills) ? workflow.skills : []).map((item) => {
        const s = asRecord(item);
        return { id: str(s.id), name: str(s.name), slug: str(s.slug) };
      }),
      tools: (Array.isArray(workflow.tools) ? workflow.tools : []).map((item) => {
        const t = asRecord(item);
        return { id: str(t.id), name: str(t.name), publicName: str(t.publicName) };
      }),
    },
    effective: {
      toggles: asToggles(effective.toggles),
      mcpServers: asStrings(effective.mcpServers),
    },
  };
}

function Chips({
  items,
  empty = "（无）",
}: {
  items: Array<{ key: string; label: string; code?: string; muted?: boolean }>;
  empty?: string;
}) {
  if (items.length === 0) return <span className="text-xs text-zinc-400">{empty}</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span
          key={item.key}
          className={`inline-flex items-baseline gap-1 rounded border px-1.5 py-0.5 text-xs ${
            item.muted
              ? "border-dashed border-zinc-200 bg-white text-zinc-400"
              : "border-zinc-200 bg-white text-zinc-700"
          }`}
        >
          {item.label}
          {item.code && <span className="font-mono text-[11px] text-zinc-400">{item.code}</span>}
        </span>
      ))}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 text-sm">
      <dt className="text-xs leading-5 text-zinc-400">{label}</dt>
      <dd className="min-w-0 leading-5">{children}</dd>
    </div>
  );
}

const short = (sha: string) => (sha ? sha.slice(0, 12) : "—");

export function SettingsSnapshotView({ snapshot }: { snapshot: unknown }) {
  const [open, setOpen] = useState(false);
  const snap = asRunSettingsSnapshot(snapshot);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-5 py-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-sm text-zinc-700 transition-colors hover:text-zinc-900"
      >
        <span
          className="inline-block text-xs transition-transform duration-150"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ▸
        </span>
        <span className="font-medium">设置快照</span>
        <span className="text-xs text-zinc-400">
          {snap
            ? `生效 ${COMPOSITION_TOGGLE_KEYS.filter((k) => snap.effective.toggles[k]).length}/${COMPOSITION_TOGGLE_KEYS.length} 项开关 · MCP ${snap.effective.mcpServers.length} · 技能集 ${snap.workflow.skills.length} · Tool 集 ${snap.workflow.tools.length}`
            : "本次运行没有记录设置快照"}
        </span>
      </button>

      {open && !snap && (
        <p className="mt-2 text-xs text-zinc-400">
          受理时没有写入 runs.settings_snapshot；早于三层设置的运行没有这份记录。
        </p>
      )}

      {open && snap && (
        <div className="mt-3 space-y-4 border-t border-zinc-100 pt-3">
          <p className="text-xs text-zinc-400">
            受理时冻结的三层设置：全局给默认值，工作流只覆盖写了的键；改设置只影响下一次运行。
          </p>

          <div>
            <div className="mb-1.5 text-xs font-medium text-zinc-400">插件开关</div>
            <div className="overflow-hidden rounded-md border border-zinc-200">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">开关</th>
                    <th className="w-16 px-3 py-1.5 font-medium">生效</th>
                    <th className="w-40 px-3 py-1.5 font-medium">来源</th>
                  </tr>
                </thead>
                <tbody>
                  {COMPOSITION_TOGGLE_KEYS.map((key) => {
                    const override = snap.workflow.settings.toggles[key];
                    const on = snap.effective.toggles[key];
                    return (
                      <tr key={key} className="border-t border-zinc-100">
                        <td className="px-3 py-1.5">
                          <span className="text-zinc-800">{COMPOSITION_TOGGLE_LABELS[key].label}</span>
                          <span className="ml-2 font-mono text-[11px] text-zinc-400">{key}</span>
                        </td>
                        <td className="px-3 py-1.5">
                          <span
                            className={`rounded border px-1.5 py-0.5 text-xs ${
                              on
                                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                : "border-zinc-200 bg-zinc-50 text-zinc-500"
                            }`}
                          >
                            {on ? "开" : "关"}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-xs text-zinc-500">
                          {override === undefined
                            ? `全局默认（${snap.global.toggles[key] ? "开" : "关"}）`
                            : `工作流覆盖为${override ? "开" : "关"}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <dl className="space-y-2">
            <Row label="生效的 MCP">
              <Chips
                items={snap.effective.mcpServers.map((name) => ({ key: name, label: name }))}
                empty="（无：没有既全局启用又在工作流子集里的服务器）"
              />
              <p className="mt-1 text-xs text-zinc-400">
                全局启用：{snap.global.mcpServers.join("、") || "无"} · 工作流子集：
                {snap.workflow.settings.mcpServers.join("、") || "无"}
              </p>
            </Row>
            <Row label="技能集">
              <Chips
                items={snap.workflow.skills.map((skill) => ({
                  key: skill.id || skill.slug,
                  label: skill.name || skill.slug,
                  code: skill.slug,
                }))}
              />
            </Row>
            <Row label="Tool 集">
              <Chips
                items={snap.workflow.tools.map((tool) => ({
                  key: tool.id || tool.publicName,
                  label: tool.name || tool.publicName,
                  code: tool.publicName,
                }))}
              />
            </Row>
            <Row label="默认停用工具">
              <Chips
                items={snap.global.disabledTools.map((name) => ({
                  key: name,
                  label: name,
                  muted: true,
                }))}
              />
            </Row>
            <Row label="指令摘要">
              <span className="font-mono text-xs text-zinc-600">
                工作流 AGENTS.md {short(snap.workflow.instructionsSha256)} · 默认指令 {short(snap.global.defaultInstructionsSha256)}
              </span>
              <p className="mt-0.5 text-xs text-zinc-400">
                正文分别落在运行目录的 workspace/AGENTS.md 与 home/AGENTS.md，这里只记 sha256 前 12 位。
              </p>
            </Row>
          </dl>
        </div>
      )}
    </div>
  );
}
