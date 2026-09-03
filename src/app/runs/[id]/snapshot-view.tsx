"use client";

import { useState } from "react";
import { asRunSnapshot, type RunSnapshotPortView, type RunSnapshotSkillView } from "../lib";

const PRE_CLS =
  "max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-zinc-50 p-2.5 font-mono text-xs leading-5 text-zinc-700";

function Field({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-zinc-400">{label}</div>
      {text ? (
        <pre className={PRE_CLS}>{text}</pre>
      ) : (
        <div className="text-xs text-zinc-400">（空）</div>
      )}
    </div>
  );
}

/** 技能集里的一项：默认折叠，展开显示会话启动前读到的 SKILL.md 全文；预载的带标记 */
function SkillItem({ skill }: { skill: RunSnapshotSkillView }) {
  return (
    <details className="rounded-md border border-zinc-200 bg-white">
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-2 px-3 py-2 text-xs text-zinc-600 transition-colors hover:bg-zinc-50">
        <span className="font-medium text-zinc-800">{skill.name || "（未命名）"}</span>
        {skill.slug && <span className="font-mono text-[11px] text-zinc-400">/{skill.slug}</span>}
        {skill.preloaded && (
          <span
            title="会话开始时以 /技能 注入，等同于在命令行敲斜杠命令"
            className="rounded border border-sky-200 bg-sky-50 px-1 text-[11px] text-sky-700"
          >
            预载
          </span>
        )}
        <span className="text-zinc-400">{skill.content.length} 字 · 点击展开</span>
      </summary>
      <div className="px-3 pt-1 pb-3">
        {skill.content ? (
          <pre className={PRE_CLS}>{skill.content}</pre>
        ) : (
          <div className="text-xs text-zinc-400">（会话启动前没有读到投影正文）</div>
        )}
      </div>
    </details>
  );
}

function PortLine({ ports }: { ports: RunSnapshotPortView[] }) {
  if (ports.length === 0) return <span className="text-zinc-400">（无）</span>;
  return (
    <span className="font-mono text-xs text-zinc-600">
      {ports
        .map((p) => `${p.name}: ${p.objectTypeName}${p.kind ? `（${p.kind}）` : ""}`)
        .join("， ")}
    </span>
  );
}

/**
 * 运行快照面板：展开后显示该节点本次执行实际使用的完整配置
 * （prompt / rule / 实际发送的提示 / 工作流技能集与预载标记 / Tool 集与可见标记 /
 * model / effort），等宽字体、可折叠。Tool 的定义在受理时冻结进 run_results 之外的
 * 运行目录 plugins/，快照只记公名与可见性。
 */
export function SnapshotView({ snapshot }: { snapshot: unknown }) {
  const [open, setOpen] = useState(false);
  const snap = asRunSnapshot(snapshot);
  if (!snap) return null;

  const preloaded = snap.skills.filter((s) => s.preloaded).length;
  const visible = snap.tools.filter((t) => t.visible).length;

  return (
    <div className="mt-3 border-t border-zinc-100 pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-xs text-zinc-500 transition-colors hover:text-zinc-900"
      >
        <span
          className="inline-block transition-transform duration-150"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ▸
        </span>
        {open ? "收起运行快照" : "查看运行快照"}
      </button>

      {open && (
        <div className="mt-3 space-y-4 rounded-md border border-zinc-200 bg-zinc-50/60 p-4">
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-zinc-400">Action</dt>
              <dd className="mt-0.5 text-zinc-700">{snap.actionName || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-400">模型</dt>
              <dd className="mt-0.5 font-mono text-xs text-zinc-700">{snap.model || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-400">思考强度</dt>
              <dd className="mt-0.5 font-mono text-xs text-zinc-700">
                {snap.reasoningEffort || "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-400">预载 / 可见 Tool</dt>
              <dd className="mt-0.5 text-zinc-700">
                {preloaded}/{snap.skills.length} · {visible}/{snap.tools.length}
              </dd>
            </div>
          </dl>

          <div className="space-y-1 text-xs">
            <div>
              <span className="text-zinc-400">输入端口：</span>
              <PortLine ports={snap.inputs} />
            </div>
            <div>
              <span className="text-zinc-400">输出端口：</span>
              <PortLine ports={snap.outputs} />
            </div>
          </div>

          <Field label="任务描述（prompt）" text={snap.prompt} />
          <Field label="规则（rule）" text={snap.rule} />
          <Field label="实际发送的提示（renderedPrompt）" text={snap.renderedPrompt} />

          <div>
            <div className="mb-1.5 text-xs font-medium text-zinc-400">
              工作流技能集（{snap.skills.length}，预载 {preloaded}）
            </div>
            {snap.skills.length === 0 ? (
              <div className="text-xs text-zinc-400">（无）</div>
            ) : (
              <div className="space-y-1.5">
                {snap.skills.map((skill, i) => (
                  <SkillItem key={`${skill.id || skill.slug}-${i}`} skill={skill} />
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="mb-1.5 text-xs font-medium text-zinc-400">
              工作流 Tool 集（{snap.tools.length}，本 Action 可见 {visible}）
            </div>
            {snap.tools.length === 0 ? (
              <div className="text-xs text-zinc-400">（无）</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {snap.tools.map((tool, i) => (
                  <span
                    key={`${tool.name}-${i}`}
                    title={
                      tool.visible
                        ? "本 Action 会话看得见这个工具"
                        : "在工作流 Tool 集里，但本 Action 未勾选，会话看不见"
                    }
                    className={`inline-flex items-baseline gap-1 rounded border px-1.5 py-0.5 font-mono text-xs ${
                      tool.visible
                        ? "border-zinc-200 bg-white text-zinc-700"
                        : "border-dashed border-zinc-200 bg-white text-zinc-400 line-through"
                    }`}
                  >
                    {tool.name || "（未命名）"}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
