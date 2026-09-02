"use client";

/**
 * 全局设置（开发者面）：模型凭据、凭据引用登记、MCP 服务器、默认停用的工具、
 * 可切换插件的全局默认值、默认指令，外加一个插件面板——三层设置的最上层
 * （ADR-0016）：工作流设置只在允许切换的范围内覆盖这里的开关与 MCP 子集。
 *
 * 设置在**下一次运行**生效：运行启动时读一次并冻结，在跑的运行不受影响
 * （与运行快照同一条纪律）。
 *
 * 凭据只登记名字。值留在本机环境里，运行启动时按白名单挑出注入子进程，
 * 不进设置文档、不进组合配置、不进日志（ADR-0006）。
 *
 * 插件面板按 src/server/harness/catalog.ts 的十组分区展示；客户端不能从 @/server
 * 导入值，目录经 /api/settings/composition 投影过来，每行的挂载状态由服务端按
 * 当前全局设置推导（ADR-0013），不含任何工作流的覆盖。
 */
import { useCallback, useEffect, useState } from "react";
import {
  COMPOSITION_TOGGLE_KEYS,
  type CompositionToggleKey,
  type CompositionToggles,
  DEFAULT_COMPOSITION_TOGGLES,
  estimateTokens,
  DEFAULT_INSTRUCTIONS_MAX_BYTES,
} from "@/lib/workflow-settings";

interface CredentialRef {
  name: string;
  purpose: string;
}

interface McpServer {
  name: string;
  enabled: boolean;
  transport: "stdio" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
}

interface SettingsDoc {
  modelApiKeyEnv: string;
  modelBaseUrl: string;
  credentialRefs: CredentialRef[];
  mcpServers: McpServer[];
  disabledTools: string[];
  toggles: CompositionToggles;
  defaultInstructions: string;
}

interface CompositionEntry {
  id: string;
  name: string;
}

interface PluginCustomization {
  kind: "配置" | "包装" | "fork";
  what: string;
  why: string;
  upstream?: { path: string; version: string };
}

interface PluginRow {
  package: string;
  decision: "必挂" | "挂" | "不挂" | "待定" | "备选" | "自有";
  entryId: string | null;
  mounted: "会挂载" | "按运行生成" | "按开关未挂" | "按开关已挂" | "不挂" | "备选" | "库" | "自有";
  workflowToggle: boolean;
  reason: string;
  customization: PluginCustomization | null;
}

interface PluginGroup {
  id: number;
  title: string;
  defaultStance: string;
  rows: PluginRow[];
}

const EMPTY: SettingsDoc = {
  modelApiKeyEnv: "DEEPSEEK_API_KEY",
  modelBaseUrl: "",
  credentialRefs: [],
  mcpServers: [],
  disabledTools: [],
  toggles: { ...DEFAULT_COMPOSITION_TOGGLES },
  defaultInstructions: "",
};


/**
 * 五个可按工作流切换的插件开关的文案；键顺序与 COMPOSITION_TOGGLE_KEYS 一致，
 * 每个开关控制 catalog.ts 里带同名 `toggle` 字段的那些行。
 */
const TOGGLE_COPY: Record<CompositionToggleKey, { label: string; hint: string }> = {
  webSearch: {
    label: "DeepSeek 搜索（web_search）",
    hint: "挂 web / web-search-deepseek / tool-web 三行，模型多一个 web_search 工具，用与模型同一把凭据引用名。DeepSeek 搜索的费用不计入本站用量：搜索是一次独立的辅助模型请求，用量不经 llm/stream，本站的 node_usage 与成本页收不到它，是账外支出。",
  },
  fsSearch: {
    label: "文件搜索（glob / grep）",
    hint: "tool-fs-search：包内 ripgrep、不经 shell，模型按模式找文件、按正则搜内容。",
  },
  strReplaceEditor: {
    label: "结构化编辑器（str_replace_editor）",
    hint: "tool-str-replace-editor：view / create / str_replace / insert，对文件做定点替换而不是整份重写；与 edit 并存。",
  },
  todo: {
    label: "待办清单（todo_write）",
    hint: "tool-todo：模型的自我组织工具，事件进会话日志。",
  },
  compaction: {
    label: "上下文压缩",
    hint: "token-meter / compaction-basic / tool-result-pruner 三行同进同出：上下文压力到阈值时先剪枝旧工具结果再摘要历史；关掉后长会话会撞上下文上限。",
  },
};

/** 组 1–4 与组 10 影响模型怎么干活，默认展开；组 5–9 默认不挂，折叠只露组名与方向。 */
const OPEN_GROUPS = new Set([1, 2, 3, 4, 10]);

const MOUNTED_CLASS: Record<PluginRow["mounted"], string> = {
  会挂载: "text-emerald-600",
  按运行生成: "text-zinc-500",
  自有: "text-violet-600",
  按开关已挂: "text-emerald-600",
  按开关未挂: "text-amber-600",
  不挂: "text-zinc-400",
  备选: "text-sky-600",
  库: "text-zinc-500",
};

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (typeof data.error === "string") return data.error;
  } catch {
    // 响应体不是 JSON
  }
  return `请求失败（HTTP ${res.status}）`;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export default function SettingsPage() {
  const [doc, setDoc] = useState<SettingsDoc>(EMPTY);
  const [entries, setEntries] = useState<CompositionEntry[]>([]);
  const [disabledEntries, setDisabledEntries] = useState<CompositionEntry[]>([]);
  const [groups, setGroups] = useState<PluginGroup[]>([]);
  const [lastYaml, setLastYaml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadComposition = useCallback(async () => {
    const res = await fetch("/api/settings/composition", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as {
      entries: CompositionEntry[];
      disabledEntries: CompositionEntry[];
      groups: PluginGroup[];
      lastComposition: { runId: string; yaml: string } | null;
    };
    setEntries(data.entries);
    setDisabledEntries(data.disabledEntries);
    setGroups(data.groups);
    setLastYaml(data.lastComposition?.yaml ?? null);
  }, []);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/settings", { cache: "no-store" });
      if (res.ok) setDoc((await res.json()) as SettingsDoc);
      await loadComposition();
    })();
  }, [loadComposition]);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(doc),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setDoc((await res.json()) as SettingsDoc);
      setSaved(new Date().toLocaleTimeString("zh-CN"));
      await loadComposition();
    } finally {
      setBusy(false);
    }
  }

  const patch = (next: Partial<SettingsDoc>) => setDoc((d) => ({ ...d, ...next }));
  const instructionBytes = utf8Bytes(doc.defaultInstructions);
  const instructionsTooLong = instructionBytes > DEFAULT_INSTRUCTIONS_MAX_BYTES;

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <h1 className="text-xl font-semibold text-zinc-900">全局设置</h1>
      <p className="mt-1 text-sm text-zinc-500">
        这一层是所有工作流共享的引擎基线：工作流设置只在下面标为「可按工作流切换」的范围内覆盖它，
        Action 从不开关插件。改动在<b>下一次运行</b>生效——运行启动时读一次并冻结，在跑的运行不受影响。
      </p>

      {error && (
        <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <Section title="模型与凭据" hint="凭据只登记名字；值留在本机环境变量里，运行启动时才注入子进程。">
        <Field label="模型凭据引用名">
          <input
            value={doc.modelApiKeyEnv}
            onChange={(e) => patch({ modelApiKeyEnv: e.target.value })}
            className="w-72 rounded-md border border-zinc-300 px-3 py-1.5 font-mono text-sm focus:border-zinc-500 focus:outline-none"
          />
        </Field>
        <Field label="端点覆盖" hint="留空走 DeepSeek 官方">
          <input
            value={doc.modelBaseUrl}
            onChange={(e) => patch({ modelBaseUrl: e.target.value })}
            placeholder="https://api.deepseek.com"
            className="w-full rounded-md border border-zinc-300 px-3 py-1.5 font-mono text-sm focus:border-zinc-500 focus:outline-none"
          />
        </Field>
      </Section>

      <Section
        title="凭据引用"
        hint="登记的名字构成运行子进程的环境白名单——只有列在这里的变量会被带进去；Tool 的 execute 模块经 ctx.env 拿到的也只有它们。"
        onAdd={() =>
          patch({ credentialRefs: [...doc.credentialRefs, { name: "", purpose: "" }] })
        }
      >
        {doc.credentialRefs.length === 0 ? (
          <Empty>（还没有登记任何凭据引用）</Empty>
        ) : (
          doc.credentialRefs.map((ref, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={ref.name}
                onChange={(e) => {
                  const next = [...doc.credentialRefs];
                  next[i] = { ...ref, name: e.target.value };
                  patch({ credentialRefs: next });
                }}
                placeholder="ENV_NAME"
                className="w-56 rounded-md border border-zinc-300 px-3 py-1.5 font-mono text-sm focus:border-zinc-500 focus:outline-none"
              />
              <input
                value={ref.purpose}
                onChange={(e) => {
                  const next = [...doc.credentialRefs];
                  next[i] = { ...ref, purpose: e.target.value };
                  patch({ credentialRefs: next });
                }}
                placeholder="用途"
                className="flex-1 rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-zinc-500 focus:outline-none"
              />
              <RemoveButton
                onClick={() =>
                  patch({ credentialRefs: doc.credentialRefs.filter((_, x) => x !== i) })
                }
              />
            </div>
          ))
        )}
      </Section>

      <Section
        title="MCP 服务器"
        hint="这里是登记表：启用的服务器是候选，工作流设置再从中勾选自己要用的子集，只有两边都选中的才进入那次运行的组合。env 里不接受凭据形键名——组合配置会原样落盘。"
        onAdd={() =>
          patch({
            mcpServers: [
              ...doc.mcpServers,
              { name: "", enabled: true, transport: "stdio", command: "", args: [] },
            ],
          })
        }
      >
        {doc.mcpServers.length === 0 ? (
          <Empty>（还没有登记任何 MCP 服务器）</Empty>
        ) : (
          doc.mcpServers.map((server, i) => {
            const update = (next: Partial<McpServer>) => {
              const list = [...doc.mcpServers];
              list[i] = { ...server, ...next };
              patch({ mcpServers: list });
            };
            return (
              <div key={i} className="space-y-2 rounded-md border border-zinc-200 p-3">
                <div className="flex items-center gap-2">
                  <input
                    value={server.name}
                    onChange={(e) => update({ name: e.target.value })}
                    placeholder="服务器名"
                    className="w-48 rounded-md border border-zinc-300 px-3 py-1.5 font-mono text-sm focus:border-zinc-500 focus:outline-none"
                  />
                  <select
                    value={server.transport}
                    onChange={(e) =>
                      update({ transport: e.target.value as McpServer["transport"] })
                    }
                    className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:border-zinc-500 focus:outline-none"
                  >
                    <option value="stdio">stdio</option>
                    <option value="streamable-http">streamable-http</option>
                  </select>
                  <label className="flex items-center gap-1.5 text-sm text-zinc-600">
                    <input
                      type="checkbox"
                      checked={server.enabled}
                      onChange={(e) => update({ enabled: e.target.checked })}
                    />
                    启用
                  </label>
                  <span className="flex-1" />
                  <RemoveButton
                    onClick={() =>
                      patch({ mcpServers: doc.mcpServers.filter((_, x) => x !== i) })
                    }
                  />
                </div>
                {server.transport === "stdio" ? (
                  <div className="flex items-center gap-2">
                    <input
                      value={server.command ?? ""}
                      onChange={(e) => update({ command: e.target.value })}
                      placeholder="命令，如 npx"
                      className="w-48 rounded-md border border-zinc-300 px-3 py-1.5 font-mono text-sm focus:border-zinc-500 focus:outline-none"
                    />
                    <input
                      value={(server.args ?? []).join(" ")}
                      onChange={(e) =>
                        update({ args: e.target.value.split(/\s+/).filter(Boolean) })
                      }
                      placeholder="参数，空格分隔"
                      className="flex-1 rounded-md border border-zinc-300 px-3 py-1.5 font-mono text-sm focus:border-zinc-500 focus:outline-none"
                    />
                  </div>
                ) : (
                  <input
                    value={server.url ?? ""}
                    onChange={(e) => update({ url: e.target.value })}
                    placeholder="https://…/mcp"
                    className="w-full rounded-md border border-zinc-300 px-3 py-1.5 font-mono text-sm focus:border-zinc-500 focus:outline-none"
                  />
                )}
              </div>
            );
          })
        )}
      </Section>

      <Section title="默认停用的工具" hint="按工具公名逐行写；对每次运行的每个 Action 会话都从工具清单里拿掉，模型看不见它。">
        <textarea
          value={doc.disabledTools.join("\n")}
          onChange={(e) =>
            patch({
              disabledTools: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
            })
          }
          rows={3}
          placeholder="bash"
          className="w-full rounded-md border border-zinc-300 px-3 py-1.5 font-mono text-sm focus:border-zinc-500 focus:outline-none"
        />
      </Section>

      <Section
        title="插件开关"
        hint="可按工作流切换的五组插件的全局默认值。工作流设置里每一项可以选「继承」「开」「关」；没写覆盖的工作流按这里的值挂。"
      >
        {COMPOSITION_TOGGLE_KEYS.map((key) => (
          <label
            key={key}
            data-toggle-key={key}
            className="flex items-start gap-3 rounded-md border border-zinc-200 px-3 py-2"
          >
            <input
              type="checkbox"
              checked={doc.toggles[key]}
              onChange={(e) =>
                patch({ toggles: { ...doc.toggles, [key]: e.target.checked } })
              }
              className="mt-1"
            />
            <span className="min-w-0">
              <span className="block text-sm text-zinc-800">
                {TOGGLE_COPY[key].label}
                <span className="ml-2 font-mono text-[11px] text-zinc-400">{key}</span>
              </span>
              <span className="mt-0.5 block text-xs leading-5 text-zinc-500">
                {TOGGLE_COPY[key].hint}
              </span>
            </span>
          </label>
        ))}
      </Section>

      <Section
        title="默认指令（AGENTS.md）"
        hint="物化为每次运行的 <run>/home/AGENTS.md，每个 Action 会话都无条件读到，放跨工作流的共同底线；工作流自己的指令另落工作区 AGENTS.md，在工作流设置里写。留空即不写用户级指令。"
      >
        <textarea
          value={doc.defaultInstructions}
          onChange={(e) => patch({ defaultInstructions: e.target.value })}
          rows={12}
          spellCheck={false}
          aria-label="默认指令"
          className="w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs leading-5 focus:border-zinc-500 focus:outline-none"
        />
        <p className={`text-xs ${instructionsTooLong ? "text-red-600" : "text-zinc-400"}`}>
          约 {estimateTokens(doc.defaultInstructions)} token / 会话，{instructionBytes} 字节
          {instructionsTooLong
            ? `——超过 ${DEFAULT_INSTRUCTIONS_MAX_BYTES} 字节上限，保存会被拒绝`
            : `（上限 ${DEFAULT_INSTRUCTIONS_MAX_BYTES} 字节）`}
        </p>
      </Section>

      <div className="sticky bottom-0 mt-6 flex items-center gap-3 border-t border-zinc-200 bg-white/90 py-3 backdrop-blur">
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm text-white hover:bg-zinc-700 disabled:opacity-50"
        >
          {busy ? "保存中…" : "保存"}
        </button>
        {saved && <span className="text-xs text-zinc-500">已保存 {saved}</span>}
      </div>

      <Section
        title="插件面板"
        hint="面板读的是 src/server/harness/catalog.ts 那一份插件目录——与 catalog.test.ts 钉住组合、docs/harness/ 钉住文档的是同一份——按十组分区，每行的挂载状态按当前全局设置推导，不含工作流覆盖。本项目没有长驻的 harness 宿主树，每次运行自己起一个子进程，所以这里报的是「下一次运行会挂什么」，以及最近一次运行真实落盘的组合。"
      >
        {groups.map((group) => (
          <details
            key={group.id}
            open={OPEN_GROUPS.has(group.id)}
            data-plugin-group={group.id}
            className="rounded-md border border-zinc-200"
          >
            <summary className="flex cursor-pointer items-baseline gap-3 px-3 py-2 text-sm">
              <span className="font-medium text-zinc-800">
                组 {group.id} · {group.title}
              </span>
              <span className="text-xs text-zinc-500">默认方向：{group.defaultStance}</span>
            </summary>
            <div className="overflow-x-auto border-t border-zinc-100">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">package</th>
                    <th className="px-3 py-1.5 font-medium">决定</th>
                    <th className="px-3 py-1.5 font-medium">挂载</th>
                    <th className="px-3 py-1.5 font-medium">工作流</th>
                    <th className="px-3 py-1.5 font-medium">定制</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row) => (
                    <tr
                      key={row.package}
                      data-plugin-row={row.package}
                      className="border-t border-zinc-100 align-top"
                    >
                      <td className="px-3 py-1.5">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-mono text-xs break-all text-zinc-700">
                            {row.package}
                          </span>
                          {row.entryId && (
                            <span className="rounded bg-zinc-100 px-1 font-mono text-[11px] text-zinc-600">
                              {row.entryId}
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs leading-5 text-zinc-500">{row.reason}</p>
                        {row.customization && (
                          <p className="mt-0.5 text-xs leading-5 text-zinc-500">
                            <span className="text-zinc-400">改了什么：</span>
                            {row.customization.what}
                            <span className="text-zinc-400">　为什么：</span>
                            {row.customization.why}
                            {row.customization.upstream && (
                              <span className="font-mono text-[11px] text-zinc-400">
                                　{row.customization.upstream.path}@
                                {row.customization.upstream.version}
                              </span>
                            )}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-xs whitespace-nowrap text-zinc-700">
                        {row.decision}
                      </td>
                      <td
                        className={`px-3 py-1.5 text-xs whitespace-nowrap ${MOUNTED_CLASS[row.mounted]}`}
                      >
                        {row.mounted}
                      </td>
                      <td className="px-3 py-1.5 text-xs whitespace-nowrap">
                        {row.workflowToggle ? (
                          <span
                            title="单个工作流可以在工作流设置里覆盖这一行的全局默认"
                            className="rounded border border-sky-200 bg-sky-50 px-1 text-sky-700"
                          >
                            可按工作流切换
                          </span>
                        ) : (
                          <span className="text-zinc-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-xs whitespace-nowrap">
                        {row.customization ? (
                          <span
                            title={`改了什么：${row.customization.what}\n为什么：${row.customization.why}`}
                            className="rounded border border-amber-200 bg-amber-50 px-1 text-amber-700"
                          >
                            {row.customization.kind}
                          </span>
                        ) : (
                          <span className="text-zinc-300">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ))}

        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-zinc-500">
            下一次运行的组合 entry 清单（按组合顺序，含登记的 MCP 服务器）
          </summary>
          <div className="mt-2 overflow-hidden rounded-md border border-zinc-200">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
                <tr>
                  <th className="px-3 py-1.5 font-medium">entry id</th>
                  <th className="px-3 py-1.5 font-medium">插件</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} className="border-t border-zinc-100">
                    <td className="px-3 py-1.5 font-mono text-xs text-zinc-700">{entry.id}</td>
                    <td className="px-3 py-1.5 font-mono text-xs break-all text-zinc-500">
                      {entry.name}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>

        {disabledEntries.length > 0 && (
          <div className="mt-4">
            <h3 className="text-xs font-medium text-zinc-600">已停用的 MCP（不会进入组合）</h3>
            <div className="mt-2 overflow-hidden rounded-md border border-zinc-200">
              <table className="w-full text-sm">
                <tbody>
                  {disabledEntries.map((entry) => (
                    <tr key={entry.id} className="border-t border-zinc-100 first:border-t-0">
                      <td className="px-3 py-1.5 font-mono text-xs text-zinc-700">{entry.id}</td>
                      <td className="px-3 py-1.5 font-mono text-xs break-all text-zinc-500">
                        {entry.name}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-zinc-400">已停用</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {lastYaml && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-zinc-500">
              最近一次运行真实落盘的组合配置
            </summary>
            <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-zinc-900 p-3 font-mono text-[11px] leading-5 text-zinc-200">
              {lastYaml}
            </pre>
          </details>
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  hint,
  onAdd,
  children,
}: {
  title: string;
  hint?: string;
  onAdd?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-zinc-800">{title}</h2>
          {hint && <p className="mt-0.5 text-xs leading-5 text-zinc-500">{hint}</p>}
        </div>
        {onAdd && (
          <button
            onClick={onAdd}
            className="shrink-0 rounded-md border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-50"
          >
            + 添加
          </button>
        )}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-zinc-500">
        {label}
        {hint && <span className="ml-2 text-zinc-400">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-zinc-300 px-3 py-2 text-xs text-zinc-400">
      {children}
    </p>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="shrink-0 rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
    >
      删除
    </button>
  );
}
