"use client";

import { useState } from "react";
import { asRunSnapshot, type RunSnapshotPortView } from "../lib";

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

/** 单个 Skill / Tool：默认折叠，展开显示全文（等宽） */
function FullTextItem({ name, text }: { name: string; text: string }) {
  return (
    <details className="rounded-md border border-zinc-200 bg-white">
      <summary className="cursor-pointer list-none px-3 py-2 text-xs text-zinc-600 transition-colors hover:bg-zinc-50">
        <span className="font-mono font-medium text-zinc-800">
          {name || "（未命名）"}
        </span>
        <span className="ml-2 text-zinc-400">{text.length} 字 · 点击展开</span>
      </summary>
      <div className="px-3 pt-1 pb-3">
        <pre className={PRE_CLS}>{text}</pre>
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
 * （prompt / rule / skills / tools / model / effort 全文），等宽字体、可折叠。
 */
export function SnapshotView({ snapshot }: { snapshot: unknown }) {
  const [open, setOpen] = useState(false);
  const snap = asRunSnapshot(snapshot);
  if (!snap) return null;

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
              <dd className="mt-0.5 font-mono text-xs text-zinc-700">
                {snap.model || "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-400">思考强度</dt>
              <dd className="mt-0.5 font-mono text-xs text-zinc-700">
                {snap.reasoningEffort || "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-400">Skill / Tool 数</dt>
              <dd className="mt-0.5 text-zinc-700">
                {snap.skills.length} / {snap.tools.length}
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

          <div>
            <div className="mb-1.5 text-xs font-medium text-zinc-400">
              Skill 全文（{snap.skills.length}）
            </div>
            {snap.skills.length === 0 ? (
              <div className="text-xs text-zinc-400">（无）</div>
            ) : (
              <div className="space-y-1.5">
                {snap.skills.map((s, i) => (
                  <FullTextItem
                    key={`${s.name}-${i}`}
                    name={s.name}
                    text={s.content}
                  />
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="mb-1.5 text-xs font-medium text-zinc-400">
              Tool 源码（{snap.tools.length}）
            </div>
            {snap.tools.length === 0 ? (
              <div className="text-xs text-zinc-400">（无）</div>
            ) : (
              <div className="space-y-1.5">
                {snap.tools.map((t, i) => (
                  <FullTextItem
                    key={`${t.name}-${i}`}
                    name={t.name}
                    text={t.code}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
